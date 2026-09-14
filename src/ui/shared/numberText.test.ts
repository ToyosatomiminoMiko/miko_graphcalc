/**
 * 列表内纯文本数值格式化单测.
 *
 * 锁的是 `formatNumber` 的分档边界与去尾零正则:它在实体摘要里直接显示,
 * 1e-4 / 1e6 两个临界点和 `-0` 是唯一容易写错的地方
 * (`latexNumber.ts` 的 KaTeX 版本走另一套 `\times10^{n}` 口径,见其文件头).
 */
import { describe, expect, it } from 'vitest';
import { formatNumber, formatVector } from './numberText';

describe('formatNumber', () => {
    it('常规量级用定点并去掉尾零', () => {
        expect(formatNumber(1.5)).toBe('1.5');
        expect(formatNumber(4)).toBe('4');
        expect(formatNumber(0)).toBe('0');
        expect(formatNumber(123456.789)).toBe('123456.789');
    });

    it('负零输出为 "0"', () => {
        expect(formatNumber(-0)).toBe('0');
    });

    it('1e-4 与 1e6 是开区间边界,恰好落在边界上仍走定点', () => {
        expect(formatNumber(1e-4)).toBe('0.0001');
        expect(formatNumber(999999)).toBe('999999');
        expect(formatNumber(1e6)).toBe('1.000000e+6');
    });

    it('超出量级回退科学计数法', () => {
        expect(formatNumber(2.775558e-17)).toBe('2.775558e-17');
        expect(formatNumber(-1.25e7)).toBe('-1.250000e+7');
    });

    it('非有限值原样返回字符串', () => {
        expect(formatNumber(Number.NaN)).toBe('NaN');
        expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('Infinity');
    });
});

describe('formatVector', () => {
    it('按逗号加空格连接', () => {
        expect(formatVector([1, 2.5, -0])).toBe('[1, 2.5, 0]');
    });

    it('空数组给空方括号', () => {
        expect(formatVector([])).toBe('[]');
    });
});
