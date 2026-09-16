/**
 * 三级披露判据单测:边界(恰好等于阈值)归 L1,严格大于才进 L2.
 */
import { describe, expect, it } from 'vitest';
import { UI_CONFIG } from '../../config/uiConfig';
import type { EvaluationDetailLine } from '../../compiler/dsl/evaluationLatex';
import { needsProcessPage } from './disclosure';

function lines(count: number): EvaluationDetailLine[] {
    return Array.from(
        { length: count },
        (_, index) => ({ kind: 'latex', latex: `x_{${index}}` }) as const,
    );
}

describe('needsProcessPage', () => {
    it('恰好等于默认阈值仍留在 L1(≤ N 行是 L1 的预算)', () => {
        expect(needsProcessPage(lines(UI_CONFIG.process.disclosureThreshold))).toBe(false);
    });

    it('超过默认阈值一格就进 L2', () => {
        expect(needsProcessPage(lines(UI_CONFIG.process.disclosureThreshold + 1))).toBe(true);
    });

    it('空过程留在 L1(短过程零改动)', () => {
        expect(needsProcessPage([])).toBe(false);
    });

    it('阈值可显式传入(单测与将来的实测调参)', () => {
        expect(needsProcessPage(lines(3), 2)).toBe(true);
        expect(needsProcessPage(lines(2), 2)).toBe(false);
    });
});
