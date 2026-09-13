/**
 * 微分分析编译.
 * 负责 gradient/divergence/curl 的符号求导与 WASM 数值求值编排.
 *
 * 202609 review 结论(hidden 语义,与 intersections/integrals 统一):
 * "隐藏 = 先完整校验,后禁用,仅跳过数值计算".分析语句即使被隐藏也必须
 * 通过全部声明级校验(对象存在 / 选项白名单 / 函数名与算子匹配 / kind × 算子
 * 可用矩阵 / at 数量与坐标可求值 / show 白名单),校验失败照常抛语句级错误;
 * 只有 WASM 符号求值/数值核(以及为它准备的 payload)在隐藏时跳过,产出
 * enabled:false 的列表占位.分析名在 compileAnalyses 循环内查重,与
 * param/object/animation 的"重复声明"契约一致.
 *
 * 隐式场扩展(implicit / sphere):这两类源没有显式因变量,`at` 给的是空间点,
 * 先沿 ∇f 牛顿投影到等值面再取法向,数学与失败语义都收在 ./implicitField.ts;
 * 本文件只负责 kind × 算子分派,at 数量,show 缺省与结果落 IR.3D 场的
 * `at` 语法上至少两个坐标,第三个缺省按 0 补全(与 docs 的说明一致).
 */
import type {
    AnalysisCallName,
    AnalysisOpKind,
    AnalysisStatement,
    AstProgram,
} from '../ast/types';
import type {
    AnalysisResult,
    AnalysisShow,
    ParamDeclaration,
    SceneObject,
} from '../ir/types';
import { NUMERIC_CONFIG } from '../../config/numericConfig';
import {
    evaluate_curl_point as wasmEvaluateCurlPoint,
    evaluate_divergence_point as wasmEvaluateDivergencePoint,
    evaluate_gradient_point as wasmEvaluateGradientPoint,
} from '../../wasm/math_rs/math_rs';
import { splitCoefficients } from '../../math/adapters/coefficientUtils';
import {
    CoordinateSystem,
    type CoordinateTriple,
} from '../../math/CoordinateSystem';
import { withStatementSpan } from '../errors';
import { assertKnownOptions, parseShowOption } from './options';
import { buildParamScope } from './params';
import {
    cachedDerivativeExpression,
    cachedLatexExpression,
    evaluateNumber,
    normalizeExpression,
} from './expression';
import { implicitFieldFor, projectToLevelSet } from './implicitField';

/** 每个算子的规范函数名,解析出的 `call` 必须与之一致. */
const ANALYSIS_CALL_NAMES: Record<AnalysisOpKind, AnalysisCallName> = {
    gradient: 'grad',
    divergence: 'div',
    curl: 'curl',
    jacobian: 'jacobian',
    laplacian: 'laplacian',
};

function normalizeVector(vector: [number, number, number]): [number, number, number] {
    const [x, y, z] = vector;
    const length = Math.sqrt(x * x + y * y + z * z);
    return length < NUMERIC_CONFIG.tolerance.zero
        ? [0, 0, 0]
        : [x / length, y / length, z / length];
}

/**
 * 标量场的梯度算子符号式 `∇f = (f_x, f_y, f_z)`(LaTeX).
 *
 * 与求导对象的展示契约一致:先给算子作用在源函数上的公式,再给数值结果.
 * 分量由 Rust 符号引擎对**声明级表达式**求偏导(带缓存),系数保持符号.
 * `dim = 2` 用于一元 curve(只有 x 一个自由变量,f_y 记 0);`dim = 3` 用于
 * 曲面与隐式场(曲面不含 z,对 z 求偏导自然得 0,与真实引擎口径一致).
 *
 * 由 `cachedLatexExpression` 负责表达式 -> LaTeX,与实体对象公式同源.
 */
function symbolicGradientLatex(expr: string, dim: 2 | 3): string {
    const [fx, fy, fz] = dim === 2
        ? [
            cachedDerivativeExpression(expr, 'x'),
            cachedDerivativeExpression(expr, 'y'),
            '0',
        ]
        : [
            cachedDerivativeExpression(expr, 'x'),
            cachedDerivativeExpression(expr, 'y'),
            cachedDerivativeExpression(expr, 'z'),
        ];
    const components = [fx, fy, fz]
        .map((component) => cachedLatexExpression(component))
        .join(',\\ ');
    return `\\nabla f=\\left(${components}\\right)`;
}

/**
 * DSL 分析用的三维球坐标系:角度约定来自全局配置
 * (`numericConfig.analysis.sphericalAngleConvention`).
 *
 * 每次现建一个不可变的小对象即可(无内部状态,无缓存);这样约定切换只有
 * 一个来源,不会出现"编译期一个约定,展示期另一个约定"的漂移.
 */
function analysisSphericalSystem(): CoordinateSystem {
    return CoordinateSystem.spherical(
        3,
        NUMERIC_CONFIG.analysis.sphericalAngleConvention,
    );
}

/**
 * 把 `at spherical(...)` 的参数换算成笛卡尔分析点.
 *
 * - 3 个参数按 `[r, θ, φ]` 解释;
 * - 2 个参数按 `[θ, φ]` 解释,r 取源球体半径(源必须是 sphere).
 *
 * 换算由 {@link CoordinateSystem} 完成,这里只负责 DSL 侧的"省略 r"约定.
 *
 * 注意:球坐标是相对**世界原点**的坐标变换,不是"以球心为原点".球心不在
 * 原点时,换出来的点会由后续 ∇f 投影落到球面上(与笛卡尔 at 同一条路径).
 */
function resolveSphericalAt(
    statement: AnalysisStatement,
    object: SceneObject,
    values: readonly number[],
): CoordinateTriple {
    const system = analysisSphericalSystem();
    if (values.length === 3) {
        return system.toCartesian(values);
    }
    if (object.kind !== 'sphere') {
        throw new Error(
            `分析 ${statement.name} 的 at spherical 省略 r 时源对象必须是 sphere(当前为 ${object.kind})`,
        );
    }
    return system.toCartesian([object.radius, values[0], values[1]]);
}

export function compileAnalyses(
    ast: AstProgram,
    objectByName: Map<string, SceneObject>,
    params: Map<string, ParamDeclaration>,
    paramOverrides: Record<string, number>,
    hiddenNames: ReadonlySet<string> = new Set(),
): AnalysisResult[] {
    const results: AnalysisResult[] = [];
    const seenNames = new Set<string>();

    for (const statement of ast.statements) {
        if (statement.type !== 'analysis') continue;
        // 语句级错误定位:单条 analysis 编译抛错时携带本语句 span,
        // 应用层据此换算成源码行列(见 compiler/errors.ts).
        withStatementSpan(statement.span, () => {
            if (seenNames.has(statement.name)) {
                throw new Error(`分析 ${statement.name} 重复声明`);
            }
            seenNames.add(statement.name);
            compileAnalysisStatement(
                statement,
                objectByName,
                params,
                paramOverrides,
                hiddenNames,
                results,
            );
        });
    }

    return results;
}

/**
 * 编译单条 analysis 语句.
 *
 * 从 compileAnalyses 的循环体拆出,让"错误携带语句 span"只发生在
 * 循环边界一处,各条 throw 无需手工携带 statement.span.
 */
function compileAnalysisStatement(
    statement: AnalysisStatement,
    objectByName: Map<string, SceneObject>,
    params: Map<string, ParamDeclaration>,
    paramOverrides: Record<string, number>,
    hiddenNames: ReadonlySet<string>,
    results: AnalysisResult[],
): void {
    const object = objectByName.get(statement.source.trim());
    if (!object) {
        throw new Error(`分析 ${statement.name} 引用了不存在的对象 ${statement.source}`);
    }

    // 分析声明目前只接受 show;其他字段应作为编译错误暴露.
    assertKnownOptions(statement.options, ['show'], `分析 ${statement.name}`);

    const expectedCall = ANALYSIS_CALL_NAMES[statement.op];
    if (statement.call !== expectedCall) {
        throw new Error(
            `分析 ${statement.name} 的函数名 ${statement.call} 与算子 ${statement.op} 不匹配,应为 ${expectedCall}`,
        );
    }

    if (statement.op === 'jacobian' || statement.op === 'laplacian') {
        throw new Error(`分析算子 ${statement.op} 暂未实现`);
    }

    // ---- 校验面 1:对象 kind × 算子 可用矩阵 ----
    // 标量场源(curve/surface/implicit/球体)只支持 gradient;vector_field
    // 只支持 divergence/curl.这里只读"隐式维度"这个声明级信息,真正的
    // 隐式场闭包(含符号偏导)推迟到 hidden 分支之后再建,保证隐藏项不做
    // WASM 符号求值(与文件头"先完整校验,后禁用"的契约一致).
    const implicitDim: 2 | 3 | null = object.kind === 'implicit'
        ? object.dim
        : object.kind === 'sphere'
            ? 3
            : null;
    if (statement.op === 'divergence' || statement.op === 'curl') {
        if (object.kind !== 'vector_field') {
            throw new Error(
                `分析算子 ${statement.op} 不能应用于 ${object.kind} 类型对象`,
            );
        }
    } else if (
        implicitDim === null
        && object.kind !== 'curve'
        && object.kind !== 'surface'
    ) {
        // 方块/旋转体的隐式函数是 max 型分段函数,梯度 V1 未支持;
        // point/vector/region 本来就不是标量场,按普通"不可分析"报错.
        if (object.kind === 'box' || object.kind === 'conic') {
            throw new Error(
                `分析 ${statement.name} 暂不支持 ${object.kind} 体积对象(当前仅支持 sphere 与 implicit)`,
            );
        }
        throw new Error(`分析 ${statement.name} 不能应用于 ${object.kind} 类型对象`);
    }

    // ---- 校验面 2:at 坐标 ----
    // scope 直接由 buildParamScope(params, overrides) 提供,不再依赖
    // "先 applyParamOverrides 改 map 再建 scope"的副作用通道
    // (202609 review:见 params.ts 注释).
    const atScope = buildParamScope(params, paramOverrides);
    const rawAt = statement.at ?? [];
    const isSphericalAt = statement.atForm === 'spherical';
    // 3D 隐式场/球体的笛卡尔 at 在语法上同样至少两个数,第三个缺省按 0 补全
    // (见 docs/derivatives-guide.md:建议写全 [x, y, z]).
    // 球坐标形式的 2 个参数含义不同(θ, φ),r 取源球体半径,故下限同样是 2.
    const requiredAtCount = object.kind === 'vector_field' && !isSphericalAt
        ? 3
        : object.kind === 'surface' || implicitDim !== null
            ? 2
            : isSphericalAt
                ? 2
                : 1;
    if (rawAt.length < requiredAtCount) {
        throw new Error(`分析 ${statement.name} 的 at 至少需要 ${requiredAtCount} 个坐标`);
    }
    if (isSphericalAt && rawAt.length > 3) {
        throw new Error(
            `分析 ${statement.name} 的 at spherical 最多 3 个坐标(r, θ, φ)`,
        );
    }

    const atValues: number[] = [];
    for (let i = 0; i < rawAt.length; i += 1) {
        const value = evaluateNumber(rawAt[i], atScope);
        if (value === null) {
            throw new Error(`分析 ${statement.name} 的 at 第 ${i + 1} 个坐标无法求值: ${rawAt[i]}`);
        }
        atValues.push(value);
    }
    // 笛卡尔形式也经坐标系类解释(缺省分量自动补 0),两条 at 路径同源.
    const at: CoordinateTriple = isSphericalAt
        ? resolveSphericalAt(statement, object, atValues)
        : CoordinateSystem.cartesian(3).toCartesian(atValues);

    // show 白名单也在隐藏前校验,避免隐藏项带着拼写错误的 show 静默存活.
    // 缺省项按源对象分派:一元 curve 求导与 2D 隐式曲线默认连同切线一起画,
    // 让"求导要有切线"在没写 show 时也成立;曲面/3D 隐式场/向量场沿用
    // [point, normal].
    const defaultShow: AnalysisShow[] = statement.op === 'gradient'
        && (object.kind === 'curve' || implicitDim === 2)
        ? ['point', 'normal', 'tangent']
        : ['point', 'normal'];
    const show = parseShowOption(statement.options, defaultShow);

    // ---- 隐藏:仅保留列表项,不执行数值计算 ----
    if (hiddenNames.has(statement.name)) {
        results.push({
            name: statement.name,
            op: statement.op,
            point: [0, 0, 0],
            vector: [0, 0, 0],
            tangent: null,
            scalar: null,
            show,
            enabled: false,
        });
        return;
    }

    // ---- 隐式场(implicit / sphere):投影到等值面的点分析 ----
    // 与 curve/surface 的差别:at 给的是空间点而不是"因变量已解出"的
    // 自变量,∇f 在空间处处有定义,但"切平面/切向量"只对等值面上的点有
    // 意义,因此先沿 ∇f 牛顿投影到 f = level,再取该处法向.
    // 2D 隐式曲线额外给出平面内切线(与 curve 求导的 tangent 对位).
    // 正式的场闭包(含符号偏导)只在没被隐藏时才建;系数由闭包自己持有.
    const field = implicitFieldFor(object);
    if (field !== null) {
        const projected = projectToLevelSet(field, at, `分析 ${statement.name}`);
        results.push({
            name: statement.name,
            op: 'gradient',
            point: projected.point,
            // 算子符号式:列表先展开 ∇f,再给该点的数值结果.
            symbolic: symbolicGradientLatex(field.expr, field.dim),            // 隐式场/球体的分析点是三维空间点,结果列表同时给出球坐标
            // [r, θ, φ](相对世界原点);由坐标系类换算,约定与 at spherical
            // 共用同一份全局配置.
            pointSpherical: analysisSphericalSystem().fromCartesian(projected.point),
            vector: projected.normal,
            tangent: projected.tangent,
            // 结果列表的 f(P) 取投影点处的场值(≈ level),与展示的点一致.
            scalar: projected.valueAtPoint,
            show,
            enabled: true,
        });
        return;
    }

    if (object.kind === 'curve' || object.kind === 'surface') {
        // 经过 op×kind gate,此处 statement.op 必为 gradient.
        const { names: coeffNames, values: coeffValues } = splitCoefficients(
            object.coefficients,
        );
        const isCurve = object.kind === 'curve';
        const payload = JSON.stringify({
            surface_expr: normalizeExpression(object.expr),
            fx_expr: cachedDerivativeExpression(object.expr, 'x'),
            fy_expr: isCurve ? '0' : cachedDerivativeExpression(object.expr, 'y'),
            coeff_names: coeffNames,
            coeff_values: coeffValues,
            x: at[0],
            y: isCurve ? 0 : at[1],
        });
        const result = wasmEvaluateGradientPoint(payload);
        const f0 = result.f0;
        const vector = normalizeVector(
            isCurve
                ? [-result.fx, 1, 0]
                : [-result.fx, -result.fy, 1],
        );
        // 一元曲线求导的切线方向:(1, f', 0),与上面的法向在 z=0 平面内
        // 正交;曲面只有切平面,没有唯一"切线",故为 null.
        const tangent: [number, number, number] | null = isCurve
            ? [1, result.fx, 0]
            : null;
        const point: [number, number, number] = isCurve
            ? [at[0], f0, 0]
            : [at[0], at[1], f0];
        results.push({
            name: statement.name,
            op: 'gradient',
            point,
            // 一元曲线只有 x 一个自由变量;曲面两个分量都是符号偏导.
            symbolic: symbolicGradientLatex(object.expr, isCurve ? 2 : 3),
            vector,
            tangent,
            scalar: f0,
            show,
            enabled: true,
        });
        return;
    }

    // vector_field:divergence / curl(经过 op×kind gate).
    // 上面的标量场分派都已 return,这里显式收窄一次类型,同时兜住
    // "算子与对象不匹配"的漏网情况.
    if (object.kind !== 'vector_field') {
        throw new Error(
            `分析算子 ${statement.op} 不能应用于 ${object.kind} 类型对象`,
        );
    }
    const { names: coeffNames, values: coeffValues } = splitCoefficients(
        object.coefficients,
    );
    const [pExpr, qExpr, rExpr] = object.components;
    if (statement.op === 'divergence') {
        const payload = JSON.stringify({
            dpx_expr: cachedDerivativeExpression(pExpr, 'x'),
            dqy_expr: cachedDerivativeExpression(qExpr, 'y'),
            drz_expr: cachedDerivativeExpression(rExpr, 'z'),
            coeff_names: coeffNames,
            coeff_values: coeffValues,
            x: at[0],
            y: at[1],
            z: at[2],
        });
        const scalar = wasmEvaluateDivergencePoint(payload);
        results.push({
            name: statement.name,
            op: 'divergence',
            point: at,
            vector: [0, 0, 0],
            tangent: null,
            scalar,
            show,
            enabled: true,
        });
        return;
    }

    const payload = JSON.stringify({
        dr_dy_expr: cachedDerivativeExpression(rExpr, 'y'),
        dq_dz_expr: cachedDerivativeExpression(qExpr, 'z'),
        dp_dz_expr: cachedDerivativeExpression(pExpr, 'z'),
        dr_dx_expr: cachedDerivativeExpression(rExpr, 'x'),
        dq_dx_expr: cachedDerivativeExpression(qExpr, 'x'),
        dp_dy_expr: cachedDerivativeExpression(pExpr, 'y'),
        coeff_names: coeffNames,
        coeff_values: coeffValues,
        x: at[0],
        y: at[1],
        z: at[2],
    });
    const result = wasmEvaluateCurlPoint(payload);
    const vector: [number, number, number] = [result.x, result.y, result.z];
    results.push({
        name: statement.name,
        op: 'curl',
        point: at,
        vector,
        tangent: null,
        scalar: null,
        show,
        enabled: true,
    });
}
