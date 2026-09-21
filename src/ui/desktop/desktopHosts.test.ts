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

    it('待搬迁节点还在 HTML 里(它们的 id 与监听归控制器)', () => {
        for (const id of ['example-btn', 'run-btn', 'example-menu', 'formula-copy-hint']) {
            expect(markup, `index.html 里没有 #${id}`).toContain(`id="${id}"`);
        }
    });
});
