/**
 * 右栏标签页控制器:参数/视图页 与 过程页的归属.
 *
 * 职责被刻意收成一件事:**哪一页在前**.
 * - 页级显隐只在这里写(`hidden` 属性),与 `PanelController` 的折叠级显隐
 *   (`display` 行内样式)分开:折叠隐藏的是整个页容器,切页隐藏的是另一页,
 *   两者各写各的属性,不会互相覆盖;
 * - 页宽**不归本控制器管**:参数页与过程页共用侧栏那一份宽度(右栏宽度的
 *   唯一写入点仍是 `PanelController._applyLayout`),切页不改宽度;
 * - 分隔条比例归 `RightSplitController`,切页不动它(过程页激活时整个参数页
 *   容器被隐藏,`#params-panel` 与那根带 `data-split-page` 的分隔条一起自然
 *   退出布局,切回后比例与切走前一致).
 *
 * `dispose()` 把页归属复位成参数页:否则再次 `bind()` 会得到一个"模型在参数
 * 页,DOM 停在过程页"的自相矛盾面板(与 `PanelController` 的复位同一条理由).
 */
import { createTabs, type TabsHandle } from '../widgets/Tabs';

/** 右栏两个标签页. */
export type RightTab = 'params' | 'process';

export interface RightPanelTabsPages {
    readonly params: HTMLElement;
    readonly process: HTMLElement;
}

export interface RightPanelTabsHandlers {
    /** 页归属变化的回调:应用层据此刷新只读回显等页级内容. */
    onTabChange(tab: RightTab): void;
}

/**
 * 默认页:**唯一声明处**.
 *
 * `index.html` 里的两个页容器不写 `hidden` 初值(HTML 不留副本),构造期由
 * `_applyPages()` 按本常量写出页级显隐,`dispose()` 也复位到它.
 */
const DEFAULT_RIGHT_TAB: RightTab = 'params';

function setHidden(element: HTMLElement, hidden: boolean): void {
    if (hidden) element.setAttribute('hidden', '');
    else element.removeAttribute('hidden');
}

/**
 * 右栏标签页:标签控件在**构造期**建好,`bind()` 只负责挂进 DOM.
 *
 * 这样"控件实例"没有"已建/未建"两种状态:字段是 `readonly`,不出现
 * `tabs?.get()` 这类为了防御未 `bind()` 而存在的可选链,也不需要"重复 bind
 * 先拆旧控件"的自愈分支(调用方只有 `DslApp.start()` 一处,本来就只调一次).
 * 生命周期照旧成对:`bind()` 挂 DOM,`dispose()` 解绑并复位.
 */
export class RightPanelTabs {
    private readonly tabs: TabsHandle<RightTab>;
    private readonly unsubscribe: () => void;

    constructor(
        private readonly container: HTMLElement,
        private readonly pages: RightPanelTabsPages,
        private readonly handlers: RightPanelTabsHandlers,
    ) {
        this.tabs = createTabs<RightTab>({
            ariaLabel: '右栏视图切换',
            value: DEFAULT_RIGHT_TAB,
            items: [
                {
                    value: 'params',
                    label: '参数 / 视图',
                    panelId: pages.params.id,
                },
                { value: 'process', label: '过程', panelId: pages.process.id },
            ],
        });
        this.unsubscribe = this.tabs.onChange((tab) => {
            this._applyPages(tab);
            this.handlers.onTabChange(tab);
        });
        this._applyPages(DEFAULT_RIGHT_TAB);
    }

    /** 把标签栏挂进页头(构造期已经建好,重复调用只是重新插入同一个节点). */
    bind(): void {
        this.container.replaceChildren(this.tabs.element);
    }

    get(): RightTab {
        return this.tabs.get();
    }

    /** 编程式切页(条目的"过程"入口):与点击走同一条写入路径. */
    show(tab: RightTab): void {
        this.tabs.select(tab);
    }

    dispose(): void {
        // 先退订再复位:复位本身会触发选中回调,不该在拆解途中再通知应用层.
        this.unsubscribe();
        this.tabs.select(DEFAULT_RIGHT_TAB);
        this.tabs.dispose();
        this._applyPages(DEFAULT_RIGHT_TAB);
    }

    private _applyPages(tab: RightTab): void {
        setHidden(this.pages.params, tab !== 'params');
        setHidden(this.pages.process, tab !== 'process');
    }
}
