/**
 * 静态场景构建与缓存:本文件只保留**编排,缓存与公共导出**.
 *
 * 声明级建模按语句种类拆到相邻模块(202609 拆分,原为 1210 行单文件):
 * - sceneDeclarations.ts       matrix/transform/animation 三类语句的求值,
 *                              以及对象名/已声明值名索引与 animation 选项解析;
 * - antiderivativeBlueprint.ts `antiderivative` 的 blueprint + 展示事实;
 * - odeBlueprint.ts            `ode` 的斜率场/解曲线 blueprint + 展示事实;
 * - derivativeBlueprint.ts     `derivative` 的 curve/surface/vector_field 产物.
 * 各模块都只经由本文件按固定顺序调用(顺序本身有语义,见 buildStaticScene).
 *
 * 202609 review 结论:region 面积图形的"边界曲线必须存在且为 curve,不得带
 * animation/静态 transform"约束只依赖声明级数据(blueprint 与两张 map),
 * 与参数无关;原先放在 compileScene 每次刷新时对"物化对象"重跑一遍,还在
 * 每个 region 里重建一次全对象索引.已上收到 buildStaticScene 末尾一次性
 * 执行(见 finalizeRegionBlueprints),编译缓存命中后不再重复.
 */
import type { AstProgram, ObjectStatement } from '../ast/types';
import type { AnimationClip, ParamDeclaration } from '../../ir';
import type { MatrixOps } from '../../math/matrix/MatrixOps';
import { cloneMat4, type Mat4 } from '../../math/matrix/rowMajorMatrix';
import { withStatementSpan } from '../errors';
import { buildObjectBlueprint } from './objects/build';
import {
    blueprintHasCoefficients,
    type CurveBlueprint,
    type ObjectBlueprint,
    type SurfaceBlueprint,
} from './objects/types';
import {
    createObjectReferenceResolver,
    type ObjectReferenceResolver,
} from './objects/references';
import { findOption } from './options';
import { collectParams, createDefaultParam } from './params';
import { resolveObjectTransform } from './transforms';
import {
    collectAnimationDeclarations,
    collectDeclaredValueNames,
    collectTensorDeclarations,
    collectTransformDeclarations,
    objectStatementsByName,
    parseAnimationNames,
} from './sceneDeclarations';
import {
    buildAntiderivativeBlueprint,
    type AntiderivativeFact,
} from './antiderivativeBlueprint';
import { buildOdeBlueprints, type OdeFact } from './odeBlueprint';
import {
    buildDerivativeObjectBlueprint,
    type DerivativeSource,
} from './derivativeBlueprint';

export type StaticScene = {
    params: Map<string, ParamDeclaration>;
    objectBlueprints: ObjectBlueprint[];
    objectTransforms: Map<number, Mat4>;
    animations: Map<string, AnimationClip>;
    objectAnimations: Map<number, string[]>;
    /** 不定积分的展示事实(内核产物一次算完,求值层只消费);见 antiderivativeBlueprint.ts. */
    antiderivativeFacts: Map<string, AntiderivativeFact>;
    /** 微分方程的展示事实(同一条"内核一次算完"的口径);见 odeBlueprint.ts. */
    odeFacts: Map<string, OdeFact>;
};

/**
 * 静态场景缓存必须和 matrixOps 绑定.
 * 对象表达式/参数声明与 matrixOps 无关,但 transform 求值依赖具体后端;
 * 同一 AST 用不同 matrixOps 编译时若复用旧结果,会返回错误的 objectTransforms.
 * @cache
 * 缓存目的:避免参数刷新时反复执行声明级建模,只按 AST 缓存静态场景.
 * 键/失效策略:WeakMap<AstProgram, { matrixOps, scene }>;AST 被回收时自动
 *              失效.若 matrixOps 后端变化,也会重新构建,避免复用旧变换.
 * 生命周期:模块级,跟随页面存活.
 */
const staticSceneCache = new WeakMap<AstProgram, { matrixOps: MatrixOps; scene: StaticScene }>();

/**
 * @cache_access
 * 获取 AST 对应的静态场景;缓存未命中时构建并写入.
 */
export function getOrBuildStaticScene(ast: AstProgram, matrixOps: MatrixOps): StaticScene {
    let cached = staticSceneCache.get(ast);
    if (!cached || cached.matrixOps !== matrixOps) {
        const scene = buildStaticScene(ast, matrixOps);
        cached = { matrixOps, scene };
        staticSceneCache.set(ast, cached);
    }
    return cached.scene;
}

export function cloneParams(params: Map<string, ParamDeclaration>): Map<string, ParamDeclaration> {
    const clone = new Map<string, ParamDeclaration>();
    for (const [name, param] of params) {
        clone.set(name, { ...param });
    }
    return clone;
}

export function cloneObjectTransforms(transforms: Map<number, Mat4>): Record<number, Mat4> {
    const clone: Record<number, Mat4> = {};
    for (const [id, matrix] of transforms) {
        clone[id] = cloneMat4(matrix);
    }
    return clone;
}

export function cloneAnimations(animations: Map<string, AnimationClip>): AnimationClip[] {
    return [...animations.values()].map((animation) => ({
        name: animation.name,
        duration: animation.duration,
        matrix: cloneMat4(animation.matrix),
    }));
}

export function cloneObjectAnimations(
    objectAnimations: Map<number, string[]>,
): Record<number, string[]> {
    const clone: Record<number, string[]> = {};
    for (const [id, names] of objectAnimations) {
        clone[id] = [...names];
    }
    return clone;
}

/**
 * 声明级建模的共享可变状态.
 *
 * 各 pass 按固定顺序执行,只写自己那部分(与拆分前的局部变量一一对应);
 * 串成一份 draft 只是为了避免每个 pass 各传/回 8 张表.顺序有语义:
 * object -> 可求导源预填 -> antiderivative -> ode -> derivative,
 * 后一个 pass 能引用前一个登记的 resolvable(见各 pass 注释).
 */
interface SceneDraft {
    params: Map<string, ParamDeclaration>;
    objectBlueprints: ObjectBlueprint[];
    /** 已登记对象名:基础对象与三条派生语句共用命名空间,跨 pass 查重. */
    objectNames: Set<string>;
    objectTransforms: Map<number, Mat4>;
    objectAnimations: Map<number, string[]>;
    /** 求导入口:curve/surface/implicit/sphere 的归一化表达式(见 collectDerivativeSources). */
    resolvable: Map<string, DerivativeSource>;
    antiderivativeFacts: Map<string, AntiderivativeFact>;
    odeFacts: Map<string, OdeFact>;
    /** 下一个可用对象 id;跨 pass 单调递增. */
    nextId: number;
}

function buildStaticScene(ast: AstProgram, matrixOps: MatrixOps): StaticScene {
    // 1) 三类声明式语句先各自成型:matrix -> transform -> animation.
    const matrices = new Map<string, Mat4>();
    const transforms = new Map<string, Mat4>();
    const animations = new Map<string, AnimationClip>();
    collectTensorDeclarations(ast, matrices);
    collectTransformDeclarations(ast, matrices, transforms, matrixOps);
    collectAnimationDeclarations(ast, matrices, transforms, matrixOps, animations);

    // 2) 对象 blueprint 建模.region 按名引用两条边界 curve,允许引用声明在
    //    区域之后的对象,索引构建复用 objectStatementsByName.
    const statementsByName = objectStatementsByName(ast);
    const draft: SceneDraft = {
        params: collectParams(ast),
        objectBlueprints: [],
        objectNames: new Set<string>(),
        objectTransforms: new Map<number, Mat4>(),
        objectAnimations: new Map<number, string[]>(),
        resolvable: new Map<string, DerivativeSource>(),
        antiderivativeFacts: new Map<string, AntiderivativeFact>(),
        odeFacts: new Map<string, OdeFact>(),
        nextId: 1,
    };
    // 对象相加(curve/surface 表达式按名引用同类对象)的引用解析器:
    // 参数名优先于对象名,已声明但不是 curve/surface 的名字报错而不是
    // 静默变成自由参数(见 objects/references.ts).
    const references = createObjectReferenceResolver(
        statementsByName,
        collectDeclaredValueNames(ast),
        new Set(draft.params.keys()),
    );

    collectObjectBlueprints(
        ast,
        draft,
        references,
        statementsByName,
        transforms,
        matrices,
        animations,
    );
    // 3) 预填"可求导源";返回的声明名集合供 derivative pass 区分"存在但类型
    //    不对"与"根本不存在"两种报错.
    const declaredObjectNames = collectDerivativeSources(ast, draft);
    // 4) 三条派生语句:顺序 antiderivative -> ode -> derivative(见各函数注释).
    collectAntiderivativeObjects(ast, draft);
    collectOdeObjects(ast, draft);
    collectDerivativeObjects(ast, draft, statementsByName, declaredObjectNames);

    // 5) region 边界约束是纯声明级检查,放在这里一次性执行(见文件头结论).
    finalizeRegionBlueprints(
        draft.objectBlueprints,
        statementsByName,
        draft.objectTransforms,
        draft.objectAnimations,
    );

    // 6) 自由参数补默认值(必须在全部 pass 之后:派生对象的系数也要计入).
    registerCoefficientParams(draft);

    return {
        params: draft.params,
        objectBlueprints: draft.objectBlueprints,
        objectTransforms: draft.objectTransforms,
        animations,
        objectAnimations: draft.objectAnimations,
        antiderivativeFacts: draft.antiderivativeFacts,
        odeFacts: draft.odeFacts,
    };
}

/** object 语句 -> blueprint,并解析其 transform/animation 选项. */
function collectObjectBlueprints(
    ast: AstProgram,
    draft: SceneDraft,
    references: ObjectReferenceResolver,
    statementsByName: Map<string, ObjectStatement>,
    transforms: Map<string, Mat4>,
    matrices: Map<string, Mat4>,
    animations: Map<string, AnimationClip>,
): void {
    for (const statement of ast.statements) {
        if (statement.type !== 'object') continue;
        withStatementSpan(statement.span, () => {
            const blueprint = buildObjectBlueprint(
                statement,
                draft.nextId,
                statementsByName,
                references,
            );
            if (blueprint) {
                if (draft.objectNames.has(blueprint.name)) {
                    throw new Error(`对象 ${blueprint.name} 重复声明`);
                }
                draft.objectNames.add(blueprint.name);
                draft.objectBlueprints.push(blueprint);
                const transform = resolveObjectTransform(
                    findOption(statement.options, 'transform'),
                    transforms,
                    matrices,
                );
                if (transform) draft.objectTransforms.set(blueprint.id, transform);
                const animationNames = parseAnimationNames(
                    findOption(statement.options, 'animation'),
                    `对象 ${blueprint.name} 的 animation`,
                );
                for (const animationName of animationNames) {
                    if (!animations.has(animationName)) {
                        throw new Error(
                            `对象 ${blueprint.name} 引用了不存在的动画 ${animationName}`,
                        );
                    }
                }
                if (animationNames.length > 0) {
                    draft.objectAnimations.set(blueprint.id, animationNames);
                }
                draft.nextId += 1;
            }
        });
    }
}

/** 把 curve/surface blueprint 登记为可继续求导的源(见 collectDerivativeSources). */
function registerResolvable(
    resolvable: Map<string, DerivativeSource>,
    blueprint: CurveBlueprint | SurfaceBlueprint,
): void {
    resolvable.set(blueprint.name, { kind: blueprint.kind, expr: blueprint.expr });
}

/**
 * 预填"可求导源"(curve/surface/implicit/sphere),并收集全部对象声明名.
 *
 * 直接读已经建好的 blueprint:curve/surface 的归一化表达式,implicit 的表达式
 * 与维度,sphere 的符号位置/半径都在里面,避免在这里再解析一遍语句(球体的
 * radius 还有默认值,重复实现会漂移).
 *
 * 审查记录(202609):前向引用不对称--curve/surface 源在此处先预填
 * resolvable,所以"derivative 写在源对象之前"也成立;但链式求导的结果
 * 只在轮到它时才写入 resolvable,因此 `derivative d2 = derivative(d1)`
 * 要求 d1 在之前声明(否则报"引用了不存在的对象 d1").若需链式也支持
 * 乱序,改为两阶段解析(先求依赖序再生成 blueprint).
 *
 * 返回的是**全部**对象声明名(即使 blueprint 缺失或类型不可求导),供
 * derivative pass 报出"类型不对"而不是"不存在".
 */
function collectDerivativeSources(ast: AstProgram, draft: SceneDraft): ReadonlySet<string> {
    const declaredObjectNames = new Set<string>();
    const blueprintByName = new Map(
        draft.objectBlueprints.map((item) => [item.name, item] as const),
    );
    for (const statement of ast.statements) {
        if (statement.type !== 'object' || statement.name === undefined) continue;
        declaredObjectNames.add(statement.name);
        const blueprint = blueprintByName.get(statement.name);
        if (blueprint?.kind === 'curve' || blueprint?.kind === 'surface') {
            registerResolvable(draft.resolvable, blueprint);
        } else if (blueprint?.kind === 'implicit') {
            draft.resolvable.set(statement.name, {
                kind: 'implicit',
                expr: blueprint.expr,
                dim: blueprint.dim,
            });
        } else if (blueprint?.kind === 'sphere') {
            draft.resolvable.set(statement.name, {
                kind: 'sphere',
                positionExprs: blueprint.positionExprs,
                radiusExpr: blueprint.radiusExpr,
            });
        }
    }
    return declaredObjectNames;
}

/**
 * 不定积分语句:生成一个新 curve/surface 对象(设计文档
 * docs/calculus-suite-plan.md 第 3 节"作为可渲染对象下发").
 *
 * 为什么必须在静态场景里建 blueprint(而不是在 compileScene 之后补一个
 * 对象):后面的 `derivative F2 = derivative(F1)` 等引用走的是
 * draft.resolvable;产物只在 compileScene 之后追加,链式引用就找不到它
 * (实测踩过:`derivative back = derivative(F)` 报"引用了不存在的对象 F").
 *
 * 参数按当前值折叠进表达式(与求解/分析同口径):`paramScope` 只用声明里的
 * 默认值,滑块值经 `paramOverrides` 在物化时生效;因此"源对象依赖了哪些
 * 参数"必须原样带到产物 blueprint,参数变化时物化才会重算
 * (buildAntiderivativeBlueprint 里"系数表故意留空"那段注释).
 */
function collectAntiderivativeObjects(ast: AstProgram, draft: SceneDraft): void {
    // 源查询只认**此 pass 之前**的 blueprint:原函数暂不能再被另一条
    // antiderivative 引用(与拆分前一致,蓝图索引在此处一次成型).
    const blueprintByName = new Map(
        draft.objectBlueprints.map((item) => [item.name, item] as const),
    );
    for (const statement of ast.statements) {
        if (statement.type !== 'antiderivative') continue;
        withStatementSpan(statement.span, () => {
            if (draft.objectNames.has(statement.name)) {
                throw new Error(`对象 ${statement.name} 重复声明`);
            }
            const { blueprint, fact } = buildAntiderivativeBlueprint(
                statement,
                draft.nextId,
                blueprintByName,
            );
            draft.antiderivativeFacts.set(statement.name, fact);
            if (blueprint === null) {
                // 能力边界(非初等/超出规则):不下发对象,也不登记 resolvable;
                // 求值条目由 fact.error 给出理由(与求解内核同口径).
                return;
            }
            draft.objectNames.add(blueprint.name);
            draft.objectBlueprints.push(blueprint);
            registerResolvable(draft.resolvable, blueprint);
            draft.nextId += 1;
        });
    }
}

/**
 * 微分方程语句(设计文档 docs/plan3.md 第 1.3 节):放在 antiderivative
 * pass **之后**,derivative pass **之前**--这样 ode 下发的解曲线也能被
 * 后面的 `derivative D = derivative(O1_c1)` 引用(靠 draft.resolvable).
 *
 * id 与 OdeFact 里的 slopeObjectId/curveNames 由 buildOdeBlueprints 按传入的
 * 起始 id 填写,这里按返回顺序登记并递增,保证实体 id 与事实一致.
 */
function collectOdeObjects(ast: AstProgram, draft: SceneDraft): void {
    for (const statement of ast.statements) {
        if (statement.type !== 'ode') continue;
        withStatementSpan(statement.span, () => {
            if (draft.objectNames.has(statement.name)) {
                throw new Error(`对象 ${statement.name} 重复声明`);
            }
            const { blueprints, fact } = buildOdeBlueprints(
                statement,
                draft.nextId,
                draft.params,
            );
            draft.odeFacts.set(statement.name, fact);
            for (const blueprint of blueprints) {
                if (draft.objectNames.has(blueprint.name)) {
                    throw new Error(`对象 ${blueprint.name} 重复声明`);
                }
                draft.objectNames.add(blueprint.name);
                draft.objectBlueprints.push(blueprint);
                registerResolvable(draft.resolvable, blueprint);
                draft.nextId += 1;
            }
        });
    }
}

/**
 * 求导语句:生成一个新 curve/surface/vector_field(全名 derivative,见
 * miko.pest).
 *
 * 只有 curve/surface 求导产物还能继续求导(高阶导数);隐式场求导产物是
 * vector_field,暂不支持对向量场求导,故不写入 resolvable,后续引用会得到
 * 明确的"只能应用于 ..."错误.
 *
 * 求导产物是独立对象,不继承源对象的 transform/animation,故无需登记
 * objectTransforms/objectAnimations.
 */
function collectDerivativeObjects(
    ast: AstProgram,
    draft: SceneDraft,
    statementsByName: Map<string, ObjectStatement>,
    declaredObjectNames: ReadonlySet<string>,
): void {
    for (const statement of ast.statements) {
        if (statement.type !== 'derivative') continue;
        withStatementSpan(statement.span, () => {
            if (draft.objectNames.has(statement.name)) {
                throw new Error(`对象 ${statement.name} 重复声明`);
            }
            const blueprint = buildDerivativeObjectBlueprint(
                statement,
                draft.nextId,
                statementsByName,
                draft.resolvable,
                declaredObjectNames,
            );
            draft.objectNames.add(blueprint.name);
            draft.objectBlueprints.push(blueprint);
            if (blueprint.kind === 'curve' || blueprint.kind === 'surface') {
                registerResolvable(draft.resolvable, blueprint);
            }
            draft.nextId += 1;
        });
    }
}

/**
 * 没在任何声明里出现过的系数名补一个默认参数(自由符号 -> 滑块).
 *
 * 必须等全部 blueprint 建完:派生对象(不定积分/微分方程/求导)的系数由各自
 * 构建器带回,漏掉就会出现"表达式引用了未知符号"的物化期错误.
 */
function registerCoefficientParams(draft: SceneDraft): void {
    for (const blueprint of draft.objectBlueprints) {
        if (!blueprintHasCoefficients(blueprint)) continue;
        for (const name of blueprint.coefficientNames) {
            if (!draft.params.has(name)) {
                draft.params.set(name, createDefaultParam(name));
            }
        }
    }
}

/**
 * region 面积图形的运行时约束(V1 x 型带,见 objects/build.ts / ir/types.ts):
 * - 两条边界曲线必须已在对象列表声明且是 curve(buildObjectBlueprint 已按
 *   ObjectStatement 校验,这里对 blueprint 结果做同源复查);
 * - 边界曲线不得带静态变换或动画--否则 y=f(x) 的带状语义(曲线必须保持在
 *   z=0 平面)会被破坏,报错文案由调用方 UI 直接展示.
 *
 * 只依赖 blueprint 与 objectTransforms/objectAnimations,与参数无关;
 * 202609 review 结论:该检查原先在 compileScene 对"物化对象"每次参数刷新
 * 重跑,且每个 region 各重建一次全对象索引,现上收到这里只跑一次.
 */
function finalizeRegionBlueprints(
    objectBlueprints: ObjectBlueprint[],
    statementsByName: Map<string, ObjectStatement>,
    objectTransforms: Map<number, Mat4>,
    objectAnimations: Map<number, string[]>,
): void {
    const blueprintByName = new Map(objectBlueprints.map((item) => [item.name, item] as const));
    for (const blueprint of objectBlueprints) {
        if (blueprint.kind !== 'region') continue;
        const statement = statementsByName.get(blueprint.name);

        const checkBoundary = (name: string, role: string): void => {
            const curve = blueprintByName.get(name);
            if (!curve || curve.kind !== 'curve') {
                throw new Error(
                    `区域 ${blueprint.name} 的${role}边界曲线必须是已声明的 curve`,
                );
            }
            if ((objectAnimations.get(curve.id) ?? []).length > 0) {
                throw new Error(
                    `区域 ${blueprint.name} 的${role}边界曲线 ${curve.name} 带动画,暂不支持`,
                );
            }
            if (objectTransforms.has(curve.id)) {
                throw new Error(
                    `区域 ${blueprint.name} 的${role}边界曲线 ${curve.name} 带静态变换,暂不支持`,
                );
            }
        };

        const run = (): void => {
            checkBoundary(blueprint.curveAName, '下');
            checkBoundary(blueprint.curveBName, '上');
        };
        if (statement) {
            withStatementSpan(statement.span, run);
        } else {
            run();
        }
    }
}
