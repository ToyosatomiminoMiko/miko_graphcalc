/**
 * 窗口外壳的 **DOM 契约**测试(`docs/windowing-plan.md` §5.4/§8).
 *
 * 窗外壳从 `index.html` 搬进 TS 之后,"标记长什么样"就没有 HTML 可以对照了,
 * 这张断言就是新的真相源:结构,类名,八根手柄,按钮的无障碍名,以及"既有节点是
 * 搬进来的而不是重建的"(后者最容易被 `innerHTML` 或重新 createElement 破坏,
 * 表现为按钮点不动,而且不报错).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { UI_CONFIG } from '@/config/uiConfig';
import { installDomStub, type StubElement } from '@/testing/domStub';
import { createWindowFrame, type WindowActionButton, type WindowFrameHandle } from './WindowFrame';
import { RESIZE_DIRECTIONS } from './WindowResize';

const GEOMETRY = { x: 16, y: 32, w: 420, h: 260 };

/** 标题栏按类名取:句柄不暴露 `header`(生产代码只读 title/body/handles/controls). */
function headerOf(frame: WindowFrameHandle): StubElement {
    return frame.element.querySelector('.window-header') as unknown as StubElement;
}

function controls(onClick: () => void = () => {}): WindowActionButton[] {
    return UI_CONFIG.window.actions.map((action) => ({
        id: action.id,
        label: action.label,
        glyph: action.glyph,
        onClick,
    }));
}

interface Fixture {
    readonly runButton: StubElement;
    readonly exampleMenu: StubElement;
    readonly copyHint: StubElement;
    readonly clicked: string[];
}

/** 照 `index.html` 的样子先放好"面板自带"的现成节点. */
function installExistingNodes(): Fixture {
    const runButton = document.createElement('button') as unknown as StubElement;
    runButton.id = 'run-btn';
    const exampleMenu = document.createElement('div') as unknown as StubElement;
    exampleMenu.id = 'example-menu';
    const copyHint = document.createElement('span') as unknown as StubElement;
    copyHint.id = 'formula-copy-hint';
    document.body.append(
        runButton as unknown as HTMLElement,
        exampleMenu as unknown as HTMLElement,
        copyHint as unknown as HTMLElement,
    );
    return { runButton, exampleMenu, copyHint, clicked: [] };
}

beforeEach(() => {
    installDomStub();
});

describe('createWindowFrame 的结构契约', () => {
    it('建出 .window / header / title / actions / controls / body 与八根手柄', () => {
        installExistingNodes();
        const frame = createWindowFrame({
            id: 'source',
            title: 'source code',
            titleContent: [],
            actions: [],
            overlays: [],
            controls: controls(),
            geometry: GEOMETRY,
        });

        expect(frame.element.tagName).toBe('section');
        expect(frame.element.className).toBe('window');
        expect(frame.element.dataset.window).toBe('source');
        expect(frame.element.getAttribute('role')).toBe('region');
        expect(frame.element.tabIndex).toBe(-1);
        expect(frame.element.getAttribute('aria-labelledby')).toBe('window-title-source');

        expect(headerOf(frame).className).toBe('window-header');
        expect(frame.title.className).toBe('window-title');
        expect(frame.body.className).toBe('window-body');
        expect(headerOf(frame).contains(frame.title as unknown as StubElement)).toBe(true);
        // 正文与标题栏是兄弟:正文必须在 header 之外(浮层在 header 里,反过来会被裁).
        expect(headerOf(frame).contains(frame.body as unknown as StubElement)).toBe(false);
        expect(frame.element.contains(frame.body as unknown as Node)).toBe(true);

        const actions = headerOf(frame).querySelector('.window-actions');
        const controlBox = headerOf(frame).querySelector('.window-controls');
        expect(actions).not.toBeNull();
        expect(controlBox).not.toBeNull();

        expect(frame.handles.map((handle) => handle.direction)).toEqual(RESIZE_DIRECTIONS);
        const inDom = frame.element.querySelectorAll('[data-window-resize]');
        expect(inDom).toHaveLength(8);
        for (const handle of frame.handles) {
            expect(handle.element.getAttribute('data-window-resize')).toBe(handle.direction);
            expect(handle.element.className).toBe('resize-handle');
            expect(frame.element.contains(handle.element as unknown as Node)).toBe(true);
        }
    });

    it('窗口按钮的无障碍名与字形来自 UI_CONFIG.window.actions', () => {
        installExistingNodes();
        const frame = createWindowFrame({
            id: 'source',
            title: 'source code',
            titleContent: [],
            actions: [],
            overlays: [],
            controls: controls(),
            geometry: GEOMETRY,
        });

        expect([...frame.controls.keys()]).toEqual(
            UI_CONFIG.window.actions.map((action) => action.id),
        );
        for (const action of UI_CONFIG.window.actions) {
            const button = frame.controls.get(action.id)!;
            expect(button.element.textContent).toBe(action.glyph);
            expect(button.element.getAttribute('aria-label')).toBe(action.label);
            expect(button.element.title).toBe(action.label);
            expect(button.element.type).toBe('button');
        }
    });

    it('点击窗口按钮会调用传进来的回调', () => {
        installExistingNodes();
        const clicked: string[] = [];
        const frame = createWindowFrame({
            id: 'source',
            title: 'source code',
            titleContent: [],
            actions: [],
            overlays: [],
            controls: UI_CONFIG.window.actions.map((action) => ({
                id: action.id,
                label: action.label,
                glyph: action.glyph,
                onClick: () => clicked.push(action.id),
            })),
            geometry: GEOMETRY,
        });

        const close = frame.controls.get('close')!.element as unknown as StubElement;
        close.dispatch('click');
        expect(clicked).toEqual(['close']);
    });

    it('几何在建好时立即写成四条行内属性(不闪在左上角)', () => {
        installExistingNodes();
        const frame = createWindowFrame({
            id: 'source',
            title: 'source code',
            titleContent: [],
            actions: [],
            overlays: [],
            controls: controls(),
            geometry: GEOMETRY,
        });

        expect(frame.element.style.getPropertyValue('left')).toBe('16px');
        expect(frame.element.style.getPropertyValue('top')).toBe('32px');
        expect(frame.element.style.getPropertyValue('width')).toBe('420px');
        expect(frame.element.style.getPropertyValue('height')).toBe('260px');
    });

    it('dispose 摘掉监听并把元素移出树', () => {
        installExistingNodes();
        const clicked: string[] = [];
        const frame = createWindowFrame({
            id: 'source',
            title: 'source code',
            titleContent: [],
            actions: [],
            overlays: [],
            controls: UI_CONFIG.window.actions.map((action) => ({
                id: action.id,
                label: action.label,
                glyph: action.glyph,
                onClick: () => clicked.push(action.id),
            })),
            geometry: GEOMETRY,
        });
        document.body.append(frame.element);
        const close = frame.controls.get('close')!.element as unknown as StubElement;

        frame.dispose();

        close.dispatch('click');
        expect(clicked).toEqual([]);
        expect(frame.element.parentElement).toBeNull();
    });
});

describe('既有节点是搬进来的,不是重建的(§4.4)', () => {
    it('actions / overlays / titleContent 的节点身份保持不变', () => {
        const fixture = installExistingNodes();
        const frame = createWindowFrame({
            id: 'source',
            title: 'source code',
            titleContent: [fixture.copyHint as unknown as HTMLElement],
            actions: [fixture.runButton as unknown as HTMLElement],
            overlays: [fixture.exampleMenu as unknown as HTMLElement],
            controls: controls(),
            geometry: GEOMETRY,
        });

        const actions = headerOf(frame).querySelector('.window-actions') as unknown as StubElement;
        expect(actions.children).toContain(fixture.runButton);
        // 同一个对象,不是复制品.
        expect(actions.querySelector('#run-btn')).toBe(fixture.runButton);
        expect(frame.title.querySelector('#formula-copy-hint')).toBe(fixture.copyHint);
    });

    it('#example-menu 落在 .window-header 而不是 .window-body(否则会被正文裁掉)', () => {
        const fixture = installExistingNodes();
        const frame = createWindowFrame({
            id: 'source',
            title: 'source code',
            titleContent: [],
            actions: [fixture.runButton as unknown as HTMLElement],
            overlays: [fixture.exampleMenu as unknown as HTMLElement],
            controls: controls(),
            geometry: GEOMETRY,
        });

        expect(headerOf(frame).querySelector('#example-menu')).toBe(fixture.exampleMenu);
        expect(frame.body.querySelector('#example-menu')).toBeNull();
        // 浮层是 header 的直接子节点,不在 .window-actions 那一层.
        const actions = headerOf(frame).querySelector('.window-actions') as unknown as StubElement;
        expect(actions.children).not.toContain(fixture.exampleMenu);
    });
});
