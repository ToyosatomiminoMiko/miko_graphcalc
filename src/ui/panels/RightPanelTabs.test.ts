/**
 * 右栏标签页控制器单测.
 *
 * 锁的是"页归属"这一件事:页级 `hidden` 只有一个写入点,切页回调把当前页
 * 报给应用层(应用层据此刷新页级内容),dispose 复位成参数页后不再有监听.
 * 页宽不在这里:参数页与过程页共用侧栏那一份宽度(见 PanelController).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { installDomStub, type StubElement } from '../../testing/domStub';
import { RightPanelTabs, type RightTab } from './RightPanelTabs';

function setup(): {
    stub: ReturnType<typeof installDomStub>;
    tabs: RightPanelTabs;
    container: StubElement;
    paramsPage: StubElement;
    processPage: StubElement;
    changes: RightTab[];
} {
    const stub = installDomStub();

    const container = stub.document.createElement('div');
    container.id = 'right-tabs';
    const paramsPage = stub.document.createElement('div');
    paramsPage.id = 'right-page-params';
    const processPage = stub.document.createElement('div');
    processPage.id = 'right-page-process';
    stub.document.body.append(container, paramsPage, processPage);

    const changes: RightTab[] = [];
    const tabs = new RightPanelTabs(
        container as unknown as HTMLElement,
        {
            params: paramsPage as unknown as HTMLElement,
            process: processPage as unknown as HTMLElement,
        },
        { onTabChange: (tab) => changes.push(tab) },
    );

    return { stub, tabs, container, paramsPage, processPage, changes };
}

describe('bind', () => {
    it('装配两个标签,默认参数页可见,过程页收起', () => {
        const { container, paramsPage, processPage } = setup();
        const tabs = new RightPanelTabs(
            container as unknown as HTMLElement,
            {
                params: paramsPage as unknown as HTMLElement,
                process: processPage as unknown as HTMLElement,
            },
            { onTabChange: () => {} },
        );
        tabs.bind();

        expect(container.querySelectorAll<StubElement>('.tab')).toHaveLength(2);
        expect(paramsPage.getAttribute('hidden')).toBeNull();
        expect(processPage.getAttribute('hidden')).toBe('');
        expect(paramsPage.getAttribute('aria-labelledby')).toBe('right-page-params-tab');
    });

    it('未 bind 前默认页就是参数页', () => {
        const { tabs } = setup();

        expect(tabs.get()).toBe('params');
    });
});

describe('切页', () => {
    it('show() 切换页级 hidden 并回调当前页', () => {
        const { tabs, paramsPage, processPage, changes } = setup();
        tabs.bind();

        tabs.show('process');

        expect(tabs.get()).toBe('process');
        expect(paramsPage.getAttribute('hidden')).toBe('');
        expect(processPage.getAttribute('hidden')).toBeNull();
        expect(changes).toEqual(['process']);
    });

    it('点击标签与 show() 走同一条路径', () => {
        const { stub, tabs, paramsPage, processPage, changes } = setup();
        tabs.bind();

        stub.document.querySelector<StubElement>('#right-page-process-tab')!.dispatch('click');

        expect(tabs.get()).toBe('process');
        expect(paramsPage.getAttribute('hidden')).toBe('');
        expect(processPage.getAttribute('hidden')).toBeNull();
        expect(changes).toEqual(['process']);
    });

    it('切回参数页后页级状态还原', () => {
        const { tabs, paramsPage, processPage, changes } = setup();
        tabs.bind();

        tabs.show('process');
        tabs.show('params');

        expect(paramsPage.getAttribute('hidden')).toBeNull();
        expect(processPage.getAttribute('hidden')).toBe('');
        expect(changes).toEqual(['process', 'params']);
    });
});

describe('dispose', () => {
    it('复位成参数页,并摘掉监听(之后再点不再切页)', () => {
        const { stub, tabs, paramsPage, processPage, changes } = setup();
        tabs.bind();
        tabs.show('process');

        tabs.dispose();

        expect(tabs.get()).toBe('params');
        expect(paramsPage.getAttribute('hidden')).toBeNull();
        expect(processPage.getAttribute('hidden')).toBe('');
        // 复位本身不该再通知应用层(拆解途中不广播).
        expect(changes).toEqual(['process']);

        stub.document.querySelector<StubElement>('#right-page-process-tab')?.dispatch('click');
        expect(tabs.get()).toBe('params');
        expect(changes).toEqual(['process']);
    });
});

describe('样式契约', () => {
    /**
     * `hidden` 属性靠 UA 的 `[hidden] { display: none }` 生效,而 `.right-page`
     * 的 `display: flex` 是作者样式,会盖掉它.必须有一条显式的作者规则把隐藏页
     * 收起来;漏掉它时切页看上去"没反应",而且只有真机才看得出来.
     */
    it('panels.css 为隐藏页写了显式的 display:none', () => {
        const css = readFileSync(new URL('../../../css/panels.css', import.meta.url), 'utf8');
        const rule = /\.right-page\[hidden\]\s*\{([\s\S]*?)\}/.exec(css);

        expect(rule?.[1]).toMatch(/display:\s*none/);
    });

    it('标签栏留在面板 header 的折叠隐藏清单里', () => {
        const css = readFileSync(new URL('../../../css/panels.css', import.meta.url), 'utf8');

        expect(css).toMatch(/\.panel\.collapsed #right-tabs/);
    });

    /**
     * 默认哪一页在前**只有 `DEFAULT_RIGHT_TAB` 一处声明**:HTML 的页容器不带
     * `hidden` 初值,页级显隐由构造期的 `_applyPages()` 写出.若有人在 HTML 里
     * 补一个 hidden,默认页就又有了第二份副本(改一处漏一处不会报错,只会让
     * HTML 初态与 TS 不一致),这条断言让那种改动直接失败.
     */
    it('index.html 的页容器不写 hidden 初值(默认页只有一处声明)', () => {
        const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');

        for (const id of ['right-page-params', 'right-page-process']) {
            const tag = new RegExp(`<div\\s+id="${id}"[^>]*>`).exec(html)?.[0];
            expect(tag).toBeDefined();
            expect(tag).not.toContain('hidden');
        }
    });
});
