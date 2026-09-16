import type { AstProgram } from '../ast/types';
import type {
    AntiderivativeTask,
    IntegralTask,
    SceneIR,
    SceneObject,
} from '../../ir';
import type { MatrixOps } from '../../math/matrix/MatrixOps';
import { withStatementSpan } from '../errors';
import { materializeObject } from './objects/materialize';
import { applyParamOverrides } from './params';
import { compileIntegralTask } from './integrals';
import { compileAnalyses } from './analyses';
import { compileIntersections } from './intersections';
import { compileSolves } from './solves';
import { collectAntiderivativeTasks } from './antiderivativeTasks';
import { integralLatex, sceneObjectLatex } from './latex';
import {
    cloneAnimations,
    cloneObjectAnimations,
    cloneObjectTransforms,
    cloneParams,
    getOrBuildStaticScene,
} from './staticScene';

/**
 * DslCompiler facade:只负责把 AST 编排成 SceneIR.
 *
 * 具体职责已经拆到:
 * - options.ts     选项与列表解析
 * - params.ts      参数收集/覆盖/求值 scope
 * - objects/        对象子系统:types.ts(blueprint 类型)/build.ts(语句->blueprint;
 *                    region 面积图形 V1 语义见该文件头)/materialize.ts(blueprint->数值 IR)
 * - expression.ts  Rust 符号归一化/求导与数值求值
 * - transforms.ts  矩阵/变换求值(统一因子语法见该文件头注释)
 * - integrals.ts   积分任务编译(dim/domainKind/integrand 语义)
 * - analyses.ts    微分分析编译
 * - staticScene.ts 静态场景构建与缓存(含 region 边界静态约束的一次性校验)
 *
 * ## 跨模块约定(202609 review 结论,修改涉及模块时保持同步)
 * 1. hidden 语义统一为"先完整校验,后禁用,仅跳过计算":analysis/intersection/
 *    integral 语句即使被隐藏也必须通过全部声明级校验,错误照常带语句 span
 *    抛出;隐藏只产出 enabled:false 的占位(列表保留,不调度数值计算).
 * 2. 语句名唯一:param/object/animation/analysis/integral/intersection 各自
 *    查重("重复声明").求值语句(analysis/integral/intersection)此前漏了
 *    查重,integralFormulas 这类 Record<名字,...> 会被同名语句静默覆盖.
 * 3. 表达式归一化收口:curve/surface 单表达式与 vector_field 三分量在
 *    blueprint 阶段统一归一化;region 边界系数也按"归一化后的边界表达式"
 *    提取,保证符号求导/LaTeX/系数集合与对象自身同源(objects/build.ts 文件头).
 * 4. 参数覆盖值统一走 params.ts 的 materializeCoefficient/
 *    requireDeclaredCoefficient / buildParamScope;applyParamOverrides 只负责
 *    让 IR scene.params 携带当前滑块值,消费方不要依赖 map 回写副作用.
 * 5. region 边界约束只依赖声明级数据,已在 buildStaticScene 一次性校验,
 *    每次参数刷新不再重复(staticScene.ts 文件头).
 */
export interface CompileSceneOptions {
    hiddenAnalysisNames?: ReadonlySet<string>;
    hiddenIntegralNames?: ReadonlySet<string>;
    hiddenIntersectionNames?: ReadonlySet<string>;
    hiddenSolveNames?: ReadonlySet<string>;
    hiddenAntiderivativeNames?: ReadonlySet<string>;
}

export function compileScene(
    ast: AstProgram,
    paramOverrides: Record<string, number> = {},
    matrixOps: MatrixOps,
    options: CompileSceneOptions = {},
): SceneIR {
    const staticScene = getOrBuildStaticScene(ast, matrixOps);
    const hiddenAnalysisNames = options.hiddenAnalysisNames ?? new Set<string>();
    const hiddenIntegralNames = options.hiddenIntegralNames ?? new Set<string>();
    const hiddenIntersectionNames = options.hiddenIntersectionNames ?? new Set<string>();
    const hiddenSolveNames = options.hiddenSolveNames ?? new Set<string>();

    const params = cloneParams(staticScene.params);
    // 隐藏的原函数语句既不下发对象,也不进后续引用解析(与"隐藏=不参与计算"
    // 同一语义);静态场景里仍保留 blueprint,这样切回显示不需要重新解析.
    const hiddenAntiderivativeNames = options.hiddenAntiderivativeNames ?? new Set<string>();
    const objects = staticScene.objectBlueprints
        .filter(
            (blueprint) =>
                blueprint.kind !== 'curve' && blueprint.kind !== 'surface'
                    ? true
                    : blueprint.antiderivativeOrigin === undefined
                        || !hiddenAntiderivativeNames.has(blueprint.name),
        )
        .map((blueprint) => materializeObject(blueprint, params, paramOverrides));
    // 仅用于让 IR scene.params 反映当前滑块值(见文件头约定 4).
    applyParamOverrides(params, paramOverrides);

    const objectTransforms = cloneObjectTransforms(staticScene.objectTransforms);
    const objectAnimations = cloneObjectAnimations(staticScene.objectAnimations);

    const objectByName = new Map<string, SceneObject>();
    for (const object of objects) {
        if (object.name !== undefined) {
            objectByName.set(object.name, object);
        }
    }

    // 不定积分(设计文档 docs/calculus-suite-plan.md 第 3 节):声明级编译,
    // 产物有两路--求值条目进 `antiderivatives`,成功的原函数**同时**作为普通
    // curve/surface 进 `objects`.后者让"原函数"直接获得渲染,求导,分析,
    // 积分,求交的全部既有能力,不需要任何渲染层改动.
    //
    // 顺序必须在 integral/analysis 之前:原函数对象要能被它们的 `objectByName`
    // 查到(下面把新对象与名字一起并入).
    const compiledAntiderivatives = collectAntiderivativeTasks(
        ast,
        staticScene.antiderivativeFacts,
        objects,
        hiddenAntiderivativeNames,
    );
    const antiderivatives: AntiderivativeTask[] = [];
    for (const entry of compiledAntiderivatives) {
        antiderivatives.push(entry.task);
    }

    // integral 名称查重(约定 2);隐藏积分同样先完整编译校验,再置
    // enabled=false(约定 1),占位仍进入列表.
    const integrals: IntegralTask[] = [];
    const seenIntegralNames = new Set<string>();
    for (const statement of ast.statements) {
        if (statement.type !== 'integral') continue;
        // 语句级错误定位:积分任务编译失败时携带本语句 span.
        withStatementSpan(statement.span, () => {
            if (seenIntegralNames.has(statement.name)) {
                throw new Error(`积分 ${statement.name} 重复声明`);
            }
            seenIntegralNames.add(statement.name);
            const task = compileIntegralTask(
                statement,
                objectByName,
                params,
                paramOverrides,
            );
            task.enabled = !hiddenIntegralNames.has(statement.name);
            integrals.push(task);
        });
    }

    const objectFormulas: Record<number, string | null> = {};
    for (const object of objects) {
        objectFormulas[object.id] = sceneObjectLatex(object, objectByName);
    }
    const integralFormulas: Record<string, string | null> = {};
    for (const task of integrals) {
        integralFormulas[task.name] = integralLatex(task, objects);
    }

    return {
        params: [...params.values()],
        objects,
        objectFormulas,
        objectTransforms,
        animations: cloneAnimations(staticScene.animations),
        objectAnimations,
        analyses: compileAnalyses(
            ast,
            objectByName,
            params,
            paramOverrides,
            hiddenAnalysisNames,
        ),
        integrals,
        integralFormulas,
        intersections: compileIntersections(
            ast,
            objectByName,
            objectTransforms,
            objectAnimations,
            hiddenIntersectionNames,
        ),
        // 方程求解是声明级编译(与 analysis 同一档):步骤链一次算出写进 IR.
        solves: compileSolves(ast, params, paramOverrides, hiddenSolveNames),
        // 不定积分同为声明级编译;实体侧的新对象已并入上面的 `objects`/`objectByName`.
        antiderivatives,
        // 微分方程(设计文档 docs/calculus-suite-plan.md 第 4 节)按三期实现:
        // 先固定空表,让 IR 契约与渲染层一次到位(与求解内核当年的分期口径一致).
        odes: [],
    };
}
