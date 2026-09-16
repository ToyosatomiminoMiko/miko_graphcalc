/**
 * 过程页视图单测(最小 DOM 桩 + KaTeX 假实现,不引 jsdom).
 *
 * 锁的是视图自己的不变量:
 * - 空过程给明文,不给空盒子;超长过程截断并注明;
 * - 当前步高亮只改类名,行按指纹复用(重建时同内容行不被替换);
 * - 翻步走纯状态机,边界按钮置灰且不再发出口;
 * - 键盘绑定只在过程页激活时命中,焦点在编辑器/标签栏里时让位.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomStub, type StubElement } from '../../testing/domStub';

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
    onStepChange?: (index: number) => void;
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
    it('一行一步:序号 + KaTeX + 依据徽章,首行即当前步', () => {
        const changes: number[] = [];
        const { root, panel } = setup({ onStepChange: (index) => changes.push(index) });

        panel.show(document(THREE_STEPS));

        const rows = root.querySelectorAll<StubElement>('.process-step');
        expect(rows).toHaveLength(3);
        expect(rows[0].querySelector<StubElement>('.process-step-index')!.textContent).toBe('1');
        expect(rows[0].querySelector<StubElement>('.process-step-formula')!.textContent).toBe('a=1');
        expect(rows[0].querySelector<StubElement>('.process-step-reason')!.textContent).toBe('数值代入');
        expect(rows[0].classList.contains('is-current')).toBe(true);
        expect(rows[1].classList.contains('is-current')).toBe(false);
        expect(rows[0].getAttribute('aria-current')).toBe('step');
        expect(rows[1].getAttribute('aria-current')).toBeNull();

        expect(root.querySelector<StubElement>('.process-title')!.textContent).toBe('梯度 g');
        expect(root.querySelector<StubElement>('.process-counter')!.textContent).toBe('1 / 3');
        expect(changes).toEqual([0]);
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
        panel.goto(1);
        expect(element.getAttribute('hidden')).toBe('');
    });

    it('refreshEcho() 只换回显,不把当前步复位', () => {
        let echo = 'a=1';
        const { root, panel } = setup({ getParamEcho: () => echo });
        panel.show(document(THREE_STEPS));
        panel.goto(1);

        echo = 'a=2';
        panel.refreshEcho();

        expect(root.querySelector<StubElement>('.process-param-echo')!.textContent).toBe('a=2');
        expect(root.querySelector<StubElement>('.process-counter')!.textContent).toBe('2 / 3');
    });
});

describe('翻步', () => {
    it('next / prev 移动高亮与计数,并在出口播报', () => {
        const changes: number[] = [];
        const { root, panel } = setup({ onStepChange: (index) => changes.push(index) });
        panel.show(document(THREE_STEPS));

        panel.next();
        expect(root.querySelector<StubElement>('.process-counter')!.textContent).toBe('2 / 3');
        expect(
            root.querySelectorAll<StubElement>('.process-step')[1].classList.contains('is-current'),
        ).toBe(true);

        panel.prev();
        expect(root.querySelector<StubElement>('.process-counter')!.textContent).toBe('1 / 3');
        expect(changes).toEqual([0, 1, 0]);
    });

    it('边界上按钮置灰,继续翻是 no-op 且不再播报', () => {
        const changes: number[] = [];
        const { root, panel } = setup({ onStepChange: (index) => changes.push(index) });
        panel.show(document(THREE_STEPS));

        const prev = root.querySelector<StubElement>('.process-nav-btn')!;
        expect(prev.disabled).toBe(true);

        panel.prev();
        expect(changes).toEqual([0]);

        panel.goto(99);
        expect(changes).toEqual([0, 2]);
        const next = root.querySelectorAll<StubElement>('.process-nav-btn')[1];
        expect(next.disabled).toBe(true);

        panel.next();
        expect(changes).toEqual([0, 2]);
    });

    it('点击任意行跳转到该步', () => {
        const changes: number[] = [];
        const { root, panel } = setup({ onStepChange: (index) => changes.push(index) });
        panel.show(document(THREE_STEPS));

        root.querySelectorAll<StubElement>('.process-step')[2].dispatch('click');

        expect(changes).toEqual([0, 2]);
        expect(root.querySelector<StubElement>('.process-counter')!.textContent).toBe('3 / 3');
    });

    it('同内容步骤在重渲染时复用行(只改高亮,不重建)', () => {
        const { root, panel } = setup();
        panel.show(document(THREE_STEPS));
        const before = root.querySelectorAll<StubElement>('.process-step')[1];

        // 同一条过程再载入一次:指纹一致 -> 行被复用,不是新节点.
        panel.show(document(THREE_STEPS));

        expect(root.querySelectorAll<StubElement>('.process-step')[1]).toBe(before);
    });
});

describe('键盘绑定', () => {
    function createPanel(): {
        stub: ReturnType<typeof installDomStub>;
        root: StubElement;
        panel: ProcessPanel;
    } {
        const stub = installDomStub();
        const root = stub.document.createElement('section');
        stub.document.body.append(root);
        return { stub, root, panel: new ProcessPanel(root as unknown as HTMLElement) };
    }

    it('过程页未激活时不接管方向键', () => {
        const { panel } = createPanel();
        panel.show(document(THREE_STEPS));
        const binding = panel.keyboardBinding(() => false);

        expect(binding.resolve({
            key: 'ArrowRight',
            target: null,
        } as unknown as KeyboardEvent)).toBeNull();
    });

    it('没有载入过程时方向键不接管', () => {
        const { stub, panel } = createPanel();
        const binding = panel.keyboardBinding(() => true);

        expect(binding.resolve({
            key: 'ArrowRight',
            target: stub.document.body,
        } as unknown as KeyboardEvent)).toBeNull();
    });

    it('激活时左右方向键翻步', () => {
        const { stub, root, panel } = createPanel();
        panel.show(document(THREE_STEPS));
        const binding = panel.keyboardBinding(() => true);

        const right = binding.resolve({
            key: 'ArrowRight',
            target: stub.document.body,
        } as unknown as KeyboardEvent);
        expect(typeof right).toBe('function');
        right?.();
        expect(root.querySelector<StubElement>('.process-counter')!.textContent).toBe('2 / 3');

        const left = binding.resolve({
            key: 'ArrowLeft',
            target: stub.document.body,
        } as unknown as KeyboardEvent);
        left?.();
        expect(root.querySelector<StubElement>('.process-counter')!.textContent).toBe('1 / 3');
    });

    it('焦点在输入控件或标签栏里时让位', () => {
        const { stub, panel } = createPanel();
        panel.show(document(THREE_STEPS));
        const binding = panel.keyboardBinding(() => true);

        const textarea = stub.document.createElement('textarea');
        expect(binding.resolve({
            key: 'ArrowLeft',
            target: textarea,
        } as unknown as KeyboardEvent)).toBeNull();

        const tablist = stub.document.createElement('div');
        tablist.setAttribute('role', 'tablist');
        expect(binding.resolve({
            key: 'ArrowLeft',
            target: tablist,
        } as unknown as KeyboardEvent)).toBeNull();
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
