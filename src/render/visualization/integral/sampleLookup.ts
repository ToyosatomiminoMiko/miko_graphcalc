/**
 * 数值积分采样网格 -> 连续函数映射.
 *
 * 数值与可视化同源:可视化按数值核返回的样本查表,不重新求值表达式.
 * 这里从 DslIntegralRenderer 抽成纯函数,便于对"单元定位"这类边界情形补单测
 * (见 RND-P2.1).
 */
import type { IntegralResult } from '../../../math/compute/workers/IntegralCompute';

/**
 * 单元定位容差.
 *
 * 查询点由调用方按网格节点生成(如 `xMin + k·h`),浮点算出的
 * `(x − xMin) / h` 可能是 `k − ε`,`Math.floor` 于是落到相邻单元.
 * 加一个远小于单元宽度的容差把它吸附回节点,与 core/axisSteps.ts 的
 * `+ 1e-9` 写法一致.查询点若真的落在单元内部,这点偏移不会改变结果.
 */
const CELL_EPSILON = 1e-9;

/** 一维样本 -> 连续函数(1D 曲线域). */
export function makeFn1D(
    a: number,
    b: number,
    result: IntegralResult,
): (x: number) => number {
    const samples = result.samples;
    if (!samples) return () => NaN;

    if (result.sampleShape === '1d-mid') {
        const n = samples.length;
        const h = (b - a) / n;
        return (x: number) => {
            const idx = Math.max(0, Math.min(n - 1, Math.round((x - a) / h - 0.5)));
            return samples[idx] ?? NaN;
        };
    }

    const n = samples.length - 1;
    const h = (b - a) / n;
    return (x: number) => {
        const idx = Math.max(0, Math.min(n, Math.round((x - a) / h)));
        return samples[idx] ?? NaN;
    };
}

/**
 * 二维网格 -> 单元函数.
 *
 * 约定:对矩形(rectangle)与区域(region)域,数值采样与可视化都把每个
 * 网格单元看成一个"柱":单元采样端(左/右/中,由方法决定)在带内时该
 * 柱可见,柱高 = 采样端被积值.返回的函数按单元定位,给出该单元的
 * 采样端值(带外/非有限为 NaN,可视化跳过).
 */
export function makeFn2D(
    xMin: number,
    xMax: number,
    yMin: number,
    yMax: number,
    result: IntegralResult,
): (x: number, y: number) => number {
    const samples = result.samples;
    const n = result.n ?? 0;
    const m = result.m ?? n;
    if (!samples || n === 0 || m === 0) return () => NaN;

    // (n+1)×(m+1) 全网格采样(trapezoid/simpson 的网格样本).
    if (result.sampleShape === '2d-grid') {
        const hx = (xMax - xMin) / n;
        const hy = (yMax - yMin) / m;
        return (x: number, y: number) => {
            const i = Math.max(0, Math.min(n, Math.round((x - xMin) / hx)));
            const j = Math.max(0, Math.min(m, Math.round((y - yMin) / hy)));
            return samples[j * (n + 1) + i] ?? NaN;
        };
    }

    // 单元采样(左/右/中端):每个单元一个样本值,按 floor 定位单元.
    // 容差用于把"落在网格节点上的查询点"吸附到它右侧的那个单元,
    // 否则该列/行会取到左邻单元的样本(可视化整体平移一格).
    const hx = (xMax - xMin) / n;
    const hy = (yMax - yMin) / m;
    return (x: number, y: number) => {
        const i = Math.max(0, Math.min(n - 1, Math.floor((x - xMin) / hx + CELL_EPSILON)));
        const j = Math.max(0, Math.min(m - 1, Math.floor((y - yMin) / hy + CELL_EPSILON)));
        return samples[j * n + i] ?? NaN;
    };
}
