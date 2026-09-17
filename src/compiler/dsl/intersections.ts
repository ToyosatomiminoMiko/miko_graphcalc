/**
 * 求交任务编译.
 *
 * 把 `intersection` 语句解析成 `IntersectionTask`:
 * - 编译器不在这里做数值计算,只产出对象引用,颜色,segments;
 * - 数值内核在 Rust `math_rs::intersection_core`,由 IntersectionRenderer
 *   调度到 Worker 异步执行;
 * - 隐藏的求交不进入计算队列(仍保留列表项).
 *
 * 202609 review 结论(hidden 语义,与 analyses/integrals 统一):
 * "隐藏 = 先完整校验,后禁用,仅跳过计算".隐藏求交同样必须通过对象存在/
 * 自交 / kind 支持 / 动画与静态变换可逆性校验,否则照常抛语句级错误;
 * 只是不产出可计算的任务(占位项 aId/bId = -1,enabled = false).
 * 求交名查重 / 选项校验 / 语句级错误定位由 `statementShell.ts` 的
 * `compileConstraintStatements` 统一提供(与求解同一外壳,契约一致).
 */
import type { AstProgram, IntersectionStatement } from '@/contract/ast';
import type { IntersectionTask, SceneObject } from '@/contract/ir';
import { NUMERIC_CONFIG } from '@/config/numericConfig';
import {
    findOption,
    parseCappedPositiveInteger,
    stripQuotes,
} from './options';
import { compileConstraintStatements } from './statementShell';
import { invertMat4, type Mat4 } from '@/math/matrix/rowMajorMatrix';

const INTERSECTION_OPTION_NAMES = ['color', 'segments'] as const;
const SUPPORTED_KINDS = new Set<SceneObject['kind']>([
    'curve',
    'surface',
    'sphere',
    'box',
    'conic',
]);

function objectName(object: SceneObject): string {
    return object.name ?? `#${object.id}`;
}

/**
 * 编译期只检查对象是否带静态可用变换;真正的逆矩阵在构造 Worker 请求时
 * 计算,不在这里重复做数值工作.
 */
function assertObjectFrame(
    object: SceneObject,
    objectTransforms: Record<number, Mat4>,
    objectAnimations: Record<number, string[]>,
    intersectionName: string,
): void {
    if ((objectAnimations[object.id] ?? []).length > 0) {
        throw new Error(
            `求交 ${intersectionName} 引用的对象 ${objectName(object)} 带动画,暂不支持`,
        );
    }

    const matrix = objectTransforms[object.id] ?? null;
    if (matrix && !invertMat4(matrix)) {
        throw new Error(
            `求交 ${intersectionName} 引用的对象 ${objectName(object)} 的变换矩阵不可逆`,
        );
    }
}

/**
 * 编译全部 intersection 语句.
 *
 * 查重 / 选项校验 / 语句级错误定位 / hidden 语义由
 * `compileConstraintStatements` 统一提供(与求解同一外壳).
 */
export function compileIntersections(
    ast: AstProgram,
    objects: Map<string, SceneObject>,
    objectTransforms: Record<number, Mat4>,
    objectAnimations: Record<number, string[]>,
    hiddenNames: ReadonlySet<string> = new Set(),
): IntersectionTask[] {
    return compileConstraintStatements(
        ast,
        (statement): statement is IntersectionStatement =>
            statement.type === 'intersection',
        '求交',
        INTERSECTION_OPTION_NAMES,
        hiddenNames,
        (statement, hidden, index) =>
            compileIntersectionStatement(
                statement,
                objects,
                objectTransforms,
                objectAnimations,
                hidden,
                index,
            ),
    );
}

/**
 * 编译单条 intersection 语句.
 *
 * 语句级错误定位(带语句 span 抛出)已由外壳的 `withStatementSpan` 提供,
 * 这里各条 throw 无需手工携带 `statement.span`.
 */
function compileIntersectionStatement(
    statement: IntersectionStatement,
    objects: Map<string, SceneObject>,
    objectTransforms: Record<number, Mat4>,
    objectAnimations: Record<number, string[]>,
    hidden: boolean,
    colorIndex: number,
): IntersectionTask {
    const name = statement.name;
    const rawColor = findOption(statement.options, 'color');
    const color = rawColor !== undefined
        ? stripQuotes(rawColor)
        : NUMERIC_CONFIG.colorPalette[
            colorIndex % NUMERIC_CONFIG.colorPalette.length
        ];
    const segments =
        parseCappedPositiveInteger(
            findOption(statement.options, 'segments'),
            `求交 ${name} 的 segments`,
            NUMERIC_CONFIG.limits.intersection.maxSegments,
        )
        ?? NUMERIC_CONFIG.intersection.defaultSegments;

    // ---- 完整校验面(先于 hidden 分支,见文件头结论)----
    const a = objects.get(statement.a);
    const b = objects.get(statement.b);
    if (!a) {
        throw new Error(`求交 ${name} 引用了不存在的对象 ${statement.a}`);
    }
    if (!b) {
        throw new Error(`求交 ${name} 引用了不存在的对象 ${statement.b}`);
    }
    if (statement.a === statement.b) {
        throw new Error(`求交 ${name} 的两个对象不能相同`);
    }
    if (!SUPPORTED_KINDS.has(a.kind)) {
        throw new Error(
            `求交 ${name} 不支持 ${a.kind} 类型的对象 ${statement.a}`,
        );
    }
    if (!SUPPORTED_KINDS.has(b.kind)) {
        throw new Error(
            `求交 ${name} 不支持 ${b.kind} 类型的对象 ${statement.b}`,
        );
    }

    assertObjectFrame(a, objectTransforms, objectAnimations, name);
    assertObjectFrame(b, objectTransforms, objectAnimations, name);

    // 统一词汇(见 contract/ir.ts 的 ConstraintTaskBase):求交走数值后端,
    // 未知量是世界坐标轴(数值路径在世界坐标里求解).
    const method = 'numeric' as const;
    const unknowns = ['x', 'y', 'z'];

    // ---- 隐藏:保留占位项但不调度计算 ----
    if (hidden) {
        return {
            name,
            method,
            unknowns,
            aName: statement.a,
            bName: statement.b,
            aId: -1,
            bId: -1,
            segments,
            color,
            enabled: false,
        };
    }

    return {
        name,
        method,
        unknowns,
        aName: statement.a,
        bName: statement.b,
        aId: a.id,
        bId: b.id,
        segments,
        color,
        enabled: true,
    };
}
