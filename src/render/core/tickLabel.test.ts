import { describe, expect, it } from 'vitest';
import { formatTickLabel } from './tickLabel';

describe('formatTickLabel', () => {
    it('keeps plain numeric labels and trims float noise', () => {
        expect(formatTickLabel(0, false)).toBe('0');
        expect(formatTickLabel(3, false)).toBe('3');
        expect(formatTickLabel(-4, false)).toBe('-4');
        expect(formatTickLabel(0.1 + 0.2, false)).toBe('0.3');
        expect(formatTickLabel(-0, false)).toBe('0');
    });

    it('renders radian tick values as multiples of pi', () => {
        expect(formatTickLabel(Math.PI / 2, true)).toBe('π/2');
        expect(formatTickLabel(Math.PI, true)).toBe('π');
        expect(formatTickLabel((3 * Math.PI) / 2, true)).toBe('3π/2');
        expect(formatTickLabel(2 * Math.PI, true)).toBe('2π');
        expect(formatTickLabel(3 * Math.PI, true)).toBe('3π');
        expect(formatTickLabel(-Math.PI / 2, true)).toBe('-π/2');
        expect(formatTickLabel(0, true)).toBe('0');
    });

    it('handles thirds, quarters and values whose float rounding is not exact', () => {
        expect(formatTickLabel(Math.PI / 3, true)).toBe('π/3');
        expect(formatTickLabel(Math.PI / 4, true)).toBe('π/4');
        // 3 × (π/2) 这类乘法结果需要容差才能判定为 3π/2
        expect(formatTickLabel(3 * (Math.PI / 2), true)).toBe('3π/2');
        expect(formatTickLabel(6 * (Math.PI / 2), true)).toBe('3π');
    });

    it('falls back to the plain radian value when it is not a nice multiple of pi', () => {
        expect(formatTickLabel(1, true)).toBe('1');
        expect(formatTickLabel(0.7, true)).toBe('0.7');
        expect(formatTickLabel(-2.5, true)).toBe('-2.5');
    });
});
