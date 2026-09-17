/**
 * 过程数据源单测:角色 -> 展示分区(kind/reason)的映射与截断.
 *
 * 断言的是"哪一步算什么依据",不是排版:公式由 `evaluationLatex` 拼装,
 * 这里只验证分区口径与顺序,公式内容只做存在性检查(避免把数学排版锁死成
 * 快照,公式调整时这里不该失败).
 */
import { describe, expect, it } from 'vitest';
import type {
    AnalysisResult,
    IntegralTask,
    OdeTask,
    SceneObject,
    SolveTask,
} from '../../contract/ir';
import {
    buildGradientProcess,
    buildIntegralProcess,
    buildOdeProcess,
    buildSolveProcess,
} from './processData';

const curve: SceneObject = {
    kind: 'curve',
    id: 1,
    name: 'c1',
    expr: 'sin(x*a)*cos(x*b)',
    coefficients: [],
    color: '#ffffff',
    enabled: true,
};

const gradient: AnalysisResult = {
    name: 'g',
    op: 'gradient',
    point: [1, 2, 3],
    symbolic: '\\nabla f=(a,\\ b,\\ c)',
    vector: [0.1, 0.2, 0.3],
    tangent: null,
    scalar: 4,
    show: ['point', 'normal'],
    enabled: true,
};

const integral: IntegralTask = {
    name: 'I',
    objectId: 1,
    sourceKind: 'curve',
    dim: 1,
    domainKind: 'interval',
    method: 'riemann:mid',
    integrand: 'sin(x*a)*cos(x*b)',
    integrandCoefficients: [],
    countCoefficients: [],
    range: [-4, 4],
    segments: 32,
    layers: 32,
    show: true,
    enabled: true,
};

describe('buildGradientProcess', () => {
    it('按细节行顺序分区:定义式 / 数值代入 / 取点 / 函数值', () => {
        const process = buildGradientProcess(gradient);

        expect(process.title).toBe('梯度 g');
        expect(process.droppedSteps).toBeNull();
        expect(process.steps.map((step) => step.reason)).toEqual([
            '算子定义式',
            '数值代入',
            '代入取点',
            '函数值',
        ]);
        expect(process.steps.map((step) => step.kind)).toEqual([
            'definition',
            'numeric',
            'algebra',
            'numeric',
        ]);
        expect(process.steps[0].latex).toContain('\\nabla f');
        expect(process.steps[2].latex).toContain('P=');
    });

    it('带球坐标回显与切向量时,回显与切向量各成一步', () => {
        const process = buildGradientProcess({
            ...gradient,
            pointSpherical: [2, 0.9, 0.6],
            tangent: [0, 0, 1],
        });

        expect(process.steps).toHaveLength(6);
        expect(process.steps.map((step) => step.reason)).toContain('球坐标回显');
        expect(process.steps.map((step) => step.reason)).toContain('切向量');
    });

    it('超过上限时截断并给出丢弃步数', () => {
        const process = buildGradientProcess(
            { ...gradient, pointSpherical: [2, 0.9, 0.6], tangent: [0, 0, 1] },
            2,
        );

        expect(process.steps).toHaveLength(2);
        expect(process.droppedSteps).toBe(4);
    });
});

describe('buildIntegralProcess', () => {
    it('只产出"积分式 = 数值"这一步(不编造中间步骤)', () => {
        const process = buildIntegralProcess(integral, [curve], '黎曼和(中点)', 1.5);

        expect(process.title).toBe('积分 I');
        expect(process.steps).toHaveLength(1);
        expect(process.steps[0].kind).toBe('definition');
        expect(process.steps[0].reason).toBe('积分定义式');
        expect(process.steps[0].latex).toContain('=1.5');
    });

    it('数值未回填时等式省略右端', () => {
        const process = buildIntegralProcess(integral, [curve], '黎曼和(中点)', null);

        expect(process.steps).toHaveLength(1);
        expect(process.steps[0].latex).not.toContain('=1.5');
    });

    it('被积对象已删除(排不出公式)时没有可展示的步骤', () => {
        const process = buildIntegralProcess(integral, [], '黎曼和(中点)', 1.5);

        expect(process.steps).toHaveLength(0);
        expect(process.droppedSteps).toBeNull();
    });
});

describe('题目(problem)与求解过程', () => {
    it('梯度与积分过程带上题目,过程页先显示"在算什么"', () => {
        expect(buildGradientProcess(gradient).problem).toContain('\\nabla f');
        expect(buildIntegralProcess(integral, [curve], '黎曼和(中点)', 1.5).problem)
            .toContain('\\int');
    });

    const solve: SolveTask = {
        name: 'S',
        method: 'exact',
        unknowns: ['x'],
        equations: ['x^2 - 5*x + 6 = 0'],
        equationLatex: 'x^{2}-5x+6=0',
        solutionLatex: 'x = 2 \\quad\\text{或}\\quad x = 3',
        realRootCount: 2,
        identity: false,
        steps: [
            { latex: 'x^{2}-5x+6=0', reason: '原式', kind: 'definition' },
            { latex: '\\left(x - 2\\right)\\left(x - 3\\right) = 0', reason: '因式分解', kind: 'algebra' },
            { latex: 'x - 2 = 0 \\quad\\text{或}\\quad x - 3 = 0', reason: '零积律', kind: 'rule' },
        ],
        error: null,
        enabled: true,
    };

    it('求解过程:题目就是待求解方程,步骤原样来自内核产物', () => {
        const process = buildSolveProcess(solve);

        expect(process.title).toBe('求解 S');
        expect(process.problem).toBe('x^{2}-5x+6=0');
        expect(process.steps.map((step) => step.reason)).toEqual([
            '原式',
            '因式分解',
            '零积律',
        ]);
        expect(process.steps.map((step) => step.kind)).toEqual([
            'definition',
            'algebra',
            'rule',
        ]);
        expect(process.droppedSteps).toBeNull();
    });

    it('求解步骤同样受上限约束(三期数据源不绕过截断)', () => {
        const process = buildSolveProcess(solve, 2);

        expect(process.steps).toHaveLength(2);
        expect(process.droppedSteps).toBe(1);
    });

    it('隐藏/拒绝的求解没有题目,题目区留空而不显示半个式子', () => {
        const hidden = buildSolveProcess({ ...solve, enabled: false, equationLatex: '', steps: [] });

        expect(hidden.problem).toBeNull();
        expect(hidden.steps).toEqual([]);
    });

    const ode: OdeTask = {
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
            { latex: '\\frac{1}{y}\\,\\mathrm{d}y=x\\,\\mathrm{d}x', reason: '分离变量', kind: 'algebra' },
            { latex: 'y=C\\,e^{x^{2}/2}', reason: '解出通解', kind: 'algebra' },
            { latex: "y'=x\\,y", reason: '回代验证:代回原方程', kind: 'check' },
        ],
        error: null,
        enabled: true,
    };

    it('微分方程过程:题目是原方程,步骤原样来自 ODE 内核产物', () => {
        const process = buildOdeProcess(ode);

        expect(process.title).toBe('微分方程 O1');
        expect(process.problem).toBe("y'=x\\,y");
        expect(process.steps.map((step) => step.reason)).toEqual([
            '分离变量',
            '解出通解',
            '回代验证:代回原方程',
        ]);
        expect(process.steps.map((step) => step.kind)).toEqual([
            'algebra',
            'algebra',
            'check',
        ]);
        expect(process.droppedSteps).toBeNull();
    });

    it('微分方程步骤同样受上限约束(长步骤链不绕过截断)', () => {
        const process = buildOdeProcess(ode, 2);

        expect(process.steps).toHaveLength(2);
        expect(process.droppedSteps).toBe(1);
        // 最后一步(回代验证)是凭据:默认上限下必须在场.
        expect(buildOdeProcess(ode).steps[2].reason).toBe('回代验证:代回原方程');
    });

    it('隐藏/拒绝的微分方程没有题目,题目区留空', () => {
        const hidden = buildOdeProcess({
            ...ode,
            enabled: false,
            equationLatex: '',
            steps: [],
        });

        expect(hidden.problem).toBeNull();
        expect(hidden.steps).toEqual([]);
    });
});
