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
    OdeTask,
    SceneObject,
} from '../../ir';

/**
 * 表达式 -> LaTeX 由 Rust 符号引擎负责(真机上是 wasm),展示层测试只需要
 * 一个恒等实现:本文件断言的是"拼装"顺序与内容,不是 Rust 的排版规则.
 */
vi.mock('../../wasm/math_rs/math_rs', () => ({
    latex_expression: vi.fn((expr: string) => expr),
    normalize_expression: vi.fn((expr: string) => expr),
}));

import {
    analysisLatexDetailEntries,
    analysisLatexSummary,
    detailLinesOf,
    integralLatexDetailEntries,
    integralLatexSummary,
    intersectionLatexDetails,
    intersectionLatexSummary,
    odeLatexDetailEntries,
    odeLatexSummary,
    type EvaluationDetailEntry,
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

    it('拉普拉斯是标量算子,摘要直接给算子与数值', () => {
        const summary = analysisLatexSummary(analysis({
            op: 'laplacian',
            symbolic: '\\nabla^2 f=2+2',
            scalar: 4,
        }));
        expect(summary).toBe('\\nabla^{2}f\\left(\\left(1,\\ 2,\\ 3\\right)\\right)=4');
    });
});

/** 细节行 -> LaTeX 文本数组;公式行取 latex,文本行原样取 text. */
function detailTexts(lines: EvaluationDetailLine[]): string[] {
    return lines.map((line) => (line.kind === 'latex' ? line.latex : line.text));
}

describe('analysisLatexDetailEntries', () => {
    const symbolic = '\\nabla f=\\left(2 x,\\ 2 y,\\ 2 z\\right)';

    it('梯度先展开算子的符号定义,再给该点的数值结果', () => {
        const lines = detailTexts(detailLinesOf(analysisLatexDetailEntries(
            analysis({ symbolic, pointSpherical: [3.741657, 0.640522, 1.107149] }),
        )));
        // 中间步骤:符号定义在前,数值结果紧随其后.
        expect(lines[0]).toBe(symbolic);
        expect(lines[1]).toBe(
            '\\nabla f\\left(P\\right)=\\left(0.267261,\\ 0.534522,\\ 0.801784\\right)',
        );
        expect(lines[2]).toBe('P=\\left(1,\\ 2,\\ 3\\right)');
        expect(lines.some((line) => line.includes('\\left(r,\\theta,\\varphi\\right)'))).toBe(true);
        expect(lines.some((line) => line.includes('f\\left(P\\right)=4'))).toBe(true);
    });

    it('每一行都带角色:公式与依据同源,调用方不必按位置猜', () => {
        const entries = analysisLatexDetailEntries(analysis({ symbolic }));

        expect(entries.map((entry) => entry.role)).toEqual([
            'symbolic',
            'value',
            'point',
            'scalar',
        ]);
        expect(entries[0].line).toEqual({ kind: 'latex', latex: symbolic });
    });

    it('没有符号定义时不编造中间步骤', () => {
        const lines = detailTexts(detailLinesOf(analysisLatexDetailEntries(analysis())));
        expect(lines[0]).toContain('\\nabla f\\left(P\\right)=');
        expect(lines.some((line) => line.includes('\\varphi'))).toBe(false);
    });

    it('切线只在有值时出', () => {
        const withTangent = detailTexts(
            detailLinesOf(analysisLatexDetailEntries(analysis({ tangent: [1, 2, 0] }))),
        );
        expect(withTangent.some((line) => line.startsWith('\\mathbf{T}='))).toBe(true);
    });

    it('拉普拉斯先展开二阶导符号式,再给该点的标量结果', () => {
        const symbolic = '\\nabla^2 f=2+2';
        const lines = detailTexts(detailLinesOf(analysisLatexDetailEntries(analysis({
            op: 'laplacian',
            symbolic,
            // 标量算子:向量恒零(渲染层据此不画箭矢).
            vector: [0, 0, 0],
            scalar: 4,
        }))));
        expect(lines[0]).toBe(symbolic);
        expect(lines[1]).toBe('\\left(\\nabla^{2}f\\right)\\left(P\\right)=4');
        expect(lines[2]).toBe('P=\\left(1,\\ 2,\\ 3\\right)');
        // 拉普拉斯没有 f(P)/切线的展示(symbolic 与数值两行已经完整).
        expect(lines.some((line) => line.startsWith('\\mathbf{T}='))).toBe(false);
        expect(lines.some((line) => line.startsWith('f\\left(P\\right)'))).toBe(false);
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

    it('积分细节带角色(equation/domain/sampling),只有等式进公式块', () => {
        const entries: EvaluationDetailEntry[] = integralLatexDetailEntries(
            integral(),
            [curve],
            '黎曼和(左端点)',
        );

        expect(entries.map((entry) => entry.role)).toEqual(['equation', 'domain', 'sampling']);
    });

    it('细节第一行是完整等式,域/方法/分段/分层是纯文本', () => {
        const pending = detailLinesOf(
            integralLatexDetailEntries(integral(), [curve], '黎曼和(左端点)'),
        );
        expect(pending[0]).toEqual({
            kind: 'latex',
            latex: '\\int_{-4}^{4} x^2 \\mathrm{d}x',
        });
        // 元信息不走 KaTeX:整行是纯文本,没有 `\\text{}` 包裹.
        expect(pending[1]).toMatchObject({ kind: 'text' });
        expect((pending[1] as { text: string }).text).toBe('域: c · 方法: 黎曼和(左端点)');
        expect((pending[1] as { text: string }).text).not.toContain('\\text');
        expect((pending[2] as { text: string }).text).toBe('分段: 32 · 分层: 8');

        const ready = detailLinesOf(integralLatexDetailEntries(
            integral(),
            [curve],
            '黎曼和(左端点)',
            -2.775558e-17,
        ));
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

/** 微分方程条目工厂:默认是一条解出显式通解的一阶方程. */
function ode(overrides: Partial<OdeTask> = {}): OdeTask {
    return {
        name: 'O1',
        equation: "y' = x*y",
        independent: 'x',
        dependent: 'y',
        order: 1,
        equationLatex: "y'=x\\,y",
        generalLatex: 'y=C\\,e^{x^{2}/2}',
        particularLatex: null,
        initialConditions: [],
        implicit: false,
        slopeLatex: 'x\\,y',
        slopeObjectId: 2,
        curveNames: ['O1_c1'],
        notes: [],
        arbitraryConstantCount: 1,
        verified: true,
        steps: [
            { latex: 'y=C\\,e^{x^{2}/2}', reason: '解出通解', kind: 'algebra' },
            { latex: "y'=x\\,y", reason: '回代验证:代回原方程', kind: 'check' },
        ],
        error: null,
        enabled: true,
        ...overrides,
    };
}

describe('odeLatex', () => {
    it('摘要就是原方程,隐藏项回退纯文本由调用方处理', () => {
        expect(odeLatexSummary(ode())).toBe("y'=x\\,y");
        expect(odeLatexSummary(ode({ equationLatex: '' }))).toBeNull();
    });

    it('细节按"方程 -> 通解 -> 斜率场 -> 验证 -> 元信息"排列', () => {
        const entries = odeLatexDetailEntries(ode());
        expect(entries.map((entry) => entry.role)).toEqual([
            'equation',
            'general',
            'symbolic',
            'verified',
            'sampling',
        ]);
        expect(entries[1].line).toEqual({ kind: 'latex', latex: 'y=C\\,e^{x^{2}/2}' });
        // 斜率场写成 `z = f(x,y)`,与下发的 surface 实体同源.
        expect(entries[2].line).toEqual({ kind: 'latex', latex: 'z=x\\,y' });
        expect((entries[4].line as { text: string }).text).toContain('解曲线 1 条');
    });

    it('隐式解必须明确标注,并如实给出内核的说明', () => {
        const task = ode({
            implicit: true,
            generalLatex: '\\ln\\left|y\\right|=x+C',
            curveNames: [],
            notes: ['通解是隐式解(Φ(x,y) = C),不是 y = ... 的显式形式'],
        });
        const entries = odeLatexDetailEntries(task);
        const texts = entries
            .filter((entry) => entry.line.kind === 'text')
            .map((entry) => (entry.line as { text: string }).text);
        expect(texts.some((text) => text.includes('隐式解'))).toBe(true);
        expect(texts).toContain('通解是隐式解(Φ(x,y) = C),不是 y = ... 的显式形式');
        expect(texts.some((text) => text.includes('未下发解曲线'))).toBe(true);
    });

    it('能力边界:只给理由,不给半个通解', () => {
        const task = ode({
            error: '超出内核能力',
            generalLatex: null,
            slopeLatex: null,
            curveNames: [],
            verified: false,
        });
        const entries = odeLatexDetailEntries(task);
        expect(entries.map((entry) => entry.role)).toEqual(['equation', 'domain']);
        expect((entries[1].line as { text: string }).text).toBe('无法求解: 超出内核能力');
    });

    it('初值与特解:特解一行 + 初值回显一行', () => {
        const task = ode({
            initialConditions: ['y(0) = 1'],
            particularLatex: 'y=e^{x^{2}/2}',
        });
        const entries = odeLatexDetailEntries(task);
        expect(entries.some((entry) => entry.role === 'particular')).toBe(true);
        const texts = entries
            .filter((entry) => entry.line.kind === 'text')
            .map((entry) => (entry.line as { text: string }).text);
        expect(texts).toContain('初值: y(0) = 1');
    });
});
