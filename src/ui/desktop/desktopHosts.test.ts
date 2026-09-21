/**
 * 配置与 `index.html` 的**不漂移**守卫(不需要浏览器).
 *
 * 窗口外壳搬进 TS 之后,`UI_CONFIG.window.windows[].hostId` 是一个字符串,
 * `index.html` 里删/改名一个宿主不会有任何编译错误,只会在启动时抛一条
 * 读不懂的 TypeError(见 docs/windowing-plan.md §11.1 B9).这里用纯文本解析
 * 把"配置是唯一真相源"从注释变成断言,顺便守住"拆页的残留物不再回来".
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UI_CONFIG } from '@/config/uiConfig';

const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
/** 注释里会提到类名(如"搬进 .window-header"),判断"标记里有没有"要先去掉注释. */
const markup = html.replace(/<!--[\s\S]*?-->/g, '');

describe('窗口宿主与 index.html', () => {
    it('每个 hostId 都能在 HTML 里找到对应元素', () => {
        for (const spec of UI_CONFIG.window.windows) {
            expect(markup, `index.html 里没有 #${spec.hostId}(窗口 ${spec.id})`)
                .toContain(`id="${spec.hostId}"`);
        }
    });

    it('三个空宿主都在 HTML 里(窗口内容由 WindowManager 装配)', () => {
        for (const id of ['window-layer', 'snap-preview', 'dock']) {
            expect(markup, `index.html 里没有 #${id}`).toContain(`id="${id}"`);
        }
    });

    it('index.html 里没有任何 .window 结构(窗外壳只在 TS 里)', () => {
        expect(markup).not.toMatch(/class="[^"]*\bwindow\b/);
        expect(markup).not.toContain('window-header');
        expect(markup).not.toContain('window-body');
        expect(markup).not.toContain('window-title');
        expect(markup).not.toContain('window-actions');
        expect(markup).not.toContain('window-controls');
    });

    it('拆页与折叠的残留物都不在标记里', () => {
        // 标签页与分栏链路
        expect(markup).not.toContain('right-tabs');
        expect(markup).not.toContain('right-splitter');
        expect(markup).not.toContain('data-split-page');
        expect(markup).not.toContain('role="tabpanel"');
        // 空壳 #right-panel 与面板自带的标题栏/折叠按钮/分隔条
        expect(markup).not.toContain('id="right-panel"');
        expect(markup).not.toContain('panel-header');
        expect(markup).not.toContain('data-panel-toggle');
        expect(markup).not.toContain('data-resize-panel');
    });

    it('layout.css 已经删除,window.css 已挂载', () => {
        expect(markup).not.toContain('layout.css');
        expect(markup).toContain('window.css');
    });

    it('标题栏应用节点不在 HTML 里(由 createWindowChrome 建,位置声明在 adopted)', () => {
        // 这四个节点曾经住在一个 hidden 的 `#window-staging` 暂存区里,由
        // WindowManager.bind() 搬进标题栏.现在它们从出生起就在 TS 里(见
        // ui/desktop/windowChrome.ts),HTML 不许再出现副本,也不许那个暂存区回来.
        for (const id of ['example-btn', 'run-btn', 'example-menu', 'formula-copy-hint']) {
            expect(markup, `index.html 里不该再有 #${id}`).not.toContain(`id="${id}"`);
        }
        expect(markup).not.toContain('window-staging');
    });

    it('每个 adopted 声明的窗口与槽位都合法,且节点名不会重名', () => {
        const windowIds = UI_CONFIG.window.windows.map((spec) => spec.id);
        const nodes = UI_CONFIG.window.adopted.map((adopted) => adopted.node);
        for (const adopted of UI_CONFIG.window.adopted) {
            expect(windowIds).toContain(adopted.window);
            expect(['title', 'actions', 'overlays']).toContain(adopted.slot);
        }
        // 一个节点只能有一个位置:重复声明会让同一个节点被 append 两次(等于搬走).
        expect(new Set(nodes).size).toBe(nodes.length);
    });

    it('每个正文宿主 id 在 HTML 里只出现一次', () => {
        for (const spec of UI_CONFIG.window.windows) {
            const hits = markup.split(`id="${spec.hostId}"`).length - 1;
            expect(hits, `#${spec.hostId} 出现了 ${hits} 次`).toBe(1);
        }
    });
});
