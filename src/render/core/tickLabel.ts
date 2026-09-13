/**
 * 坐标轴刻度数字的文本格式化.
 *
 * 抽成纯函数,便于在不依赖 DOM/WebGL 的情况下单测(SceneManager 只负责
 * 把结果画到 Sprite 上).
 *
 * - 普通模式:直接显示刻度值,裁掉浮点步进累加产生的尾数;
 * - π 单位模式:刻度值本身是坐标值,标签显示"它相当于多少个 π"
 *   (刻度按 π/2 布置,于是 π/2 -> π/2,π -> π,3π/2 -> 3π/2);
 *   不是 π 的简单分数倍时退回普通数值,不做会让读者误解的近似.
 */

/** 允许出现在 π 分数系数里的分母,按优先顺序尝试(越靠前越优先). */
const PI_FRACTION_DENOMINATORS = [1, 2, 3, 4, 6, 8, 12] as const;

/** 判定"接近整数"的相对容差. */
const FRACTION_EPSILON = 1e-9;

/** 普通模式保留的小数位数,避免 0.30000000000000004 之类的噪声. */
const DECIMAL_DIGITS = 6;

/** 格式化一个刻度数字. */
export function formatTickLabel(value: number, piUnit: boolean): string {
    if (!Number.isFinite(value)) return String(value);
    return piUnit ? formatPiTickLabel(value) : formatNumberTickLabel(value);
}

/** π 单位模式:把坐标值表达为 π 的整数/简单分数倍. */
export function formatPiTickLabel(value: number): string {
    if (value === 0) return '0';

    const sign = value < 0 ? '-' : '';
    const magnitude = Math.abs(value);
    // 以 π 为单位的系数:坐标值 π/2 对应 1/2 个 π.
    const fraction = formatPiFraction(magnitude / Math.PI);
    if (fraction) return `${sign}${fraction}`;

    return `${sign}${formatNumberTickLabel(magnitude)}`;
}

/** 普通数值模式:四舍五入到固定小数位后去掉多余的 0. */
function formatNumberTickLabel(value: number): string {
    const rounded = Number(value.toFixed(DECIMAL_DIGITS));
    return Object.is(rounded, -0) ? '0' : String(rounded);
}

/**
 * 把"π 的系数"写成 π 的整数或简单分数倍.
 * 无法用配置的分母表示时返回 null(退回普通数值).
 */
function formatPiFraction(coefficient: number): string | null {
    if (!Number.isFinite(coefficient) || coefficient <= 0) return null;

    for (const denominator of PI_FRACTION_DENOMINATORS) {
        const scaled = coefficient * denominator;
        const numerator = Math.round(scaled);
        if (numerator < 1) continue;
        const tolerance = FRACTION_EPSILON * Math.max(1, Math.abs(scaled));
        if (Math.abs(scaled - numerator) > tolerance) continue;
        return formatPiFractionText(numerator, denominator);
    }
    return null;
}

/** 组装 "π" / "2π" / "π/2" / "3π/2" 形式的文本. */
function formatPiFractionText(numerator: number, denominator: number): string {
    const withPi = numerator === 1 ? 'π' : `${numerator}π`;
    return denominator === 1 ? withPi : `${withPi}/${denominator}`;
}
