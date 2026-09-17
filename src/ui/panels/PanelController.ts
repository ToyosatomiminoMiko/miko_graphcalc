import { UI_CONFIG } from '@/config/uiConfig';
import { bindDragGesture } from '@/ui/shared/dragGesture';

type PanelId = 'left-panel' | 'right-panel' | 'bottom-panel';

/** 只有左右侧面板有"宽度";底部面板是高度. */
type WidthPanelId = 'left-panel' | 'right-panel';

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
     * 侧栏 -> 用户拖出的宽度(px).
     *
     * 左右各一份,与右栏标签页无关:参数页与过程页**共用同一份宽度**,切页不
     * 改宽度(否则切一次页栏宽就跳一次,见 `_applyLayout`).
     *
     * 用 `Record` 而不是 `Map`:面板 id 是闭集合(见 `WidthPanelId`),写全两个键
     * 就不再需要"面板没登记"的运行期兜底.
     */
    private readonly sideWidths: Record<WidthPanelId, number> = {
        'left-panel': SIDE_DEFAULT_WIDTH,
        'right-panel': SIDE_DEFAULT_WIDTH,
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
        // 先把 DOM 复位回"全部展开 + 默认尺寸"再丢状态:dispose 会清空 collapsed
        // 集合,把用户拖出的宽/高写回默认值,若不复位,DOM 上的 .collapsed /
        // display:none / "源码"式按钮文案,以及拖出来的尺寸,都会留下,之后再次
        // bind() 就会得到自相矛盾的面板(见 UI-P3.3).
        this.sideWidths['left-panel'] = SIDE_DEFAULT_WIDTH;
        this.sideWidths['right-panel'] = SIDE_DEFAULT_WIDTH;
        this.footerHeight = FOOTER_DEFAULT_HEIGHT;
        this.collapsed.clear();
        this._applyLayout();

        this._abortController?.abort();
        this._abortController = null;
        this.bindings.clear();
        this.root = null;
        document.body.style.cursor = '';
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
                        // 右面板只有一根宽度手柄,一份宽度:参数页与过程页共用,
                        // 切页不会把用户的调整换成另一份值.
                        const sign = panelId === 'left-panel' ? 1 : -1;
                        this.sideWidths[panelId] = clamp(
                            this.sideWidths[panelId] + sign * deltaX,
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
            `${this.collapsed.has('left-panel') ? COLLAPSED_SIDE_WIDTH : this.sideWidths['left-panel']}px`,
        );
        this.root.style.setProperty(
            '--right-panel-width',
            `${this.collapsed.has('right-panel') ? COLLAPSED_SIDE_WIDTH : this.sideWidths['right-panel']}px`,
        );
        this.root.style.setProperty(
            '--footer-height',
            `${this.collapsed.has('bottom-panel') ? COLLAPSED_FOOTER_HEIGHT : this.footerHeight}px`,
        );
    }
}
