/**
 * 面板布局控制器单测(UI-P3.2 / UI-P3.3).
 *
 * 锁两件事:
 * - 折叠按钮的文案说明"按下会发生什么"(展开/收起),并带
 *   `aria-expanded` / `aria-controls`;
 * - 折叠态只有一个状态源与一个写入点:`dispose()` 先把 DOM 复位成展开,
 *   再次 `bind()` 不会得到"模型展开 / DOM 折叠"的自相矛盾面板.
 *
 * 拖拽尺寸路径需要 `getComputedStyle` 与 window 指针事件,不在本文件覆盖.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installDomStub, type DomStub, type StubElement } from '../test/domStub';
import { PanelController } from './PanelController';

interface FakePanel {
    readonly panel: StubElement;
    readonly header: StubElement;
    readonly button: StubElement;
    readonly body: StubElement;
    readonly handle: StubElement;
}

function createPanel(
    stub: DomStub,
    id: string,
    title: string,
    tag: 'aside' | 'footer',
): FakePanel {
    const panel = stub.document.createElement(tag);
    panel.id = id;
    panel.classList.add('panel');

    const header = stub.document.createElement('header');
    header.className = 'panel-header';
    const titleSpan = stub.document.createElement('span');
    titleSpan.className = 'panel-title';
    titleSpan.textContent = title;
    const button = stub.document.createElement('button');
    button.textContent = '收起';
    button.dataset.panelToggle = `#${id}`;
    header.append(titleSpan, button);

    const body = stub.document.createElement('section');
    body.id = `${id}-body`;

    const handle = stub.document.createElement('div');
    handle.className = 'resize-handle';
    handle.dataset.resizePanel = id;

    panel.append(header, body, handle);
    return { panel, header, button, body, handle };
}

function setup(): { stub: DomStub; root: StubElement; left: FakePanel; bottom: FakePanel } {
    const stub = installDomStub();
    const root = stub.document.createElement('div');
    root.id = 'app';
    const left = createPanel(stub, 'left-panel', '源码', 'aside');
    const bottom = createPanel(stub, 'bottom-panel', '对象', 'footer');
    root.append(left.panel, bottom.panel);
    stub.document.body.append(root);
    return { stub, root, left, bottom };
}

beforeEach(() => {
    installDomStub();
});

describe('折叠态的可访问语义(UI-P3.2)', () => {
    it('bind 后按钮是"收起"并标出展开状态与受控面板', () => {
        const { root, left } = setup();
        new PanelController().bind(root as unknown as HTMLElement);

        expect(left.button.textContent).toBe('收起');
        expect(left.button.getAttribute('aria-expanded')).toBe('true');
        expect(left.button.getAttribute('aria-controls')).toBe('left-panel');
    });

    it('折叠后按钮文案变成"展开",不再退化成面板标题', () => {
        const { root, left } = setup();
        new PanelController().bind(root as unknown as HTMLElement);

        left.button.dispatch('click');

        expect(left.panel.classList.contains('collapsed')).toBe(true);
        expect(left.button.textContent).toBe('展开');
        expect(left.button.getAttribute('aria-expanded')).toBe('false');
        // 承载按钮的 header 保留(折叠条要能点开),正文与手柄收起.
        expect(left.header.style.display).toBe('');
        expect(left.body.style.display).toBe('none');
        expect(left.handle.style.display).toBe('none');
        expect(root.style.getPropertyValue('--left-panel-width')).toBe('44px');
    });

    it('再次点击恢复展开与原始宽度', () => {
        const { root, left } = setup();
        new PanelController().bind(root as unknown as HTMLElement);

        left.button.dispatch('click');
        left.button.dispatch('click');

        expect(left.panel.classList.contains('collapsed')).toBe(false);
        expect(left.button.textContent).toBe('收起');
        expect(left.body.style.display).toBe('');
        expect(root.style.getPropertyValue('--left-panel-width')).toBe('300px');
    });

    it('各面板互不影响', () => {
        const { root, left, bottom } = setup();
        new PanelController().bind(root as unknown as HTMLElement);

        left.button.dispatch('click');

        expect(left.panel.classList.contains('collapsed')).toBe(true);
        expect(bottom.panel.classList.contains('collapsed')).toBe(false);
        expect(bottom.body.style.display).toBe('');
        expect(root.style.getPropertyValue('--footer-height')).toBe('240px');
    });
});

describe('dispose 复位与重复 bind(UI-P3.3)', () => {
    it('dispose 把模型与 DOM 一起复位成展开态', () => {
        const { root, left } = setup();
        const controller = new PanelController();
        controller.bind(root as unknown as HTMLElement);

        left.button.dispatch('click');
        controller.dispose();

        expect(left.panel.classList.contains('collapsed')).toBe(false);
        expect(left.body.style.display).toBe('');
        expect(left.handle.style.display).toBe('');
        expect(left.button.textContent).toBe('收起');
        expect(left.button.getAttribute('aria-expanded')).toBe('true');
        expect(root.style.getPropertyValue('--left-panel-width')).toBe('300px');
    });

    it('dispose 后再次 bind,折叠/展开仍然自洽', () => {
        const { root, left } = setup();
        const controller = new PanelController();
        controller.bind(root as unknown as HTMLElement);
        left.button.dispatch('click');
        controller.dispose();

        controller.bind(root as unknown as HTMLElement);
        expect(left.panel.classList.contains('collapsed')).toBe(false);
        expect(left.body.style.display).toBe('');

        left.button.dispatch('click');
        expect(left.panel.classList.contains('collapsed')).toBe(true);
        expect(left.button.textContent).toBe('展开');
        expect(root.style.getPropertyValue('--left-panel-width')).toBe('44px');
    });

    it('dispose 会摘掉旧监听:重新 bind 只保留一份监听', () => {
        const { root, left } = setup();
        const controller = new PanelController();
        controller.bind(root as unknown as HTMLElement);
        controller.dispose();

        // dispose 的 abort 摘掉旧监听(桩实现了 { signal } 语义):点击不再改状态.
        left.button.dispatch('click');
        controller.bind(root as unknown as HTMLElement);
        // 若旧监听还在,dispose 后那次点击会把折叠态留在集合里,重新 bind 时
        // _applyLayout 会立刻把面板折叠起来.
        expect(left.panel.classList.contains('collapsed')).toBe(false);

        // 也只应有一份监听:点一次折叠一次,而不是"折叠又被另一份展开".
        left.button.dispatch('click');
        expect(left.panel.classList.contains('collapsed')).toBe(true);
        expect(left.button.textContent).toBe('展开');
        expect(root.style.getPropertyValue('--left-panel-width')).toBe('44px');
    });
});
