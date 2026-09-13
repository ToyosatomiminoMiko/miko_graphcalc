/**
 * 数值 -> LaTeX 数字(结果展示用).
 *
 * 与 `latexNumberText`(对象公式里的区间端点等)分开的原因:那里要的是
 * "和 DSL 里写的一致"的字面量,这里要的是"屏幕上读得懂的结果"--
 * - 科学计数法不能直接交给 KaTeX:`2.775558e-17` 会被排成
 *   (斜体 e 与 17),这里转成 `2.775558\times10^{-17}`;
 * - 去掉小数点后多余的 0(`1.500000` -> `1.5`,`4.000000` -> `4`),数值
 *   结果才能与前后的公式等号对齐成 `∫f dx = 2.775558\times10^{-17}`.
 *
 * 非有限值(Infinity/NaN)没有可读的数学写法,原样返回字符串,由 KaTeX
 * 的 throwOnError=false 兜住排版失败.
 */
export function latexResultNumber(value: number): string {
    if (!Number.isFinite(value)) return String(value);
    if (value === 0) return '0';

    // 与 ui/numberText.ts 的 formatNumber 同一档位:常规大小用定点,
    // 超出 ±[1e-4, 1e6) 才用科学计数法,避免把 0.0001 写成 1e-4.
    const magnitude = Math.abs(value);
    if (magnitude < 1e-4 || magnitude >= 1e6) {
        const [mantissa, exponent] = value.toExponential(6).split('e');
        const trimmed = trimFraction(mantissa);
        const power = Number(exponent);
        return `${trimmed}\\times10^{${power}}`;
    }

    return trimFraction(value.toFixed(6));
}

/** 去掉定点/尾数小数点后多余的 0(`1.500000` -> `1.5`,`4.000000` -> `4`). */
function trimFraction(text: string): string {
    return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}
