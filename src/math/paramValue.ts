/**
 * 参数取值域的归一化(普通参数夹取 / 循环类系数回绕).
 *
 * 放在 math/ 而不是 compiler/dsl/:编译器(声明校验,系数物化,求值 scope)与
 * UI(参数面板数字输入)必须共用同一份口径,否则会出现"滑块显示 0,表达式
 * 按 2π 求值"的漂移.这里只依赖形状最小的入参,不 import IR/编译器类型,
 * 保持单向依赖(compiler -> math,ui -> math).
 */

/** 归一化需要的声明形状;`ParamDeclaration` 结构上满足它. */
export interface ParamRange {
    readonly name: string;
    readonly min: number;
    readonly max: number;
    /**
     * 循环类系数:min 与 max 在圆周上是同一点(球坐标方位角 φ ∈ (-π, π]
     * 这类),越界值回绕到 `[min, max)`.
     *
     * 是否循环必须由 DSL 显式声明(`param φ = 0 in cyclic [...]`),不从
     * 范围或名字推断;缺省/缺失一律按普通参数处理.
     */
    readonly cyclic?: boolean;
}

/**
 * 把参数值归一化到声明的取值域内(全项目唯一入口).
 *
 * - 普通参数:夹到 `[min, max]`;
 * - 循环参数:按区间长度取模回绕到 `[min, max)`.取半开区间是因为 min 与
 *   max 表示同一角度,φ = π 回绕后应落在 -π 一侧而不是与 min 重复的 max.
 *
 * `Number.isFinite` 检查放在这里:回绕公式对 NaN/Infinity 无意义,而静默
 * 产出 NaN 比直接报错更难诊断(与 compiler/dsl/options.ts 的 toFiniteNumber
 * 同为"数值先过有限性"的边界).
 */
export function normalizeParamValue(value: number, param: ParamRange): number {
    if (!Number.isFinite(value)) {
        throw new Error(`参数 ${param.name} 的值必须是有限数,收到 ${value}`);
    }
    if (!param.cyclic) {
        return Math.min(param.max, Math.max(param.min, value));
    }
    // 已在主值区间内的值原样返回:取模公式对恰好落在区间内的输入会引入
    // 1e-16 级的浮点漂移(如 1.5 -> 1.4999999999999991),而"没越界就不动"
    // 既精确又更符合直觉.
    if (value >= param.min && value < param.max) {
        return value;
    }
    const span = param.max - param.min;
    // 声明校验已保证 min < max;span 非正只可能来自未走校验的手工声明,
    // 此时没有可回绕的周期,原样返回比产生 NaN 更可诊断.
    if (!(span > 0)) return value;
    const offset = ((value - param.min) % span + span) % span;
    return param.min + offset;
}
