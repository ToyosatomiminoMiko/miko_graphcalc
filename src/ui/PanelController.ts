type PanelId = 'left-panel' | 'right-panel' | 'bottom-panel';

const SIDE_MIN_WIDTH = 220;
const SIDE_MAX_WIDTH = 560;
const SIDE_DEFAULT_WIDTH = 300;
const FOOTER_MIN_HEIGHT = 160;
const FOOTER_MAX_HEIGHT = 640;
const FOOTER_DEFAULT_HEIGHT = 240;
const COLLAPSED_SIDE_WIDTH = 44;
const COLLAPSED_FOOTER_HEIGHT = 40;

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
    private readonly sideWidths: Record<'left-panel' | 'right-panel', number> = {
        'left-panel': SIDE_DEFAULT_WIDTH,
        'right-panel': SIDE_DEFAULT_WIDTH,
    };
    private footerHeight = FOOTER_DEFAULT_HEIGHT;
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
        // 先把 DOM 复位回"全部展开"再丢状态:dispose 会清空 collapsed 集合,
        // 若不复位,DOM 上的 .collapsed / display:none / "源码"式按钮文案会留下,
        // 之后再次 bind() 就会得到自相矛盾的面板(见 UI-P3.3).
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

            handle.addEventListener('pointerdown', (event: PointerEvent) => {
                if (this.collapsed.has(panelId)) return;
                event.preventDefault();

                const startX = event.clientX;
                const startY = event.clientY;
                const startLeftWidth = this.sideWidths['left-panel'];
                const startRightWidth = this.sideWidths['right-panel'];
                const startFooterHeight = this.footerHeight;
                const cursor = getComputedStyle(handle).cursor;
                document.body.style.cursor = cursor;

                const onPointerMove = (moveEvent: PointerEvent): void => {
                    if (panelId === 'left-panel') {
                        this.sideWidths['left-panel'] = clamp(
                            startLeftWidth + (moveEvent.clientX - startX),
                            SIDE_MIN_WIDTH,
                            SIDE_MAX_WIDTH,
                        );
                    } else if (panelId === 'right-panel') {
                        this.sideWidths['right-panel'] = clamp(
                            startRightWidth + (startX - moveEvent.clientX),
                            SIDE_MIN_WIDTH,
                            SIDE_MAX_WIDTH,
                        );
                    } else {
                        this.footerHeight = clamp(
                            startFooterHeight + (startY - moveEvent.clientY),
                            FOOTER_MIN_HEIGHT,
                            FOOTER_MAX_HEIGHT,
                        );
                    }

                    this._applyLayout();
                };

                const onPointerUp = (): void => {
                    window.removeEventListener('pointermove', onPointerMove);
                    window.removeEventListener('pointerup', onPointerUp);
                    window.removeEventListener('pointercancel', onPointerUp);
                    document.body.style.cursor = '';
                };

                window.addEventListener('pointermove', onPointerMove, { signal });
                window.addEventListener('pointerup', onPointerUp, { signal });
                window.addEventListener('pointercancel', onPointerUp, { signal });
            }, { signal });
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
