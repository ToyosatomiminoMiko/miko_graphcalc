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
 * 求交名在 compileIntersections 循环内查重,与 param/object/animation 的
 * "重复声明"契约一致.
 */
import type { AstProgram, IntersectionStatement } from '../ast/types';
import type { IntersectionTask, SceneObject } from '../ir/types';
import { NUMERIC_CONFIG } from '../../config/numericConfig';
import { withStatementSpan } from '../errors';
import {
    assertKnownOptions,
    findOption,
    parseCappedPositiveInteger,
    stripQuotes,
} from './options';
import { invertMat4, type Mat4 } from '../../math/tensor/rowMajorMatrix';

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

export function compileIntersections(
    ast: AstProgram,
    objects: Map<string, SceneObject>,
    objectTransforms: Record<number, Mat4>,
    objectAnimations: Record<number, string[]>,
    hiddenNames: ReadonlySet<string> = new Set(),
): IntersectionTask[] {
    const tasks: IntersectionTask[] = [];
    let colorIndex = 0;
    const seenNames = new Set<string>();

    for (const statement of ast.statements) {
        if (statement.type !== 'intersection') continue;
        // 语句级错误定位:单条求交编译抛错时携带本语句 span,
        // 应用层据此换算成源码行列(见 compiler/errors.ts).
        withStatementSpan(statement.span, () => {
            if (seenNames.has(statement.name)) {
                throw new Error(`求交 ${statement.name} 重复声明`);
            }
            seenNames.add(statement.name);
            compileIntersectionStatement(
                statement,
                objects,
                objectTransforms,
                objectAnimations,
                hiddenNames,
                colorIndex,
                tasks,
            );
            colorIndex += 1;
        });
    }

    return tasks;
}

/**
 * 编译单条 intersection 语句.
 *
 * 从 compileIntersections 的循环体拆出,让"错误携带语句 span"只发生在
 * 循环边界一处,各条 throw 无需手工携带 statement.span.
 */
function compileIntersectionStatement(
    statement: IntersectionStatement,
    objects: Map<string, SceneObject>,
    objectTransforms: Record<number, Mat4>,
    objectAnimations: Record<number, string[]>,
    hiddenNames: ReadonlySet<string>,
    colorIndex: number,
    tasks: IntersectionTask[],
): void {
    const name = statement.name;
    assertKnownOptions(
        statement.options,
        INTERSECTION_OPTION_NAMES,
        `求交 ${name}`,
    );
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

    // ---- 隐藏:保留占位项但不调度计算 ----
    if (hiddenNames.has(name)) {
        tasks.push({
            name,
            aName: statement.a,
            bName: statement.b,
            aId: -1,
            bId: -1,
            segments,
            color,
            enabled: false,
        });
        return;
    }

    tasks.push({
        name,
        aName: statement.a,
        bName: statement.b,
        aId: a.id,
        bId: b.id,
        segments,
        color,
        enabled: true,
    });
}
