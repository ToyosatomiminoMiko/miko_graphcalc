/**
 * 右栏标签页控制器:参数/视图页 与 过程页的归属.
 *
 * 职责被刻意收成一件事:**哪一页在前**.
 * - 页级显隐只在这里写(`hidden` 属性),与 `PanelController` 的折叠级显隐
 *   (`display` 行内样式)分开:折叠隐藏的是整个页容器,切页隐藏的是另一页,
 *   两者各写各的属性,不会互相覆盖;
 * - 页宽走 `PanelController.setWidthGroup`(宽度的唯一写入点),本控制器不碰
 *   `--right-panel-width`;
 * - 分隔条比例归 `RightSplitController`,切页不动它(过程页激活时整个参数页
 *   容器被隐藏,`#params-panel`/`#right-splitter` 自然退出布局,切回后比例
 *   与切走前一致).
 *
 * `dispose()` 把页归属复位成参数页:否则再次 `bind()` 会得到一个"模型在参数
 * 页,DOM 停在过程页"的自相矛盾面板(与 `PanelController` 的复位同一条理由).
 */
import { createTabs, type TabsHandle } from '../widgets/Tabs';

/** 右栏两个标签页;值同时用作宽度组 id(`PanelController` 按它记宽). */
export type RightTab = 'params' | 'process';

export interface RightPanelTabsPages {
    readonly params: HTMLElement;
    readonly process: HTMLElement;
}

export interface RightPanelTabsHandlers {
    /** 页归属变化的回调:应用层据此切换右栏宽度组. */
    onTabChange(tab: RightTab): void;
}

/** 默认页:与 `index.html` 里 `#right-page-process` 带 `hidden` 的初态一致. */
export const DEFAULT_RIGHT_TAB: RightTab = 'params';

function setHidden(element: HTMLElement, hidden: boolean): void {
    if (hidden) element.setAttribute('hidden', '');
    else element.removeAttribute('hidden');
}

export class RightPanelTabs {
    private tabs: TabsHandle<RightTab> | null = null;
    private unsubscribe: (() => void) | null = null;

    constructor(
        private readonly container: HTMLElement,
        private readonly pages: RightPanelTabsPages,
        private readonly handlers: RightPanelTabsHandlers,
    ) {}

    bind(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.tabs?.dispose();

        this.tabs = createTabs<RightTab>({
            ariaLabel: '右栏视图切换',
            value: DEFAULT_RIGHT_TAB,
            items: [
                {
                    value: 'params',
                    label: '参数 / 视图',
                    panelId: this.pages.params.id,
                },
                { value: 'process', label: '过程', panelId: this.pages.process.id },
            ],
        });
        this.container.replaceChildren(this.tabs.element);
        this.unsubscribe = this.tabs.onChange((tab) => {
            this._applyPages(tab);
            this.handlers.onTabChange(tab);
        });

        this._applyPages(DEFAULT_RIGHT_TAB);
    }

    get(): RightTab {
        return this.tabs?.get() ?? DEFAULT_RIGHT_TAB;
    }

    /** 编程式切页(条目的"过程"入口):与点击走同一条写入路径. */
    show(tab: RightTab): void {
        this.tabs?.select(tab);
    }

    dispose(): void {
        // 先退订再复位:复位本身会触发选中回调,不该在拆解途中再通知应用层.
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.tabs?.select(DEFAULT_RIGHT_TAB);
        this.tabs?.dispose();
        this.tabs = null;
        this._applyPages(DEFAULT_RIGHT_TAB);
    }

    private _applyPages(tab: RightTab): void {
        setHidden(this.pages.params, tab !== 'params');
        setHidden(this.pages.process, tab !== 'process');
    }
}
