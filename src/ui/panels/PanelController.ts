import { UI_CONFIG } from '../../config/uiConfig';
import { bindDragGesture } from '../shared/dragGesture';

type PanelId = 'left-panel' | 'right-panel' | 'bottom-panel';

/** 只有左右侧面板有"宽度";底部面板是高度. */
type WidthPanelId = 'left-panel' | 'right-panel';

/**
 * 宽度组 id.宽度**按组**记:右栏有两个标签页,用户对参数页与过程页各拖一次,
 * 切页 = 切宽度,互不覆盖(见设计文档 3.2 第 3 条).
 *
 * 字面量联合而不是 `string`:组名是**闭集合**,写成 `string` 会把"组没登记"
 * 变成运行期才能发现的静默兜底(见 `_activeWidth`).右栏的组名与
 * `RightPanelTabs` 的 `RightTab` 取值一致(`params` / `process`),由应用层在
 * 切页时通过 {@link setWidthGroup} 告知.
 */
export type WidthGroup = 'left-panel' | 'params' | 'process';

// 尺寸的唯一真相源是 UI_CONFIG.panel(见那里的说明):这里只是取个短名字.
// 默认尺寸/折叠尺寸在 css/base.css 的 :root 里有一份首帧兜底,由
// applyUiConfig.test.ts 锁住一致性;上下限 CSS 不消费,没有第二处副本.
const {
    sideMinWidth: SIDE_MIN_WIDTH,
    sideMaxWidth: SIDE_MAX_WIDTH,
    sideDefaultWidth: SIDE_DEFAULT_WIDTH,
    footerMinHeight: FOOTER_MIN_HEIGHT,
    footerMaxHeight: FOOTER_MAX_HEIGHT,
    footerDefaultHeight: FOOTER_DEFAULT_HEIGHT,
    collapsedSideWidth: COLLAPSED_SIDE_WIDTH,
    collapsedFooterHeight: COLLAPSED_FOOTER_HEIGHT,
} = UI_CONFIG.panel;

/** 过程页(右栏第二个宽度组)的默认宽度,来自 UI_CONFIG.process. */
const PROCESS_DEFAULT_WIDTH = UI_CONFIG.process.defaultWidth;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** 一个面板的开合三件套:面板本体 + 承载按钮的头部 + 开合按钮. */
interface PanelBinding {
    readonly panel: HTMLElement;
    readonly header: HTMLElement;
    readonly button: HTMLElement;
}

/**
 * 面板布局控制器.
 *
 * 负责:
 * - 左/右 aside 的宽度调整
 * - 底部 footer 的高度调整
 * - 折叠/展开,折叠时同步 footer 的左右边界
 *
 * 折叠态只有**一个状态源**(`collapsed`)与**一个写入点**(`_applyLayout`):
 * 面板类名,正文显隐,按钮文案与 `aria-expanded/aria-controls`,CSS 变量都在那里
 * 一起刷新.这样 `bind()` / 点击开合 / `dispose()` 复位走的是同一条路径,
 * 不会再出现"模型展开,DOM 还折叠着"的分叉(见 UI-P3.3).
 */
export class PanelController {
    private root: HTMLElement | null = null;
    private _abortController: AbortController | null = null;
    /**
     * 宽度组 -> 用户拖出的宽度(px).
     *
     * 与"哪个组在前"分开:`activeWidthGroup` 是当前页归属,`sideWidths` 是各页
     * 各自的宽度;切页只换前者的指向,不动后者,所以来回切不会丢用户的调整.
     *
     * 用 `Record` 而不是 `Map`:组名是闭集合(见 `WidthGroup`),写全三个键就
     * 不再需要"组没登记"的运行期兜底.
     */
    private readonly sideWidths: Record<WidthGroup, number> = {
        'left-panel': SIDE_DEFAULT_WIDTH,
        params: SIDE_DEFAULT_WIDTH,
        process: PROCESS_DEFAULT_WIDTH,
    };
    /** 每个侧栏当前生效的宽度组(右栏随标签页切换). */
    private readonly activeWidthGroup: Record<WidthPanelId, WidthGroup> = {
        'left-panel': 'left-panel',
        'right-panel': 'params',
    };
    private footerHeight: number = FOOTER_DEFAULT_HEIGHT;
    private readonly collapsed = new Set<PanelId>();
    private readonly bindings = new Map<PanelId, PanelBinding>();

    bind(root: HTMLElement): void {
        this.root = root;
        this._abortController?.abort();
        this._abortController = new AbortController();

        const signal = this._abortController.signal;
        this._collectBindings(root);
        this._bindToggleButtons(signal);
        this._bindResizeHandles(root, signal);
        this._applyLayout();
    }

    dispose(): void {
        // 先把 DOM 复位回"全部展开"再丢状态:dispose 会清空 collapsed 集合与
        // 宽度组归属,若不复位,DOM 上的 .collapsed / display:none / "源码"式
        // 按钮文案,以及过程页那一份宽度,都会留下,之后再次 bind() 就会得到
        // 自相矛盾的面板(见 UI-P3.3).
        this.activeWidthGroup['left-panel'] = 'left-panel';
        this.activeWidthGroup['right-panel'] = 'params';
        this.collapsed.clear();
        this._applyLayout();

        this._abortController?.abort();
        this._abortController = null;
        this.bindings.clear();
        this.root = null;
        document.body.style.cursor = '';
    }

    /**
     * 切换某个侧栏生效的宽度组(右栏由标签页控制器在切页时调用).
     *
     * 宽度仍然只有 `_applyLayout` 一个写入点:这里只改"哪个组在前",随后立刻
     * 走同一条路径写出 `--right-panel-width`,不让调用方自己碰 CSS 变量.
     */
    setWidthGroup(panelId: WidthPanelId, group: WidthGroup): void {
        if (this.activeWidthGroup[panelId] === group) return;
        this.activeWidthGroup[panelId] = group;
        this._applyLayout();
    }

    /**
     * 收集 `[data-panel-toggle]` -> 面板/头部/按钮 的对应关系.
     *
     * 面板必须有 id:按钮的 `aria-controls` 要用它,`data-resize-panel` 也按同一
     * 套 id 找折叠态.
     */
    private _collectBindings(root: HTMLElement): void {
        this.bindings.clear();
        root.querySelectorAll<HTMLElement>('[data-panel-toggle]').forEach((button) => {
            const selector = button.dataset.panelToggle;
            if (!selector) return;

            const panel = document.querySelector<HTMLElement>(selector);
            if (!panel || !panel.id) return;

            const header = button.closest<HTMLElement>('.panel-header');
            if (!header) return;

            this.bindings.set(panel.id as PanelId, { panel, header, button });
        });
    }

    private _bindToggleButtons(signal: AbortSignal): void {
        for (const [panelId, binding] of this.bindings) {
            binding.button.addEventListener('click', () => {
                // 只改状态,DOM 由 _applyLayout 统一刷新.
                if (this.collapsed.has(panelId)) {
                    this.collapsed.delete(panelId);
                } else {
                    this.collapsed.add(panelId);
                }
                this._applyLayout();
            }, { signal });
        }
    }

    private _bindResizeHandles(root: HTMLElement, signal: AbortSignal): void {
        root.querySelectorAll<HTMLElement>('[data-resize-panel]').forEach((handle) => {
            const panelId = handle.dataset.resizePanel as PanelId | undefined;
            if (!panelId) return;

            bindDragGesture(handle, signal, {
                // 折叠时分隔条不可拖:面板已经收窄到 COLLAPSED_SIDE_WIDTH,
                // 再拖宽度只会写出一个展开后立刻跳变的值.
                canStart: () => !this.collapsed.has(panelId),
                onStart: () => {},
                onDelta: (deltaX, deltaY) => {
                    if (panelId === 'bottom-panel') {
                        // 底部面板向上拖(负位移)才是变高.
                        this.footerHeight = clamp(
                            this.footerHeight - deltaY,
                            FOOTER_MIN_HEIGHT,
                            FOOTER_MAX_HEIGHT,
                        );
                    } else {
                        // 左面板向右拖(正位移)变宽;右面板向左拖(负位移)才是变宽.
                        // 右面板只有一根宽度手柄,它改的是**当前生效的宽度组**
                        // (切页 = 换组),不让"哪一页在前"变成第二个写宽度的入口.
                        const group = this.activeWidthGroup[panelId];
                        const sign = panelId === 'left-panel' ? 1 : -1;
                        this.sideWidths[group] = clamp(
                            this.sideWidths[group] + sign * deltaX,
                            SIDE_MIN_WIDTH,
                            SIDE_MAX_WIDTH,
                        );
                    }
                    this._applyLayout();
                },
                onEnd: () => {},
            });
        });
    }

    /** 当前生效组的宽度.组名是闭集合,查表一定命中,不需要兜底. */
    private _activeWidth(panelId: WidthPanelId): number {
        return this.sideWidths[this.activeWidthGroup[panelId]];
    }

    /**
     * 折叠态与尺寸的唯一写入点.
     *
     * 折叠时只保留"承载开合按钮的那个 header",其余直接子元素隐藏:放在这里
     * (而不是点击回调里遍历一次)让 bind / 开合 / dispose 复位都走同一条路径,
     * 折叠期间新增的直接子元素也会在下次布局时被收起.比较后再写,拖拽时
     * 每帧重复调用不会产生多余的样式写入.
     */
    private _applyLayout(): void {
        if (!this.root) return;

        for (const [panelId, binding] of this.bindings) {
            const collapsed = this.collapsed.has(panelId);
            binding.panel.classList.toggle('collapsed', collapsed);

            for (const child of Array.from(binding.panel.children)) {
                if (child === binding.header) continue;
                const element = child as HTMLElement;
                const display = collapsed ? 'none' : '';
                if (element.style.display !== display) {
                    element.style.display = display;
                }
            }

            // 文案说明"按下会发生什么":折叠态是"展开",不是面板名(UI-P3.2).
            binding.button.textContent = collapsed ? '展开' : '收起';
            binding.button.setAttribute('aria-expanded', String(!collapsed));
            binding.button.setAttribute('aria-controls', binding.panel.id);
        }

        this.root.style.setProperty(
            '--left-panel-width',
            `${this.collapsed.has('left-panel') ? COLLAPSED_SIDE_WIDTH : this._activeWidth('left-panel')}px`,
        );
        this.root.style.setProperty(
            '--right-panel-width',
            `${this.collapsed.has('right-panel') ? COLLAPSED_SIDE_WIDTH : this._activeWidth('right-panel')}px`,
        );
        this.root.style.setProperty(
            '--footer-height',
            `${this.collapsed.has('bottom-panel') ? COLLAPSED_FOOTER_HEIGHT : this.footerHeight}px`,
        );
    }
}
