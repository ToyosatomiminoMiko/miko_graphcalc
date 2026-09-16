/**
 * 公式复制控制器单测(UI-P3.6).
 *
 * 复制必须有键盘入口:可复制公式由 FormulaView 加了 `tabindex`/`role`,
 * 本控制器提供 `keyboardBinding()` 供 KeyboardController 分发,自己只绑 click.
 * 这里覆盖:binding 的键名与目标放行规则,click 委托,成功/失败两条回显路径.
 * `preventDefault` 归 KeyboardController 管,所以断言在 KeyboardController.test.ts.
 *
 * 剪贴板走 legacy 回退(`window.isSecureContext = false` + `document.execCommand`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomStub, type DomStub, type StubElement } from '../../testing/domStub';
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

    it('Enter 命中可复制公式时返回处理器并复制', async () => {
        const { stub, controller, hint, formula } = setup();

        // 键盘监听已上收到 KeyboardController;这里只验证本控制器给出的规则.
        const run = controller.keyboardBinding()
            .resolve({ target: formula } as unknown as KeyboardEvent);

        expect(run).not.toBeNull();
        run?.();
        await vi.waitFor(() => {
            expect(stub.execCommand.calls).toEqual(['copy']);
            expect(hint.textContent).toBe('已复制 TeX');
        });
        controller.dispose();
    });

    it('Space 同样命中(默认键名与遗留 Spacebar 都声明)', () => {
        const { controller } = setup();

        expect(controller.keyboardBinding().keys).toEqual(['Enter', ' ', 'Spacebar']);
        expect(controller.keyboardBinding().resolve({ target: null } as unknown as KeyboardEvent))
            .toBeNull();
        controller.dispose();
    });

    it('目标不是可复制公式时放行(resolve 返回 null)', () => {
        const { controller, root } = setup();

        expect(controller.keyboardBinding()
            .resolve({ target: root } as unknown as KeyboardEvent)).toBeNull();
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
