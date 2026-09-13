/**
 * KeyboardController 单测.
 *
 * 这个控制器是全应用唯一的 keydown 出口,所以覆盖三块:
 * - 内置绑定:`Home`(含输入焦点让位),编辑器 `Ctrl/Cmd+Enter`;
 * - 路由契约:注册的组件绑定按顺序命中即停,返回 null 放行,命中统一
 *   preventDefault;
 * - 端到端:把 FormulaCopyController 的 binding 注册进来,验证"聚焦公式 +
 *   Enter"能复制并阻止默认滚动.
 *
 * 键盘监听只绑在 document 上(编辑器快捷键靠冒泡),所以触发一律走
 * `stub.document.dispatch`,事件 target 显式带上"当前聚焦元素".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomStub, type DomStub, type StubElement } from '../test/domStub';
import { FormulaCopyController } from '../ui/FormulaCopyController';
import { KeyboardController, type KeyboardBinding } from './KeyboardController';

interface Harness {
    readonly stub: DomStub;
    readonly controller: KeyboardController;
    readonly editor: StubElement;
    readonly onHome: ReturnType<typeof vi.fn>;
    readonly onRun: ReturnType<typeof vi.fn>;
}

function setup(): Harness {
    const stub = installDomStub();
    const editor = stub.document.createElement('textarea');
    stub.document.body.append(editor);

    const onHome = vi.fn();
    const onRun = vi.fn();
    const controller = new KeyboardController(
        editor as unknown as HTMLElement,
        { onHome, onRun },
    );
    controller.bind();
    return { stub, controller, editor, onHome, onRun };
}

beforeEach(() => {
    installDomStub();
});

describe('Home 全局快捷键', () => {
    it('非输入焦点下重置视角并阻止页面滚动', () => {
        const { stub, controller, onHome } = setup();
        const preventDefault = vi.fn();

        stub.document.dispatch('keydown', { key: 'Home', preventDefault });

        expect(onHome).toHaveBeenCalledTimes(1);
        expect(preventDefault).toHaveBeenCalledTimes(1);
        controller.dispose();
    });

    it('其它按键不触发', () => {
        const { stub, controller, onHome } = setup();

        stub.document.dispatch('keydown', { key: 'h' });

        expect(onHome).not.toHaveBeenCalled();
        controller.dispose();
    });

    it('焦点在编辑器里时让位给光标回行首', () => {
        const { stub, controller, editor, onHome } = setup();
        const preventDefault = vi.fn();

        stub.document.dispatch('keydown', {
            key: 'Home',
            target: editor,
            preventDefault,
        });

        expect(onHome).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        controller.dispose();
    });

    it('焦点在输入框(含 range 滑块)里时不触发', () => {
        const { stub, controller, onHome } = setup();
        const input = stub.document.createElement('input');
        stub.document.body.append(input);

        stub.document.dispatch('keydown', { key: 'Home', target: input });

        expect(onHome).not.toHaveBeenCalled();
        controller.dispose();
    });

    it('焦点在 contenteditable 里时不触发', () => {
        const { stub, controller, onHome } = setup();
        const editable = stub.document.createElement('div');
        editable.setAttribute('contenteditable', '');
        stub.document.body.append(editable);

        stub.document.dispatch('keydown', { key: 'Home', target: editable });

        expect(onHome).not.toHaveBeenCalled();
        controller.dispose();
    });

    it('contenteditable="false" 不算可编辑,仍然触发', () => {
        const { stub, controller, onHome } = setup();
        const plain = stub.document.createElement('div');
        plain.setAttribute('contenteditable', 'false');
        stub.document.body.append(plain);

        stub.document.dispatch('keydown', { key: 'Home', target: plain });

        expect(onHome).toHaveBeenCalledTimes(1);
        controller.dispose();
    });
});

describe('编辑器 Ctrl/Cmd+Enter(靠冒泡到 document)', () => {
    it('Ctrl+Enter 运行 DSL 并阻止默认换行', () => {
        const { stub, controller, editor, onRun } = setup();
        const preventDefault = vi.fn();

        stub.document.dispatch('keydown', {
            key: 'Enter',
            ctrlKey: true,
            target: editor,
            preventDefault,
        });

        expect(onRun).toHaveBeenCalledTimes(1);
        expect(preventDefault).toHaveBeenCalledTimes(1);
        controller.dispose();
    });

    it('Cmd+Enter 同样运行', () => {
        const { stub, controller, editor, onRun } = setup();

        stub.document.dispatch('keydown', { key: 'Enter', metaKey: true, target: editor });

        expect(onRun).toHaveBeenCalledTimes(1);
        controller.dispose();
    });

    it('单独 Enter 只是换行,不运行', () => {
        const { stub, controller, editor, onRun } = setup();

        stub.document.dispatch('keydown', { key: 'Enter', target: editor });

        expect(onRun).not.toHaveBeenCalled();
        controller.dispose();
    });

    it('Ctrl+Enter 在编辑器之外不运行(作用域仍是编辑器)', () => {
        const { stub, controller, onRun } = setup();

        stub.document.dispatch('keydown', { key: 'Enter', ctrlKey: true });

        expect(onRun).not.toHaveBeenCalled();
        controller.dispose();
    });
});

describe('组件绑定路由', () => {
    function spyBinding(
        keys: readonly string[],
        handled: boolean,
        run: () => void,
    ): KeyboardBinding {
        return {
            keys,
            resolve: () => (handled ? () => run() : null),
        };
    }

    it('注册的绑定能收到 document 上的按键,并统一 preventDefault', () => {
        const { stub, controller } = setup();
        const run = vi.fn();
        const preventDefault = vi.fn();
        controller.register(spyBinding(['x'], true, run));

        stub.document.dispatch('keydown', { key: 'x', preventDefault });

        expect(run).toHaveBeenCalledTimes(1);
        expect(preventDefault).toHaveBeenCalledTimes(1);
        controller.dispose();
    });

    it('resolve 返回 null 时放行给后续绑定', () => {
        const { stub, controller } = setup();
        const first = vi.fn();
        const second = vi.fn();
        controller.register(spyBinding(['x'], false, first));
        controller.register(spyBinding(['x'], true, second));

        stub.document.dispatch('keydown', { key: 'x' });

        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
        controller.dispose();
    });

    it('命中即停:前一条处理后不再问后面的同键绑定', () => {
        const { stub, controller } = setup();
        const first = vi.fn();
        const second = vi.fn();
        controller.register(spyBinding(['x'], true, first));
        controller.register(spyBinding(['x'], true, second));

        stub.document.dispatch('keydown', { key: 'x' });

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();
        controller.dispose();
    });
});

describe('与 FormulaCopyController 的端到端路由', () => {
    it('聚焦公式按 Enter 复制 TeX,且只有一个 document 监听', async () => {
        const { stub, controller } = setup();

        const hint = stub.document.createElement('span');
        hint.textContent = '点击公式复制 TeX';
        const formula = stub.document.createElement('span');
        formula.setAttribute('data-tex', 'x^2');
        const root = stub.document.createElement('div');
        root.append(formula);
        stub.document.body.append(root);

        const copy = new FormulaCopyController(hint as unknown as HTMLElement);
        copy.bind(root as unknown as HTMLElement);
        controller.register(copy.keyboardBinding());

        const preventDefault = vi.fn();
        stub.document.dispatch('keydown', {
            key: 'Enter',
            target: formula,
            preventDefault,
        });

        await vi.waitFor(() => {
            expect(stub.execCommand.calls).toEqual(['copy']);
            expect(hint.textContent).toBe('已复制 TeX');
        });
        expect(preventDefault).toHaveBeenCalledTimes(1);

        copy.dispose();
        controller.dispose();
    });
});

describe('dispose() 摘监听', () => {
    it('解绑后 Home,Ctrl+Enter 与组件绑定都不再响应', () => {
        const { stub, controller, editor, onHome, onRun } = setup();
        const component = vi.fn();
        controller.register({
            keys: ['x'],
            resolve: () => () => component(),
        });

        controller.dispose();
        stub.document.dispatch('keydown', { key: 'Home' });
        stub.document.dispatch('keydown', { key: 'Enter', ctrlKey: true, target: editor });
        stub.document.dispatch('keydown', { key: 'x' });

        expect(onHome).not.toHaveBeenCalled();
        expect(onRun).not.toHaveBeenCalled();
        expect(component).not.toHaveBeenCalled();
    });
});
