/**
 * 右侧面板"参数区 / 视图区"分隔条控制器.
 *
 * 参数页通高不变,参数区与视图区只是分同一块可用高度:分隔条上下拖动就是
 * 把高度从一边挪到另一边.过程页激活时整个参数页容器被 `hidden`,分隔条与
 * 参数区一起退出布局,比例冻结在最后的值上.
 *
 * 状态只有一份:`basisRatio`(参数区占**参数页**高度的比例),唯一写入点是
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

import { UI_CONFIG } from '../../config/uiConfig';
import { bindDragGesture } from '../shared/dragGesture';

/**
 * 参数区占右面板高度的比例边界:两边都必须留出可点可看的一块.
 *
 * 值来自 UI_CONFIG.panel(唯一真相源);边界只有这里当数字用,CSS 不消费,
 * 因此没有第二处副本.默认比例另外在 css/base.css 有首帧兜底,由
 * RightSplitController.test.ts 锁住一致.
 */
export const SPLIT_MIN_RATIO = UI_CONFIG.panel.splitMinRatio;
export const SPLIT_MAX_RATIO = UI_CONFIG.panel.splitMaxRatio;
/** 默认比例,与"参数区 flex-grow,视图区 max-height: 40%"的初始观感一致. */
export const SPLIT_DEFAULT_RATIO = UI_CONFIG.panel.splitDefaultRatio;

/** 键盘一次调整的比例步长. */
const KEY_STEP = 0.03;

/**
 * 分隔条与"比例基准页容器"的连接点.
 *
 * 与 `PanelController` 的 `[data-resize-panel]` 同一约定:**数据属性负责连接,
 * id 只留给锚点与无障碍**.因此控制器不再认识 `#right-splitter` 这个 id:
 * 标记里换/去掉那个 id 都不用改控制器,分隔条换个位置也照样绑得上.
 */
const SPLIT_PAGE_ATTRIBUTE = 'data-split-page';

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
 * 基准是**参数页容器**(`#right-page-params`)而不是右面板本身:右栏改成标签页
 * 之后,参数页的顶边比面板顶边低了一个标签栏,拿面板矩形当基准会整体偏移一个
 * 标签栏的高度(见设计文档 3.2 第 2 条).页容器上恢复了
 * `display:flex; flex-direction:column; flex:1; min-height:0`,参数页占**页高度**
 * 的比例与 `#params-panel { flex-basis }` 的参照系一致.
 *
 * 页容器高度为 0(过程页激活时整页被 hidden,或尚未布局)时返回 null,
 * 调用方跳过这一帧.
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
    private abortController: AbortController | null = null;
    private ratio: number = SPLIT_DEFAULT_RATIO;
    /**
     * 参数页容器节点:拖动时每次移动都要量它的高度.
     *
     * 缓存而不是每帧 `querySelector`:拖动是每帧路径,不该在热路径上查 DOM.
     * 只持有这一个节点(分隔条由共用拖动件自己管),`dispose` 时一并清掉.
     */
    private page: HTMLElement | null = null;

    bind(root: HTMLElement): void {
        this.root = root;
        this.abortController?.abort();
        this.abortController = new AbortController();

        const handle = root.querySelector<HTMLElement>(`[${SPLIT_PAGE_ATTRIBUTE}]`);
        const page = this._resolvePage(handle);
        if (!handle || !page) {
            // 结构缺失就是结构缺失:不写变量,也不装作绑好了.分隔条指向的页
            // 容器不存在时与根本没有分隔条同样处理.
            this.page = null;
            return;
        }

        this.page = page;
        const signal = this.abortController.signal;

        // 拖动本身(起手/累计/收尾/光标/指针捕获)走共用件;本控制器只解释
        // "向上拖 = 参数区变小"这一条业务规则.
        bindDragGesture(handle, signal, {
            onStart: () => {},
            onDelta: (_deltaX, deltaY) => {
                this._shift(deltaY);
            },
            onEnd: () => {},
        });
        handle.addEventListener('keydown', this._onKeyDown, { signal });

        this._applySplit();
    }

    dispose(): void {
        // 先 abort 再清引用:共用拖动件会在 abort 时收尾(复位光标/拖动类名),
        // 这一步必须发生在 root 被丢掉之前.
        this.abortController?.abort();
        this.abortController = null;
        this.root = null;
        this.page = null;
    }

    /** 比例的唯一写入点:写成 CSS 变量,由面板样式消费. */
    private _applySplit(): void {
        this.root?.style.setProperty('--right-split-basis', `${this.ratio * 100}%`);
    }

    /**
     * 分隔条的 `data-split-page` -> 页容器.
     *
     * 属性值是页容器的 id,这里再拼成 `#id` 从 root 子树里找 -- 与
     * `PanelController` 解析 `data-panel-toggle` 完全同一套写法(那边也不把
     * `#` 写进标记,也走 root/document 的 `querySelector`).缺失或指错(页容器
     * 不存在)时返回 null,由 `bind()` 当作"结构缺失"跳过,不抛错也不写变量.
     */
    private _resolvePage(handle: HTMLElement | null): HTMLElement | null {
        const pageId = handle?.dataset.splitPage;
        if (!pageId) return null;
        return this.root?.querySelector<HTMLElement>(`#${pageId}`) ?? null;
    }

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

    /** 按指针位移调整比例;参数页高度为 0 时(过程页激活/未布局)忽略这一帧. */
    private _shift(deltaPixels: number): void {
        const page = this.page;
        if (!page) return;
        const height = page.clientHeight;
        if (height <= 0) return;
        this.ratio = roundRatio(clamp(
            this.ratio + deltaPixels / height,
            SPLIT_MIN_RATIO,
            SPLIT_MAX_RATIO,
        ));
        this._applySplit();
    }
}
