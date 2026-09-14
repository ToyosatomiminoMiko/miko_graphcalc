/**
 * 列表里的数值/向量纯文本格式化.
 *
 * 与 `math/latexNumber.ts` 分工:那边产出 KaTeX 数字(科学计数法排版),
 * 这里产出**纯文本**回退(实体摘要,积分式排不出来时的数值落点).
 * 两处口径刻意不同:LaTeX 走 `\times10^{n}`,纯文本走 `e+n`.
 */

/** 数值 -> 紧凑纯文本(定点优先,超出量级回退科学计数法). */
export function formatNumber(value: number): string {
    if (!Number.isFinite(value)) return String(value);
    const magnitude = Math.abs(value);
    if ((magnitude >= 1e-4 && magnitude < 1e6) || value === 0) {
        return value
            .toFixed(6)
            .replace(/\.?0+$/, '');
    }
    return value.toExponential(6);
}

/** 数值数组 -> `[1, 2, 3]`. */
export function formatVector(value: readonly number[]): string {
    return `[${value.map((item) => formatNumber(item)).join(', ')}]`;
}
