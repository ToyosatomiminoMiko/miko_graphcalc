/**
 * 隐式标量场:把"隐式对象"与"球体"统一成 `f(x,y,z) = level`,并提供
 * 点求值,∇f 与"沿梯度投影到等值面"三项能力.
 *
 * 为什么需要这一层:curve/surface 的 gradient 之所以简单,是因为它们的
 * 方程已经解出了因变量(`y=f(x)` / `z=f(x,y)`),分析点由 `at` 的 x/y
 * 直接给出.隐式对象与体积对象没有因变量,`at` 给的是空间里的一个点,
 * 一般并不落在等值面上,所以必须先投影再谈"切平面/法向".
 *
 * 计算分工(与项目"数值计算交给 Rust"的路线一致):
 * - 符号偏导走 Rust 符号引擎(`cachedDerivativeExpression`);
 * - 数值求值走 Rust/WASM 的 `evaluate_scalar`(`evaluateExpressionAt`);
 * - 本文件只做编排 + 牛顿投影迭代 + 向量归一化,不重复实现数学内核.
 *
 * 编码注意:
 * - 2D 隐式曲线(f(x,y)=level)的 z 分量恒为 0,投影只在 x–y 平面内进行;
 * - f 的零点/等值面投影用牛顿法 `p ← p − (f(p)−level)·∇f/|∇f|²`,球体这类
 *   等值面收敛很快;若在若干步内不收敛(例如点落在 ∇f=0 的临界点),宁可
 *   报编译期错误也不静默画一个错误的切平面;
 * - 投影与法向都在**对象局部坐标**里进行;与 curve/surface 的既有分析
 *   一致,静态 transform 不参与分析(见 docs/derivatives-impl.md).
 */
import { NUMERIC_CONFIG } from '../../config/numericConfig';
import { splitCoefficients } from '../../math/adapters/coefficientUtils';
import type { ImplicitObject, SceneObject, SphereObject } from '../ir/types';
import { cachedDerivativeExpression, evaluateExpressionAt } from './expression';

/** 隐式场的点求值器;返回 null 表示该点不可求值(定义域外/符号未声明). */
export interface ImplicitField {
    name: string;
    /**
     * 隐式方程左端的标量场表达式 f(x,y[,z]).
     *
     * 数值路径只用 `value`/`gradient`;分析结果列表拿它做一次符号求导,把
     * 算子展开式 `∇f = (f_x, f_y, f_z)` 作为中间步骤展示(与 curve/surface
     * 的 `symbolic` 同源,见 dsl/analyses.ts).
     */
    expr: string;
    /** 2 = f(x,y)=level;3 = f(x,y,z)=level. */
    dim: 2 | 3;
    /** 等值面的水平值,投影目标即 f = level. */
    level: number;
    value(x: number, y: number, z: number): number | null;
    gradient(x: number, y: number, z: number): [number, number, number] | null;
}

/** 投影结果:等值面上的点,单位法向,2D 切线(3D 为 null)与投影点处的 f 值. */
export interface ProjectedFieldPoint {
    point: [number, number, number];
    normal: [number, number, number];
    /** 仅 2D 隐式曲线给值:与法向在同一平面内正交的单位切线. */
    tangent: [number, number, number] | null;
    /** f 在投影点处的值(≈ level,供"结果"列表展示). */
    valueAtPoint: number;
}

/** 牛顿投影的最大迭代次数与相对收敛阈值. */
const PROJECTION_MAX_ITERATIONS = 32;
const PROJECTION_RELATIVE_TOLERANCE = 1e-9;

function norm(v: readonly [number, number, number]): number {
    return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function formatPoint(point: readonly [number, number, number]): string {
    return `[${point[0]}, ${point[1]}, ${point[2]}]`;
}

/**
 * 隐式对象 -> 隐式场.
 *
 * f 与 ∇f 的三个分量都只做一次符号求导(带缓存),之后每次参数刷新只
 * 重新做数值求值;系数(如 `param a`)通过 scope 传入,与 curve/surface
 * 的求值路径同源.
 */
export function implicitFieldOf(object: ImplicitObject): ImplicitField {
    const { names, values } = splitCoefficients(object.coefficients);
    const scope: Record<string, number> = {};
    for (let index = 0; index < names.length; index += 1) {
        scope[names[index]] = values[index];
    }

    const gxExpr = cachedDerivativeExpression(object.expr, 'x');
    const gyExpr = cachedDerivativeExpression(object.expr, 'y');
    // 2D 隐式曲线不含 z:显式写 0,保持三分量形状统一,同时避免对 z 求导
    // 得到一个恒 0 表达式还要走一次符号引擎.
    const gzExpr = object.dim === 3
        ? cachedDerivativeExpression(object.expr, 'z')
        : '0';

    return {
        name: object.name,
        expr: object.expr,
        dim: object.dim,
        level: object.level,
        value: (x, y, z) => evaluateExpressionAt(object.expr, scope, x, y, z),
        gradient: (x, y, z) => {
            const gx = evaluateExpressionAt(gxExpr, scope, x, y, z);
            const gy = evaluateExpressionAt(gyExpr, scope, x, y, z);
            const gz = evaluateExpressionAt(gzExpr, scope, x, y, z);
            if (gx === null || gy === null || gz === null) return null;
            return [gx, gy, gz];
        },
    };
}

/**
 * 球体 -> 隐式场 `f = |p − c|² − r²`.
 *
 * 球体是"内置隐式对象"的特例:中心/半径在物化阶段已是数值,因此 ∇f 可以
 * 直接解析给出(`2(p − c)`),不必再走一次符号引擎.等值面 f=0 就是球面,
 * 沿 ∇f 投影即径向投影,与中点无关的对称性一致.
 */
export function sphereImplicitField(object: SphereObject): ImplicitField {
    const { x: cx, y: cy, z: cz } = object.position;
    const radius = object.radius;

    return {
        name: object.name,
        // 球体在物化阶段中心/半径已是数值,隐式方程由这些数值直接构造;
        // 表达式供列表做 ∇f 的符号展开(数值路径不解析它).
        expr: sphereImplicitExpression(
            [String(cx), String(cy), String(cz)],
            String(radius),
        ),
        dim: 3,
        level: 0,
        value: (x, y, z) => (
            (x - cx) * (x - cx)
            + (y - cy) * (y - cy)
            + (z - cz) * (z - cz)
            - radius * radius
        ),
        gradient: (x, y, z) => [
            2 * (x - cx),
            2 * (y - cy),
            2 * (z - cz),
        ],
    };
}

/**
 * 取对象的隐式场;非隐式源(或 V1 未支持的方块/旋转体)返回 null.
 *
 * 目前只有 `implicit` 与 `sphere` 有解析的隐式场.`box`/`conic` 的隐式
 * 函数是 max 型分段函数,gradient/derivative 暂不支持(调用方按 kind
 * 给出明确错误),不在这里硬编码半成品.
 */
export function implicitFieldFor(object: SceneObject): ImplicitField | null {
    if (object.kind === 'implicit') return implicitFieldOf(object);
    if (object.kind === 'sphere') return sphereImplicitField(object);
    return null;
}

/**
 * 把空间中的点 `at` 沿 ∇f 投影到等值面 `f = level`,并给出该处的单位法向.
 *
 * `at` 的三个分量缺省已由调用方补 0;2D 场只使用前两个分量(牛顿迭代中
 * z 恒为 0,因为 ∂f/∂z ≡ 0).失败时抛出带上下文的普通 Error,由语句级
 * 编译循环补上源码 span.
 */
export function projectToLevelSet(
    field: ImplicitField,
    at: readonly [number, number, number],
    context: string,
): ProjectedFieldPoint {
    const zeroTolerance = NUMERIC_CONFIG.tolerance.zero;
    const convergenceTolerance = PROJECTION_RELATIVE_TOLERANCE
        * Math.max(1, Math.abs(field.level));

    let point: [number, number, number] = [at[0], at[1], at[2]];
    let value = field.value(point[0], point[1], point[2]);
    let gradient = field.gradient(point[0], point[1], point[2]);
    if (value === null || gradient === null) {
        throw new Error(`${context} 在 ${formatPoint(point)} 处无法求值`);
    }
    if (norm(gradient) <= zeroTolerance) {
        throw new Error(
            `${context} 在 ${formatPoint(point)} 处 ∇f = 0,法向未定义`,
        );
    }

    let converged = Math.abs(value - field.level) <= convergenceTolerance;
    for (
        let iteration = 0;
        !converged && iteration < PROJECTION_MAX_ITERATIONS;
        iteration += 1
    ) {
        const magnitudeSquared = gradient[0] * gradient[0]
            + gradient[1] * gradient[1]
            + gradient[2] * gradient[2];
        if (magnitudeSquared <= zeroTolerance) break;

        // 牛顿步:f(p) 沿 ∇f 的一阶展开,步长 = (f(p) − level) / |∇f|².
        const step = (value - field.level) / magnitudeSquared;
        point = [
            point[0] - step * gradient[0],
            point[1] - step * gradient[1],
            point[2] - step * gradient[2],
        ];
        if (field.dim === 2) point[2] = 0;

        value = field.value(point[0], point[1], point[2]);
        gradient = field.gradient(point[0], point[1], point[2]);
        if (value === null || gradient === null) {
            throw new Error(
                `${context} 投影到等值面 f = ${field.level} 时在 ${formatPoint(point)} 处求值失败`,
            );
        }
        converged = Math.abs(value - field.level) <= convergenceTolerance;
    }

    if (!converged) {
        throw new Error(
            `${context} 无法从 ${formatPoint([at[0], at[1], at[2]])} 收敛到等值面 f = ${field.level}`,
        );
    }

    const magnitude = norm(gradient);
    if (magnitude <= zeroTolerance) {
        throw new Error(`${context} 在投影点 ${formatPoint(point)} 处 ∇f = 0,法向未定义`);
    }
    const normal: [number, number, number] = [
        gradient[0] / magnitude,
        gradient[1] / magnitude,
        gradient[2] / magnitude,
    ];
    if (field.dim === 2) point = [point[0], point[1], 0];

    return {
        point,
        normal,
        // 2D 隐式曲线的切线 = 法向在 x–y 平面内逆时针转 90°:
        //   n = (fx, fy, 0)/|∇f|  ->  t = (−fy, fx, 0)/|∇f|
        // 3D 等值面没有唯一切线,只提供切平面(与 surface 的 gradient 一致).
        tangent: field.dim === 2
            ? [-normal[1], normal[0], 0]
            : null,
        valueAtPoint: value,
    };
}

/**
 * 由球体的符号中心/半径表达式构造隐式方程 `f = |p − c|² − r²`.
 *
 * 供 `derivative` 语句在**声明级**生成梯度向量场使用:那里拿到的是
 * blueprint 里的符号表达式(可能是 `param`),不能用物化后的数值,否则
 * 拖动参数滑块时导数场不会跟着变.返回的字符串会交给 Rust 符号引擎
 * 求偏导,`2 * (x - (a))` 这种显式括号是为了避免 `x - -1` 之类的重读.
 */
export function sphereImplicitExpression(
    positionExprs: readonly [string, string, string],
    radiusExpr: string,
): string {
    const [cx, cy, cz] = positionExprs;
    return `(x - (${cx}))^2 + (y - (${cy}))^2 + (z - (${cz}))^2 - (${radiusExpr})^2`;
}

/**
 * 球体 ∇f 的解析三分量:`∇f = 2(p − c)`.
 *
 * 与 `sphereImplicitExpression` 一样只用于声明级蓝图;因为球体的 ∇f 有
 * 闭式,这里直接给解析式,不再对 f 做一次符号求导(两者等价,少一层
 * 符号引擎开销,也让测试不依赖符号引擎的化简风格).
 */
export function sphereGradientExpressions(
    positionExprs: readonly [string, string, string],
): [string, string, string] {
    const [cx, cy, cz] = positionExprs;
    return [
        `2 * (x - (${cx}))`,
        `2 * (y - (${cy}))`,
        `2 * (z - (${cz}))`,
    ];
}
