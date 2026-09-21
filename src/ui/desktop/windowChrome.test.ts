/**
 * 标题栏应用节点的结构契约.
 *
 * 这四个节点从 `index.html` 搬进 TS 之后(见 docs/windowing-plan.md §5.3),
 * 它们的"标记长什么样"就没有 HTML 可以对照了,这张断言就是新的真相源:文案来自
 * `UI_CONFIG.window.chrome`,`Popover` 需要的 aria 配对齐全,`UI_CONFIG.window
 * .adopted` 声明的落点与 `windowSlotsProvider()` 的输出一致.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { UI_CONFIG } from '@/config/uiConfig';
import { installDomStub, type StubElement } from '@/testing/domStub';
import { createPopover } from '@/ui/widgets/Popover';
import { createWindowChrome, windowSlotsProvider } from './windowChrome';

beforeEach(() => {
    installDomStub();
});

describe('createWindowChrome', () => {
    it('四个节点按 ChromeNodeId 建齐,文案来自配置', () => {
        const chrome = createWindowChrome();

        expect(Object.keys(chrome).sort()).toEqual(
            UI_CONFIG.window.adopted.map((entry) => entry.node).sort(),
        );
        expect(chrome.exampleButton.textContent).toBe(UI_CONFIG.window.chrome.exampleLabel);
        expect(chrome.runButton.textContent).toBe(UI_CONFIG.window.chrome.runLabel);
        expect(chrome.formulaCopyHint.textContent).toBe(UI_CONFIG.window.chrome.copyHint);
        // 浮层的分组与菜单项由 ExampleLoaderController 渲染,这里必须是空的.
        expect(chrome.exampleMenu.children).toHaveLength(0);
    });

    it('按钮是 type=button,示例按钮带 aria-haspopup', () => {
        const chrome = createWindowChrome();

        expect((chrome.exampleButton as unknown as StubElement).getAttribute('type')).toBe('button');
        expect((chrome.runButton as unknown as StubElement).getAttribute('type')).toBe('button');
        expect((chrome.exampleButton as unknown as StubElement).getAttribute('aria-haspopup')).toBe('true');
    });

    it('示例按钮与浮层的 aria 配对成立(Popover 依赖这一对 id)', () => {
        const chrome = createWindowChrome();
        createPopover({ trigger: chrome.exampleButton, panel: chrome.exampleMenu });

        // `aria-controls` 由 Popover 按面板 id 写入,`aria-expanded` 由它独占刷新.
        expect((chrome.exampleButton as unknown as StubElement).getAttribute('aria-controls'))
            .toBe(chrome.exampleMenu.id);
        expect((chrome.exampleButton as unknown as StubElement).getAttribute('aria-expanded')).toBe('false');
        // 浮层的读屏名指回触发按钮.
        expect((chrome.exampleMenu as unknown as StubElement).getAttribute('aria-labelledby'))
            .toBe(chrome.exampleButton.id);
        expect(chrome.exampleMenu.className).toBe('example-menu');
    });

    it('复制提示沿用对象列表的提示类名(样式来自 panels.css)', () => {
        const chrome = createWindowChrome();

        expect(chrome.formulaCopyHint.className).toBe('object-list-hint');
    });
});

describe('windowSlotsProvider', () => {
    it('每个窗口拿到 adopted 表里声明的节点,其余窗口为空', () => {
        const chrome = createWindowChrome();
        const content = windowSlotsProvider(chrome);

        expect(content('source')).toEqual({
            title: [],
            actions: [chrome.exampleButton, chrome.runButton],
            overlays: [chrome.exampleMenu],
        });
        expect(content('objects')).toEqual({
            title: [chrome.formulaCopyHint],
            actions: [],
            overlays: [],
        });
        expect(content('view')).toEqual({});
        expect(content('params')).toEqual({});
        expect(content('process')).toEqual({});
    });

    it('同一个节点不会被放进两个窗口', () => {
        const chrome = createWindowChrome();
        const content = windowSlotsProvider(chrome);
        const placed = UI_CONFIG.window.windows.flatMap((spec) =>
            Object.values(content(spec.id)).flat());

        for (const node of placed) {
            expect(placed.filter((other) => other === node)).toHaveLength(1);
        }
    });
});
