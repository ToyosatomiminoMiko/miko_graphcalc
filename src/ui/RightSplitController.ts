/**
 * 右侧面板"参数区 / 视图区"分隔条控制器.
 *
 * 右面板通高不变,参数区与视图区只是分同一块可用高度:分隔条上下拖动就是
 * 把高度从一边挪到另一边.
 *
 * 状态只有一份:`basisRatio`(参数区占右面板高度的比例),唯一写入点是
 * `_applySplit()`--它把比例写成根节点上的 `--right-split-basis`,由
 * `css/panels.css` 的 `#params-panel` 消费(见那里的 flex-basis).拖动与
 * 键盘调整都只改这一个数,不直接写元素高度,因此和"参数区最小高度/视图区
 * 最大高度"这些下限上限不会互相打架:比例再极端也只是被 CSS 夹住.
 *
 * 与 `PanelController` 同一套手势约定:pointerdown 起手,pointermove 拖动,
 * pointerup/pointercancel 收尾,监听绑在 window 上并用 `{ signal }` 统一摘除,
 * 因此指针拖出分隔条甚至拖出窗口也不会丢事件.
 *
 * 刻意**不落 localStorage**:本仓库明确约定界面偏好不落本地存储,刷新后
 * 回到默认比例(见 README 的"代码区字体与 KaTeX 字号"一节).
 */

/** 分隔条 DOM 契约. */
export interface RightSplitBinding {
    /** 分隔条本身(拖动与键盘的落点). */
    readonly handle: HTMLElement;
    /** 右面板:量高度与顶边用. */
    readonly panel: HTMLElement;
}

/** 参数区占右面板高度的比例边界:两边都必须留出可点可看的一块. */
export const SPLIT_MIN_RATIO = 0.15;
export const SPLIT_MAX_RATIO = 0.8;
/** 默认比例,与"参数区 flex-grow,视图区 max-height: 40%"的初始观感一致. */
export const SPLIT_DEFAULT_RATIO = 0.4;

/** 键盘一次调整的比例步长. */
const KEY_STEP = 0.03;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/**
 * 比例保留 4 位小数.
 *
 * 不这么做的话 `0.4 + 0.03` 会写成 `43.00000000000001%` 这种 CSS 值:
 * 视觉上无害,但单测与快照里全是浮点噪声.4 位比"一个像素在 600px 面板里
 * 占的比例"还细,拖动精度不受影响.
 */
function roundRatio(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}

/**
 * 指针位置 -> 参数区比例.
 *
 * 参数区是右面板的第一个子元素,它的顶边就是右面板顶边,所以"分隔条当前
 * 落在面板高度的百分之几"正好等于"参数区占面板高度的百分之几"--拖动时
 * 不必反推 `flex-basis` 的解析结果,量一次矩形就够.
 *
 * 面板高度为 0(尚未布局/已折叠)时返回 null,调用方跳过这一帧.
 */
export function computeSplitRatio(
    pointerY: number,
    panelRect: { readonly top: number; readonly height: number },
): number | null {
    if (panelRect.height <= 0) return null;
    return clamp((pointerY - panelRect.top) / panelRect.height, SPLIT_MIN_RATIO, SPLIT_MAX_RATIO);
}

export class RightSplitController {
    private root: HTMLElement | null = null;
    private binding: RightSplitBinding | null = null;
    private abortController: AbortController | null = null;
    private dragging = false;
    private ratio = SPLIT_DEFAULT_RATIO;
    /** 上一次指针的 y;拖动中每次移动都把它当作新的基准点(见 _onPointerMove). */
    private lastPointerY: number | null = null;

    bind(root: HTMLElement): void {
        this.root = root;
        this.abortController?.abort();
        this.abortController = new AbortController();

        const handle = root.querySelector<HTMLElement>('#right-splitter');
        const panel = root.querySelector<HTMLElement>('#right-panel');
        if (!handle || !panel) {
            this.binding = null;
            return;
        }

        this.binding = { handle, panel };
        const signal = this.abortController.signal;

        handle.addEventListener('pointerdown', this._onPointerDown, { signal });
        handle.addEventListener('pointermove', this._onPointerMove, { signal });
        handle.addEventListener('pointerup', this._onPointerUp, { signal });
        handle.addEventListener('pointercancel', this._onPointerUp, { signal });
        handle.addEventListener('keydown', this._onKeyDown, { signal });

        this.lastPointerY = null;
        this._applySplit();
    }

    dispose(): void {
        this.abortController?.abort();
        this.abortController = null;
        this._endDrag();
        this.binding = null;
        this.root = null;
        this.lastPointerY = null;
    }

    /** 比例的唯一写入点:写成 CSS 变量,由面板样式消费. */
    private _applySplit(): void {
        this.root?.style.setProperty('--right-split-basis', `${this.ratio * 100}%`);
    }

    private _onPointerDown = (event: PointerEvent): void => {
        if (!this.binding) return;
        event.preventDefault();
        this.dragging = true;
        this.lastPointerY = event.clientY;
        // 指针捕获:拖出分隔条(甚至拖出窗口)仍能收到 pointermove,
        // 触屏/触控笔也不会被浏览器的手势识别抢走.
        this.binding.handle.setPointerCapture?.(event.pointerId);
        this.binding.handle.classList.add('is-dragging');
        document.body.style.cursor = 'ns-resize';
    };

    private _onPointerMove = (event: PointerEvent): void => {
        if (!this.dragging || !this.binding) return;
        const previousY = this.lastPointerY ?? event.clientY;
        this.lastPointerY = event.clientY;
        // 相对上一次落点累计,而不是"起点 + 总位移":比例被上下限夹住后,
        // 指针回退一小段就能立刻重新跟手,不会出现一段"死区".
        this._shift(event.clientY - previousY);
    };

    private _onPointerUp = (event: PointerEvent): void => {
        const handle = this.binding?.handle;
        if (handle?.hasPointerCapture?.(event.pointerId)) {
            handle.releasePointerCapture(event.pointerId);
        }
        this._endDrag();
    };

    private _onKeyDown = (event: KeyboardEvent): void => {
        // 分隔条是水平的一条:向上/向左 = 参数区变小,向下/向右 = 变大.
        const step = event.key === 'ArrowUp' || event.key === 'ArrowLeft'
            ? -KEY_STEP
            : event.key === 'ArrowDown' || event.key === 'ArrowRight'
                ? KEY_STEP
                : 0;
        if (step === 0) return;
        event.preventDefault();
        this.ratio = roundRatio(clamp(this.ratio + step, SPLIT_MIN_RATIO, SPLIT_MAX_RATIO));
        this._applySplit();
    };

    /** 按指针位移调整比例;面板高度为 0 时(未布局)忽略这一帧. */
    private _shift(deltaPixels: number): void {
        const panel = this.binding?.panel;
        if (!panel) return;
        const height = panel.clientHeight;
        if (height <= 0) return;
        this.ratio = roundRatio(clamp(
            this.ratio + deltaPixels / height,
            SPLIT_MIN_RATIO,
            SPLIT_MAX_RATIO,
        ));
        this._applySplit();
    }

    private _endDrag(): void {
        if (!this.dragging) return;
        this.dragging = false;
        this.binding?.handle.classList.remove('is-dragging');
        document.body.style.cursor = '';
    }
}
