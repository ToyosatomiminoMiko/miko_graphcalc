/**
 * 求值条目 LaTeX 拼装单测.
 *
 * 这里不测 DOM,只锁定"摘要行放什么,细节行放什么":
 * - 摘要必须自带关键量(折叠状态下列表仍然可读);
 * - 细节包含完整信息(P / 球坐标回显 / 逐分量结果 / 积分域与方法);
 * - 被积对象缺失时积分摘要返回 null,让 UI 明确回退纯文本而不是给半个公式.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
    AnalysisResult,
    IntegralTask,
    SceneObject,
} from '../ir/types';

/**
 * 表达式 -> LaTeX 由 Rust 符号引擎负责(真机上是 wasm),展示层测试只需要
 * 一个恒等实现:本文件断言的是"拼装"顺序与内容,不是 Rust 的排版规则.
 */
vi.mock('../../wasm/math_rs/math_rs', () => ({
    latex_expression: vi.fn((expr: string) => expr),
    normalize_expression: vi.fn((expr: string) => expr),
}));

import {
    analysisLatexDetails,
    analysisLatexSummary,
    integralLatexDetails,
    integralLatexSummary,
    intersectionLatexDetails,
    intersectionLatexSummary,
    type EvaluationDetailLine,
} from './evaluationLatex';

function analysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
    return {
        name: 'g',
        op: 'gradient',
        point: [1, 2, 3],
        vector: [0.267261, 0.534522, 0.801784],
        tangent: null,
        scalar: 4,
        show: ['point', 'normal'],
        enabled: true,
        ...overrides,
    };
}

const curve: SceneObject = {
    kind: 'curve',
    id: 1,
    name: 'c',
    expr: 'x^2',
    coefficients: [],
    color: '#ffffff',
    enabled: true,
};

function integral(overrides: Partial<IntegralTask> = {}): IntegralTask {
    return {
        name: 'I',
        objectId: 1,
        sourceKind: 'curve',
        dim: 1,
        domainKind: 'interval',
        method: 'riemann:left',
        integrand: 'x^2',
        integrandCoefficients: [],
        countCoefficients: [],
        range: [-4, 4],
        segments: 32,
        layers: 8,
        show: true,
        enabled: true,
        ...overrides,
    };
}

describe('analysisLatexSummary', () => {
    it('折叠态只给"算子在哪个点",数值留给展开细节', () => {
        const summary = analysisLatexSummary(analysis());
        expect(summary).toContain('\\nabla f');
        expect(summary).toContain('\\left(1,\\ 2,\\ 3\\right)');
        // 同一行不重复出现算子与数值结果.
        expect(summary).not.toContain('=');
    });

    it('散度/旋度用各自算子', () => {
        expect(analysisLatexSummary(analysis({ op: 'divergence', scalar: 0.5 })))
            .toContain('\\nabla\\cdot\\mathbf{F}');
        expect(analysisLatexSummary(analysis({ op: 'curl' })))
            .toContain('\\nabla\\times\\mathbf{F}');
    });
});

/** 细节行 -> LaTeX 文本数组;公式行取 latex,文本行原样取 text. */
function detailTexts(lines: EvaluationDetailLine[]): string[] {
    return lines.map((line) => (line.kind === 'latex' ? line.latex : line.text));
}

describe('analysisLatexDetails', () => {
    const symbolic = '\\nabla f=\\left(2 x,\\ 2 y,\\ 2 z\\right)';

    it('梯度先展开算子的符号定义,再给该点的数值结果', () => {
        const lines = detailTexts(analysisLatexDetails(
            analysis({ symbolic, pointSpherical: [3.741657, 0.640522, 1.107149] }),
        ));
        // 中间步骤:符号定义在前,数值结果紧随其后.
        expect(lines[0]).toBe(symbolic);
        expect(lines[1]).toBe(
            '\\nabla f\\left(P\\right)=\\left(0.267261,\\ 0.534522,\\ 0.801784\\right)',
        );
        expect(lines[2]).toBe('P=\\left(1,\\ 2,\\ 3\\right)');
        expect(lines.some((line) => line.includes('\\left(r,\\theta,\\varphi\\right)'))).toBe(true);
        expect(lines.some((line) => line.includes('f\\left(P\\right)=4'))).toBe(true);
    });

    it('没有符号定义时不编造中间步骤', () => {
        const lines = detailTexts(analysisLatexDetails(analysis()));
        expect(lines[0]).toContain('\\nabla f\\left(P\\right)=');
        expect(lines.some((line) => line.includes('\\varphi'))).toBe(false);
    });

    it('切线只在有值时出', () => {
        const withTangent = detailTexts(analysisLatexDetails(analysis({ tangent: [1, 2, 0] })));
        expect(withTangent.some((line) => line.startsWith('\\mathbf{T}='))).toBe(true);
    });
});

describe('integralLatex', () => {
    it('摘要只给积分式本身,不接等号(数值在结果行/细节里排成完整等式)', () => {
        expect(integralLatexSummary(integral(), [curve]))
            .toBe('\\int_{-4}^{4} x^2 \\mathrm{d}x');
    });

    it('找不到被积对象时返回 null', () => {
        expect(integralLatexSummary(integral({ objectId: 9 }), [curve])).toBeNull();
    });

    it('细节第一行是完整等式,域/方法/分段/分层是纯文本', () => {
        const pending = integralLatexDetails(integral(), [curve], '黎曼和(左端点)');
        expect(pending[0]).toEqual({
            kind: 'latex',
            latex: '\\int_{-4}^{4} x^2 \\mathrm{d}x',
        });
        // 元信息不走 KaTeX:整行是纯文本,没有 `\\text{}` 包裹.
        expect(pending[1]).toMatchObject({ kind: 'text' });
        expect((pending[1] as { text: string }).text).toBe('域: c · 方法: 黎曼和(左端点)');
        expect((pending[1] as { text: string }).text).not.toContain('\\text');
        expect((pending[2] as { text: string }).text).toBe('分段: 32 · 分层: 8');

        const ready = integralLatexDetails(
            integral(),
            [curve],
            '黎曼和(左端点)',
            -2.775558e-17,
        );
        expect(ready[0]).toEqual({
            kind: 'latex',
            latex: '\\int_{-4}^{4} x^2 \\mathrm{d}x=-2.775558\\times10^{-17}',
        });
    });
});

describe('intersectionLatex', () => {
    const task = {
        name: 'X',
        aName: 'c1',
        bName: 's1',
        aId: 1,
        bId: 2,
        segments: 128,
    };

    it('摘要只给两个源对象(交点数量是异步结果)', () => {
        expect(intersectionLatexSummary(task)).toBe('c1\\cap s1');
    });

    it('细节给出对象 id(公式)与采样分段(纯文本)', () => {
        const lines = intersectionLatexDetails(task);
        expect(lines[0]).toEqual({
            kind: 'latex',
            latex: 'A=c1\\ \\left(\\#1\\right)\\quad B=s1\\ \\left(\\#2\\right)',
        });
        expect(lines[1]).toEqual({ kind: 'text', text: '采样分段: 128' });
    });
});
