/**
 * 标签页控件单测.
 *
 * 锁的是"标签页"与"按钮组"真正不同的那部分语义:roving tabindex(整组一个
 * Tab 停靠点),`aria-selected` / `aria-controls` / 面板 `aria-labelledby`
 * 三者一致,以及方向键在组内移动(含回绕).样式与显隐不在这里断言:面板的
 * `hidden` 归持有"当前页"状态的控制器(见 RightPanelTabs.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { installDomStub, type StubElement } from '../../testing/domStub';
import { createTabs } from './Tabs';

type Tab = 'params' | 'process';

function setup(): {
    stub: ReturnType<typeof installDomStub>;
    tabs: ReturnType<typeof createTabs<Tab>>;
    element: StubElement;
    paramsTab: StubElement;
    processTab: StubElement;
    paramsPanel: StubElement;
    processPanel: StubElement;
} {
    const stub = installDomStub();

    const paramsPanel = stub.document.createElement('div');
    paramsPanel.id = 'page-params';
    const processPanel = stub.document.createElement('div');
    processPanel.id = 'page-process';
    stub.document.body.append(paramsPanel, processPanel);

    const tabs = createTabs<Tab>({
        ariaLabel: '切页',
        value: 'params',
        items: [
            { value: 'params', label: '参数 / 视图', panelId: 'page-params' },
            { value: 'process', label: '过程', panelId: 'page-process' },
        ],
    });
    const container = stub.document.createElement('div');
    const element = tabs.element as unknown as StubElement;
    container.append(element);
    stub.document.body.append(container);

    return {
        stub,
        tabs,
        element,
        paramsTab: stub.document.querySelector<StubElement>('#page-params-tab')!,
        processTab: stub.document.querySelector<StubElement>('#page-process-tab')!,
        paramsPanel,
        processPanel,
    };
}

describe('结构与可访问语义', () => {
    it('根是 tablist,按钮是 tab,带 aria-controls 与 roving tabindex', () => {
        const { element, paramsTab, processTab } = setup();

        expect(element.getAttribute('role')).toBe('tablist');
        expect(element.getAttribute('aria-label')).toBe('切页');
        expect(paramsTab.getAttribute('role')).toBe('tab');
        expect(paramsTab.getAttribute('aria-controls')).toBe('page-params');
        expect(processTab.getAttribute('aria-controls')).toBe('page-process');

        // roving tabindex:整组只有一个 Tab 停靠点,落在选中的标签上.
        expect(paramsTab.getAttribute('aria-selected')).toBe('true');
        expect(paramsTab.tabIndex).toBe(0);
        expect(processTab.getAttribute('aria-selected')).toBe('false');
        expect(processTab.tabIndex).toBe(-1);
    });

    it('面板反向引用标签(aria-labelledby),读屏进面板能报出来源', () => {
        const { paramsPanel, processPanel } = setup();

        expect(paramsPanel.getAttribute('aria-labelledby')).toBe('page-params-tab');
        expect(processPanel.getAttribute('aria-labelledby')).toBe('page-process-tab');
    });
});

describe('选中', () => {
    it('点击切换选中态并回调一次', () => {
        const { tabs, paramsTab, processTab } = setup();
        const changes: Tab[] = [];
        tabs.onChange((value) => changes.push(value));

        processTab.dispatch('click');

        expect(changes).toEqual(['process']);
        expect(tabs.get()).toBe('process');
        expect(processTab.getAttribute('aria-selected')).toBe('true');
        expect(processTab.tabIndex).toBe(0);
        expect(paramsTab.getAttribute('aria-selected')).toBe('false');
        expect(paramsTab.tabIndex).toBe(-1);
    });

    it('重复点已选中的标签不回调(没有真的切换)', () => {
        const { tabs, paramsTab } = setup();
        let count = 0;
        tabs.onChange(() => {
            count += 1;
        });

        paramsTab.dispatch('click');

        expect(count).toBe(0);
    });

    it('select() 与点击走同一条写入路径', () => {
        const { tabs, processTab } = setup();
        const changes: Tab[] = [];
        tabs.onChange((value) => changes.push(value));

        tabs.select('process');

        expect(changes).toEqual(['process']);
        expect(processTab.getAttribute('aria-selected')).toBe('true');
    });
});

describe('方向键', () => {
    it('左右方向键在组内移动并回绕,且阻止默认行为', () => {
        const { tabs, element, paramsTab, processTab } = setup();
        const changes: Tab[] = [];
        tabs.onChange((value) => changes.push(value));

        let prevented = false;
        element.dispatch('keydown', {
            key: 'ArrowRight',
            preventDefault: () => {
                prevented = true;
            },
        });
        expect(prevented).toBe(true);
        expect(tabs.get()).toBe('process');

        // 从最后一个继续向右回到第一个(标签页的键盘约定是回绕,不是夹住).
        element.dispatch('keydown', { key: 'ArrowRight' });
        expect(tabs.get()).toBe('params');

        // 从第一个向左回到最后一个.
        element.dispatch('keydown', { key: 'ArrowLeft' });
        expect(tabs.get()).toBe('process');
        expect(changes).toEqual(['process', 'params', 'process']);
        expect(processTab.getAttribute('aria-selected')).toBe('true');
        expect(paramsTab.getAttribute('aria-selected')).toBe('false');
    });

    it('Home / End 跳到首尾,其它键不动选中', () => {
        const { tabs, element } = setup();

        element.dispatch('keydown', { key: 'End' });
        expect(tabs.get()).toBe('process');

        element.dispatch('keydown', { key: 'a' });
        expect(tabs.get()).toBe('process');

        element.dispatch('keydown', { key: 'Home' });
        expect(tabs.get()).toBe('params');
    });
});

describe('dispose', () => {
    it('解绑监听并清空订阅者:dispose 后点击不再改选中', () => {
        const { tabs, processTab } = setup();
        let count = 0;
        tabs.onChange(() => {
            count += 1;
        });

        tabs.dispose();
        processTab.dispatch('click');

        expect(tabs.get()).toBe('params');
        expect(count).toBe(0);
    });
});
