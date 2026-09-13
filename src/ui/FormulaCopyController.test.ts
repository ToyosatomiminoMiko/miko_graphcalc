/**
 * 公式复制控制器单测(UI-P3.6).
 *
 * 复制必须有键盘入口:可复制公式由 FormulaView 加了 `tabindex`/`role`,
 * 本控制器同时处理 click 与 Enter/Space.这里在 node 里走 legacy 剪贴板回退
 * (`window.isSecureContext = false` + `document.execCommand`),覆盖成功/失败
 * 两条回显路径与"非公式目标不响应".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomStub, type DomStub, type StubElement } from '../test/domStub';
import { FormulaCopyController } from './FormulaCopyController';

interface Harness {
    readonly stub: DomStub;
    readonly controller: FormulaCopyController;
    readonly hint: StubElement;
    readonly root: StubElement;
    readonly formula: StubElement;
}

function setup(): Harness {
    const stub = installDomStub();
    const hint = stub.document.createElement('span');
    hint.textContent = '点击公式复制 TeX';

    const root = stub.document.createElement('div');
    const formula = stub.document.createElement('span');
    formula.setAttribute('data-tex', 'x^2');
    root.append(formula);
    stub.document.body.append(root);

    const controller = new FormulaCopyController(hint as unknown as HTMLElement);
    controller.bind(root as unknown as HTMLElement);
    return { stub, controller, hint, root, formula };
}

beforeEach(() => {
    installDomStub();
});

describe('鼠标与键盘两条复制入口(UI-P3.6)', () => {
    it('点击公式复制 TeX 并回显成功', async () => {
        const { stub, controller, hint, root, formula } = setup();

        // 事件委托:监听在 root 上,目标是公式(桩不冒泡,显式带上 target).
        root.dispatch('click', { target: formula });

        await vi.waitFor(() => {
            expect(stub.execCommand.calls).toEqual(['copy']);
            expect(hint.textContent).toBe('已复制 TeX');
        });
        expect(hint.classList.contains('is-copied')).toBe(true);
        controller.dispose();
    });

    it('Enter 激活复制并阻止默认行为', async () => {
        const { stub, controller, hint, root, formula } = setup();
        const preventDefault = vi.fn();

        root.dispatch('keydown', {
            key: 'Enter',
            target: formula,
            preventDefault,
        });

        await vi.waitFor(() => {
            expect(stub.execCommand.calls).toEqual(['copy']);
            expect(hint.textContent).toBe('已复制 TeX');
        });
        expect(preventDefault).toHaveBeenCalledTimes(1);
        controller.dispose();
    });

    it('Space 激活复制(Space 默认会滚页面,必须 preventDefault)', async () => {
        const { stub, controller, root, formula } = setup();
        const preventDefault = vi.fn();

        root.dispatch('keydown', {
            key: ' ',
            target: formula,
            preventDefault,
        });

        await vi.waitFor(() => {
            expect(stub.execCommand.calls).toEqual(['copy']);
        });
        expect(preventDefault).toHaveBeenCalledTimes(1);
        controller.dispose();
    });

    it('其它按键不复制,不拦默认行为', () => {
        const { stub, controller, root, formula } = setup();
        const preventDefault = vi.fn();

        root.dispatch('keydown', { key: 'a', target: formula, preventDefault });

        expect(stub.execCommand.calls).toEqual([]);
        expect(preventDefault).not.toHaveBeenCalled();
        controller.dispose();
    });

    it('点在没有 data-tex 的元素上不触发复制', () => {
        const { stub, controller, root } = setup();

        root.dispatch('click', { target: root });

        expect(stub.execCommand.calls).toEqual([]);
        controller.dispose();
    });

    it('复制失败时回显错误态', async () => {
        const { stub, controller, hint, root, formula } = setup();
        stub.execCommand.result = false;

        root.dispatch('click', { target: formula });

        await vi.waitFor(() => {
            expect(hint.textContent).toBe('复制失败');
        });
        expect(hint.classList.contains('is-error')).toBe(true);
        controller.dispose();
    });
});

describe('dispose 复位提示', () => {
    it('dispose 后提示回到原文案且清掉状态类', async () => {
        const { controller, hint, root, formula } = setup();

        root.dispatch('click', { target: formula });
        await vi.waitFor(() => {
            expect(hint.textContent).toBe('已复制 TeX');
        });

        controller.dispose();

        expect(hint.textContent).toBe('点击公式复制 TeX');
        expect(hint.classList.contains('is-copied')).toBe(false);
        expect(hint.classList.contains('is-error')).toBe(false);
    });
});
