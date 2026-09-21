/**
 * Dock 的装配契约:按钮由窗口清单生成(不是手写),点击只上报 id,
 * 激活态与状态点由 `setActive` / `setState` 写入.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { UI_CONFIG, type WindowId } from '@/config/uiConfig';
import { installDomStub, type StubElement } from '@/testing/domStub';
import { createDock, type DockHandle } from './Dock';

interface Fixture {
    readonly container: StubElement;
    readonly dock: DockHandle;
    readonly selected: WindowId[];
    readonly actions: string[];
}

function setup(): Fixture {
    installDomStub();
    const container = document.createElement('div') as unknown as StubElement;
    container.id = 'dock';
    const selected: WindowId[] = [];
    const actions: string[] = [];
    const dock = createDock(container as unknown as HTMLElement, {
        onSelect: (id) => selected.push(id),
        onExitFullscreen: () => actions.push('exit-fullscreen'),
        onRestoreAll: () => actions.push('restore-all'),
    });
    return { container, dock, selected, actions };
}

function buttonOf(container: StubElement, id: WindowId): StubElement {
    const button = container.querySelector<StubElement>(`.dock-btn[data-window="${id}"]`);
    if (!button) throw new Error(`Dock 里没有 ${id} 的按钮`);
    return button;
}

beforeEach(() => {
    installDomStub();
});

describe('createDock', () => {
    it('五个按钮由清单生成,顺序一致,内容来自配置', () => {
        const { container } = setup();
        const buttons = container.querySelectorAll<StubElement>('.dock-btn');

        expect(buttons.map((button) => button.getAttribute('data-window')))
            .toEqual(UI_CONFIG.window.windows.map((spec) => spec.id));
        for (const spec of UI_CONFIG.window.windows) {
            const button = buttonOf(container, spec.id);
            expect(button.title).toBe(spec.title);
            expect(button.querySelector<StubElement>('.dock-btn-icon')?.textContent)
                .toBe(spec.dock.icon);
            expect(button.querySelector<StubElement>('.dock-btn-label')?.textContent)
                .toBe(spec.dock.label);
            expect(button.getAttribute('aria-pressed')).toBe('false');
        }
    });

    it('点击上报窗口 id,不在这里解释状态', () => {
        const { container, selected } = setup();

        buttonOf(container, 'process').dispatch('click');
        buttonOf(container, 'source').dispatch('click');

        expect(selected).toEqual(['process', 'source']);
    });

    it('激活态与状态点都由 dock 自己写', () => {
        const { container, dock } = setup();

        dock.setActive('params');
        expect(buttonOf(container, 'params').classList.contains('is-active')).toBe(true);
        expect(buttonOf(container, 'params').getAttribute('aria-pressed')).toBe('true');
        expect(container.querySelectorAll<StubElement>('.dock-btn.is-active')).toHaveLength(1);

        dock.setActive(null);
        expect(container.querySelectorAll<StubElement>('.dock-btn.is-active')).toHaveLength(0);

        dock.buttons.get('objects')!.setState('minimized');
        expect(buttonOf(container, 'objects').getAttribute('data-state')).toBe('minimized');
        expect(buttonOf(container, 'objects').querySelector<StubElement>('.dock-btn-state')?.className)
            .toContain('is-minimized');
    });

    it('两个桌面动作按钮上报各自的意图', () => {
        const { container, actions } = setup();

        container.querySelector<StubElement>('[data-dock-action="exit-fullscreen"]')!.dispatch('click');
        container.querySelector<StubElement>('[data-dock-action="restore-all"]')!.dispatch('click');

        expect(actions).toEqual(['exit-fullscreen', 'restore-all']);
    });

    it('全屏时整条 Dock 收起(内容只占内容宽度,见 §11.1 B4)', () => {
        const { container, dock } = setup();

        dock.setFullscreen(true);
        expect(container.classList.contains('is-fullscreen')).toBe(true);

        dock.setFullscreen(false);
        expect(container.classList.contains('is-fullscreen')).toBe(false);
    });

    it('dispose 清空内容与状态', () => {
        const { container, dock } = setup();

        dock.dispose();

        expect(container.children).toHaveLength(0);
        expect(dock.buttons.size).toBe(0);
        expect(container.classList.contains('is-fullscreen')).toBe(false);
    });
});
