/**
 * 系数形态转换工具.
 *
 * IR 里系数是对象数组 `Coefficient[]`(`compiler/ir/types`),而 wasm/Worker
 * 各入口期望的是平行的 `names[]/values[]` 或 `Record<name, value>`.
 * 此前各渲染器/求交/计算门面各自写一份 `.map(c => c.name)` 转换,这里收口
 * 成一套工具,避免同一语义在多处各写一遍.
 */
import type { Coefficient } from '../../compiler/ir/types';

export type CoefficientNamesAndValues = {
    names: string[];
    values: number[];
};

/**
 * 把系数对象数组拆成平行的名字/值数组,与曲线/曲面/向量场/求交的
 * Worker 请求约定一致.
 */
export function splitCoefficients(
    coefficients: readonly Coefficient[],
): CoefficientNamesAndValues {
    const names: string[] = new Array(coefficients.length);
    const values: number[] = new Array(coefficients.length);
    for (let index = 0; index < coefficients.length; index += 1) {
        names[index] = coefficients[index].name;
        values[index] = coefficients[index].value;
    }
    return { names, values };
}

/**
 * 把系数对象数组转成 `Record<name, value>`,供积分等按名取值路径使用.
 */
export function coefficientsToRecord(
    coefficients: readonly Coefficient[],
): Record<string, number> {
    const result: Record<string, number> = {};
    for (const coefficient of coefficients) {
        result[coefficient.name] = coefficient.value;
    }
    return result;
}

export type SortedCoefficientArgs = {
    names: string[];
    values: Float64Array;
};

/**
 * 把 `Record<name, value>` 转成排序后的 `names + Float64Array`,与
 * math_rs wasm 系数的"名字须有序"约定一致(积分/采样 Worker 使用).
 */
export function recordToCoefficientArgs(
    coeffs: Readonly<Record<string, number>>,
): SortedCoefficientArgs {
    const names = Object.keys(coeffs).sort();
    const values = new Float64Array(names.map((name) => coeffs[name]));
    return { names, values };
}
