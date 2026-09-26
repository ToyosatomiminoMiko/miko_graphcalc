/**
 * 标题栏应用节点的结构契约.
 *
 * 这四个节点从 `index.html` 搬进 TS 之后(见 docs/windowing-plan.md §5.3),
 * 它们的"标记长什么样"就没有 HTML 可以对照了,这张断言就是新的真相源:文案来自
 * `UI_CONFIG.window.chrome`,`Popover` 需要的 aria 配对齐全,`UI_CONFIG.window
 * .adopted` 声明的落点与 `windowSlotsProvider()` 的输出一致.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPopover, windowSlotsProvider } from 'miko_ui';
import { UI_CONFIG } from '@/config/uiConfig';
import { installDomStub, type StubElement } from '@/testing/domStub';
import { createWindowChrome } from './windowChrome';

beforeEach(() => {
    installDomStub();
});

describe('createWindowChrome', () => {
    it('五个节点按 ChromeNodeId 建齐,文案来自配置', () => {
        const chrome = createWindowChrome();

        expect(Object.keys(chrome).sort()).toEqual(
            UI_CONFIG.window.adopted.map((entry) => entry.node).sort(),
        );
        expect(chrome.exampleButton.textContent).toBe(UI_CONFIG.window.chrome.exampleLabel);
        expect(chrome.runButton.textContent).toBe(UI_CONFIG.window.chrome.runLabel);
        // 两处复制提示:同一句文案,两个节点(各进一个对象窗口的标题栏).
        expect(chrome.formulaCopyHint.textContent).toBe(UI_CONFIG.window.chrome.copyHint);
        expect(chrome.formulaCopyHintEvaluations.textContent).toBe(UI_CONFIG.window.chrome.copyHint);
        // 浮层的类名 / role / aria 与分组,菜单项由库的 createMenu 建
        // (见 ExampleLoaderController),这里必须是空的.
        expect(chrome.exampleMenu.children).toHaveLength(0);
    });

    it('按钮是 type=button,示例按钮带 aria-haspopup', () => {
        const chrome = createWindowChrome();

        expect((chrome.exampleButton as unknown as StubElement).getAttribute('type')).toBe('button');
        expect((chrome.runButton as unknown as StubElement).getAttribute('type')).toBe('button');
        expect((chrome.exampleButton as unknown as StubElement).getAttribute('aria-haspopup')).toBe('true');
    });

    it('标题栏按钮带库的按钮基线类(不是裸 <button>)', () => {
        // 裸 `create_element({ tag: 'button' })` 会吃到浏览器 UA 的那套外观(自带圆角与
        // 底色,而 token 里 `--radius-*` 都是 0),与库示例里的按钮不是同一种
        // 东西.库的 `createButton` 给每个按钮叠上 `.ui-button`,外观因此只有库
        // 里那一份 -- 见库 `widgets/Button.ts` 的说明.
        const chrome = createWindowChrome();

        for (const button of [chrome.exampleButton, chrome.runButton]) {
            const element = button as unknown as StubElement;
            expect(element.classList.contains('ui-button')).toBe(true);
        }
    });

    it('示例按钮与浮层的 aria-controls 配对成立(Popover 依赖这一对 id)', () => {
        const chrome = createWindowChrome();
        createPopover({ trigger: chrome.exampleButton, panel: chrome.exampleMenu });

        // `aria-controls` 由 Popover 按面板 id 写入,`aria-expanded` 由它独占刷新.
        expect((chrome.exampleButton as unknown as StubElement).getAttribute('aria-controls'))
            .toBe(chrome.exampleMenu.id);
        expect((chrome.exampleButton as unknown as StubElement).getAttribute('aria-expanded')).toBe('false');
        // 容器自己只挂**滚动条类**(库里那条独立规定,挂不挂由消费方定,见
        // windowChrome.ts);菜单的类名 / role / aria-label 与内容仍由库的
        // createMenu 写,所以这里还没有 `.menu-panel`,也没有 role / aria-labelledby.
        expect(chrome.exampleMenu.id).toBe('example-menu');
        expect(chrome.exampleMenu.className).toBe('ui-scrollbar');
        expect((chrome.exampleMenu as unknown as StubElement).getAttribute('role')).toBeNull();
    });

    it('复制提示沿用对象列表的提示类名(样式来自 panels.css)', () => {
        const chrome = createWindowChrome();

        expect(chrome.formulaCopyHint.className).toBe('object-list-hint');
    });
});

describe('windowSlotsProvider', () => {
    it('每个窗口拿到 adopted 表里声明的节点,其余窗口为空', () => {
        const chrome = createWindowChrome();
        const content = windowSlotsProvider(UI_CONFIG.window.adopted, chrome);

        expect(content('source')).toEqual({
            title: [],
            actions: [chrome.exampleButton, chrome.runButton],
            overlays: [chrome.exampleMenu],
        });
        expect(content('entities')).toEqual({
            title: [chrome.formulaCopyHint],
            actions: [],
            overlays: [],
        });
        expect(content('view')).toEqual({});
        expect(content('params')).toEqual({});
        expect(content('process')).toEqual({});
        // 求值窗口也有自己的那句复制提示(与实体窗口是**两个**节点).
        expect(content('evaluations')).toEqual({
            title: [chrome.formulaCopyHintEvaluations],
            actions: [],
            overlays: [],
        });
    });

    it('同一个节点不会被放进两个窗口', () => {
        const chrome = createWindowChrome();
        const content = windowSlotsProvider(UI_CONFIG.window.adopted, chrome);
        const placed = UI_CONFIG.window.windows.flatMap((spec) =>
            Object.values(content(spec.id)).flat());

        for (const node of placed) {
            expect(placed.filter((other) => other === node)).toHaveLength(1);
        }
    });
});
