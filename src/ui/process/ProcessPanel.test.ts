/**
 * 过程页视图单测(最小 DOM 桩 + KaTeX 假实现,不引 jsdom).
 *
 * 锁的是视图自己的不变量:
 * - 空过程给明文,不给空盒子;超长过程截断并注明;
 * - 一行一步(序号 + 公式 + 依据徽章),行按指纹复用(重建时同内容行不被替换);
 * - 页头元信息与参数只读回显各走各的刷新入口.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomStub, type StubElement } from '@/testing/domStub';

vi.mock('katex', () => ({
    default: {
        render: (tex: string, element: { textContent: string }) => {
            element.textContent = tex;
        },
    },
}));
vi.mock('katex/dist/katex.min.css', () => ({}));

import { ProcessPanel, formatProcessParamEcho } from './ProcessPanel';
import type { ProcessDocument, ProcessStep } from './processSteps';

function step(latex: string, reason: string): ProcessStep {
    return { latex, kind: 'numeric', reason };
}

function document(steps: ProcessStep[], droppedSteps: number | null = null): ProcessDocument {
    return { title: '梯度 g', steps, droppedSteps };
}

const THREE_STEPS = [step('a=1', '数值代入'), step('b=2', '代入取点'), step('c=3', '函数值')];

function setup(options: {
    getParamEcho?: () => string;
} = {}): { stub: ReturnType<typeof installDomStub>; root: StubElement; panel: ProcessPanel } {
    const stub = installDomStub();
    const root = stub.document.createElement('section');
    stub.document.body.append(root);
    const panel = new ProcessPanel(root as unknown as HTMLElement, options);
    return { stub, root, panel };
}

beforeEach(() => {
    installDomStub();
});

describe('空状态', () => {
    it('没有可展示的过程时给一句明文,并收起步骤容器', () => {
        const { root } = setup();

        const empty = root.querySelector<StubElement>('.process-empty')!;
        expect(empty.textContent).toBe('该对象没有可展开的过程');
        expect(empty.getAttribute('hidden')).toBeNull();
        expect(root.querySelector<StubElement>('.process-steps')!.getAttribute('hidden')).toBe('');
    });

    it('clear() 回到空状态明文,不留上一条的标题与步骤', () => {
        const { root, panel } = setup();
        panel.show(document(THREE_STEPS));
        panel.clear();

        expect(root.querySelector<StubElement>('.process-title')!.textContent).toBe('过程');
        expect(root.querySelectorAll<StubElement>('.process-step')).toHaveLength(0);
        expect(root.querySelector<StubElement>('.process-empty')!.getAttribute('hidden')).toBeNull();
    });
});

describe('渲染', () => {
    it('一行一步:序号 + KaTeX + 依据徽章', () => {
        const { root, panel } = setup();

        panel.show(document(THREE_STEPS));

        const rows = root.querySelectorAll<StubElement>('.process-step');
        expect(rows).toHaveLength(3);
        expect(rows[0].querySelector<StubElement>('.process-step-index')!.textContent).toBe('1');
        expect(rows[0].querySelector<StubElement>('.process-step-formula')!.textContent).toBe('a=1');
        expect(rows[0].querySelector<StubElement>('.process-step-reason')!.textContent).toBe('数值代入');
        expect(rows[2].querySelector<StubElement>('.process-step-index')!.textContent).toBe('3');

        expect(root.querySelector<StubElement>('.process-title')!.textContent).toBe('梯度 g');
    });

    it('依据图例按 kind 汇总,顺序取规范顺序', () => {
        const { root, panel } = setup();
        panel.show(document([
            { latex: 'a', kind: 'definition', reason: '算子定义式' },
            { latex: 'b', kind: 'numeric', reason: '数值代入' },
            { latex: 'c', kind: 'numeric', reason: '函数值' },
        ]));

        expect(root.querySelector<StubElement>('.process-legend')!.textContent)
            .toBe('定义 1 · 数值 2');
    });

    it('超长过程截断并注明还有多少步未显示', () => {
        const { root, panel } = setup();
        panel.show(document(THREE_STEPS, 9));

        const note = root.querySelector<StubElement>('.process-truncated')!;
        expect(note.getAttribute('hidden')).toBeNull();
        expect(note.textContent).toContain('9');
    });

    it('未截断时不显示截断明文', () => {
        const { root, panel } = setup();
        panel.show(document(THREE_STEPS));

        expect(root.querySelector<StubElement>('.process-truncated')!.getAttribute('hidden')).toBe('');
    });

    it('参数只读回显:有值才显示,换成空值则收起', () => {
        let echo = 'a=1 · b=2';
        const { root, panel } = setup({ getParamEcho: () => echo });

        panel.show(document(THREE_STEPS));
        const element = root.querySelector<StubElement>('.process-param-echo')!;
        expect(element.textContent).toBe('a=1 · b=2');
        expect(element.getAttribute('hidden')).toBeNull();

        echo = '';
        panel.refreshEcho();
        expect(element.getAttribute('hidden')).toBe('');
    });

    it('refreshEcho() 只换回显文本,不动步骤行', () => {
        let echo = 'a=1';
        const { root, panel } = setup({ getParamEcho: () => echo });
        panel.show(document(THREE_STEPS));
        const row = root.querySelectorAll<StubElement>('.process-step')[0];

        echo = 'a=2';
        panel.refreshEcho();

        expect(root.querySelector<StubElement>('.process-param-echo')!.textContent).toBe('a=2');
        expect(root.querySelectorAll<StubElement>('.process-step')[0]).toBe(row);
    });
});

describe('行复用', () => {
    it('同内容步骤在重渲染时复用行(不重建)', () => {
        const { root, panel } = setup();
        panel.show(document(THREE_STEPS));
        const before = root.querySelectorAll<StubElement>('.process-step')[1];

        // 同一条过程再载入一次:指纹一致 -> 行被复用,不是新节点.
        panel.show(document(THREE_STEPS));

        expect(root.querySelectorAll<StubElement>('.process-step')[1]).toBe(before);
    });
});

describe('formatProcessParamEcho', () => {
    it('按 a=1 · b=2 拼接;没有参数时给空串', () => {
        expect(formatProcessParamEcho({ a: 1, b: 2 })).toBe('a=1 · b=2');
        expect(formatProcessParamEcho({})).toBe('');
    });
});

describe('题目区', () => {
    it('有题目时排在步骤之前显示,可复制 TeX', () => {
        const { root, panel } = setup();
        panel.show({
            title: '求解 S',
            problem: 'x^{2}-5x+6=0',
            steps: THREE_STEPS,
            droppedSteps: null,
        });

        const problem = root.querySelector<StubElement>('.process-problem')!;
        expect(problem.getAttribute('hidden')).toBeNull();
        const formula = problem.querySelector<StubElement>('.process-problem-formula')!;
        expect(formula.textContent).toBe('x^{2}-5x+6=0');
        // 题目是数学内容,与其它公式一样可点击复制.
        expect(formula.dataset.tex).toBe('x^{2}-5x+6=0');
    });

    it('没有题目时整块收起;clear() 后也保持收起', () => {
        const { root, panel } = setup();
        panel.show({
            title: '梯度 g',
            steps: THREE_STEPS,
            droppedSteps: null,
        });
        expect(root.querySelector<StubElement>('.process-problem')!.getAttribute('hidden'))
            .toBe('');

        panel.show({
            title: '求解 S',
            problem: 'x=1',
            steps: THREE_STEPS,
            droppedSteps: null,
        });
        expect(root.querySelector<StubElement>('.process-problem')!.getAttribute('hidden'))
            .toBeNull();

        panel.clear();
        expect(root.querySelector<StubElement>('.process-problem')!.getAttribute('hidden'))
            .toBe('');
        expect(root.querySelector<StubElement>('.process-problem')!.children).toHaveLength(0);
    });
});
