/**
 * 窗口注册表 + 状态机 + z-order + 焦点 + 几何写入.
 *
 * 两条硬约束(继承自 `PanelController`,它当年就是为了修"模型与 DOM 分叉"):
 *
 * 1. **几何的唯一写入点**是 `_applyGeometry`:普通态把 `geometry` 逐条写进
 *    `left/top/width/height`;`maximized` / `fullscreen` 态**清掉**这四条行内属性
 *    (几何交给 CSS 类的 `inset: 0`).它不写类名,也**不碰 `z-index`**.
 * 2. **状态的唯一写入点**是 `_applyState`:`.window` 上的每一个类(除
 *    `.is-focused`)都在这里切,并刷新 `inert` / `aria-hidden` / 窗口按钮文案 /
 *    Dock 的激活态与状态点.
 *
 * `z-index` 有第三个写入点:`focus()`.几何写入会清行内属性,两者必须分开,
 * 否则会出现"拖动第一帧窗口就掉到后面"(见 docs/windowing-plan.md §11.2 E8).
 */
import { UI_CONFIG, type WindowConfigEntry, type WindowId } from '@/config/uiConfig';
import { bindDragGesture } from '@/ui/shared/dragGesture';
import type { Child } from '@/ui/widgets/dom';
import { createDock, type DockHandle } from './Dock';
import {
    clampGeometry,
    fitGeometry,
    magnetize,
    moveGeometry,
    resolveDefaultGeometry,
    resolveEdgeSnap,
    type Desktop,
    type Geometry,
    type Limits,
    type SnapKind,
} from './WindowGeometry';
import { clearGeometry, createWindowFrame, writeGeometry, type WindowActionButton, type WindowFrameHandle } from './WindowFrame';
import { bindWindowResize } from './WindowResize';
import { createSnapPreview, type SnapPreviewHandle } from './SnapPreview';

export type WindowState = 'normal' | 'maximized' | 'fullscreen' | 'minimized' | 'closed';

/**
 * 标题栏"双击最大化"的判定阈值(ms).
 *
 * 为什么不用 `dblclick`:拖动件在 `pointerdown` 里 `preventDefault()`(为了
 * 不选中标题文字),而浏览器正是在这一步决定要不要继续派发兼容鼠标事件,
 * 双击能不能到 `dblclick` 就变成了实现细节.按"两次 pointerdown 的间隔"判定
 * 不依赖任何兼容事件,触屏也照样成立(§10 原本担心的正是这个).
 */
const DOUBLE_CLICK_MS = 300;

/** 从 `index.html` 搬进窗口的既有节点(不是重建的). */
export interface WindowContent {
    /** 标题栏动作:示例 / RUN. */
    readonly actions?: readonly Child[];
    /** 标题栏浮层:`#example-menu`. */
    readonly overlays?: readonly Child[];
    /** 标题里的额外内容:`#formula-copy-hint`. */
    readonly titleContent?: readonly Child[];
}

/**
 * 按窗口 id 取既有节点.
 *
 * 这些节点(`#example-btn` / `#run-btn` / `#example-menu` / `#formula-copy-hint`)
 * 的 id,监听与控制器都属于装配层,所以由 `DslApp` 提供,`WindowManager` 不按
 * id 去猜它们的位置(见 §5.2 的接线清单).
 */
export type WindowContentProvider = (id: WindowId) => WindowContent;

interface Entry {
    readonly spec: WindowConfigEntry;
    readonly frame: WindowFrameHandle;
    readonly host: HTMLElement;
    /** 唯一几何真相源(普通态);最大化/最小化不改它. */
    geometry: Geometry;
    /** 进入 maximized/fullscreen 前的几何,还原用. */
    restore: Geometry | null;
    state: WindowState;
    /** 每个窗口一份:拖动/缩放的指针监听在它上面 abort. */
    readonly gesture: AbortController;
    /** 该窗口当前的 z-index(`focus()` 写;几何写入不得碰它). */
    zIndex: number;
}

/** 一次拖动里"松开会落到哪"的临时结论(不写进 entry.geometry). */
interface PendingSnap {
    readonly id: WindowId;
    readonly kind: SnapKind;
    readonly target: Geometry;
}

export class WindowManager {
    private readonly entries = new Map<WindowId, Entry>();
    private readonly geometryListeners = new Set<(id: WindowId) => void>();
    private readonly abort = new AbortController();
    private dock: DockHandle | null = null;
    private snapPreview: SnapPreviewHandle | null = null;
    private root: HTMLElement | null = null;
    private desktop: Desktop = { w: 0, h: 0, dockReserve: 0, edgeGap: 0 };
    private z = UI_CONFIG.window.z.first;
    private focusedId: WindowId | null = null;
    private pendingSnap: PendingSnap | null = null;
    /** 每个窗口上一次"标题栏按下"的时间戳,只服务双击判定. */
    private readonly lastTitleDown = new Map<WindowId, number>();
    /** `bind()` 只允许生效一次(见该方法). */
    private bound = false;

    /**
     * @param layer       `#window-layer`:窗口的定位参照与 z-order 层
     * @param dockElement `#dock`:底部任务栏容器
     * @param snapElement `#snap-preview`:吸附高亮层
     * @param content     既有节点的提供者(见 {@link WindowContentProvider})
     */
    constructor(
        private readonly layer: HTMLElement,
        private readonly dockElement: HTMLElement,
        private readonly snapElement: HTMLElement,
        private readonly content: WindowContentProvider,
    ) {}

    /**
     * 建 frame + 搬宿主 + 建 Dock + 起初始焦点 + 挂 resize.
     *
     * 顺序不能换:①先算全部默认几何(数组顺序即依赖顺序);②建 frame 并**先取
     * 宿主再 append**(那一刻宿主还在 `#app` 里,`layer.querySelector` 查不到它);
     * ③Dock;④初始焦点(没有焦点就没有 z 序参照).
     */
    bind(): void {
        if (this.bound) {
            throw new Error(
                'WindowManager: bind() 只能调用一次;dispose() 之后不支持重建'
                + '(监听用的 AbortController 已经 abort,再 bind 会静默产出不可交互的窗口)',
            );
        }
        this.bound = true;

        const root = this.layer.parentElement;
        if (!root) throw new Error('WindowManager: #window-layer 必须挂在桌面容器里');
        this.root = root;
        this.desktop = this._measureDesktop();

        // 三层容器的 z-index 来自配置(唯一来源):层必须在视口之上,Dock 在层
        // 之上;吸附预览在层**之下**(见 UI_CONFIG.window.z 的说明).窗口之间
        // 的取号由 focus() 独占写入.
        this.layer.style.zIndex = String(UI_CONFIG.window.z.windowLayer);
        this.snapElement.style.zIndex = String(UI_CONFIG.window.z.snapPreview);
        this.dockElement.style.zIndex = String(UI_CONFIG.window.z.dock);

        // 1) 默认几何:数组顺序即依赖顺序(view 依赖 source,process 依赖 params).
        const resolved = new Map<WindowId, Geometry>();
        for (const spec of UI_CONFIG.window.windows) {
            resolved.set(spec.id, resolveDefaultGeometry(spec.defaultGeometry, this.desktop, resolved));
        }

        // 2) 逐个建窗口.
        for (const spec of UI_CONFIG.window.windows) {
            const content = this.content(spec.id);
            const frame = createWindowFrame({
                id: spec.id,
                title: spec.title,
                titleContent: content.titleContent ?? [],
                actions: content.actions ?? [],
                overlays: content.overlays ?? [],
                controls: this._actionButtons(spec.id),
                geometry: resolved.get(spec.id)!,
            });

            const host = document.getElementById(spec.hostId);
            if (!host) {
                throw new Error(`WindowManager: 找不到窗口 ${spec.id} 的正文宿主 #${spec.hostId}`);
            }
            frame.body.append(host);
            this.layer.append(frame.element);

            this.z += 1;
            const entry: Entry = {
                spec,
                frame,
                host,
                geometry: resolved.get(spec.id)!,
                restore: null,
                state: 'normal',
                gesture: new AbortController(),
                // 初始 z 按清单顺序递增:没有焦点时"可见窗口中 z 最高者"才有确定含义.
                zIndex: this.z,
            };
            this.entries.set(spec.id, entry);
            // 默认几何也要过一遍夹取:`resolveDefaultGeometry` 只做锚点换算,
            // 小视口下它的结果可以低于 `minSize`(`view` 在 1280x700 上是 159 <
            // 180),`objects` 的 `y` 甚至可能为负(标题栏被顶出桌顶,再也抓不回来).
            // 与 `setGeometry` / `restoreAll` / `onDesktopResize` 共用 `fitGeometry`,
            // 初始态不再是唯一例外.
            entry.geometry = fitGeometry(entry.geometry, this._limits(entry));
            // 初始 z 也要落到 DOM 上:层叠顺序不能靠 DOM 顺序(窗口层是个
            // 独立的层,z-index: auto 的窗口会被显式取号的窗口压住).
            frame.element.style.zIndex = String(entry.zIndex);

            this._bindWindowMove(entry);
            this._bindWindowRaise(entry);
            for (const handle of frame.handles) {
                bindWindowResize(handle.element, entry.gesture.signal, handle.direction,
                    (next) => this.setGeometry(spec.id, next),
                    { geometry: () => entry.geometry, state: () => entry.state });
            }

            this._applyGeometry(spec.id);
            this._applyState(spec.id);
        }

        // 3) Dock:`#dock` 的监听与 window.resize 一起挂在 this.abort 上.
        this.snapPreview = createSnapPreview(this.snapElement);
        this.dock = createDock(this.dockElement, {
            onSelect: (id) => this._onDockSelect(id),
            onExitFullscreen: () => this.exitFullscreen(),
            onRestoreAll: () => this.restoreAll(),
        });

        // 0) 桌面尺寸变化:重新夹取(旧稿漏了这条).
        window.addEventListener('resize', this.onDesktopResize, { signal: this.abort.signal });

        // 4) 初始焦点必须有一个,否则 z 序没有参照.
        const first = UI_CONFIG.window.windows[0]?.id;
        if (first) this.focus(first, { takeDomFocus: false });
    }

    /**
     * 抬升并聚焦:唯一入口(§3.2).
     *
     * **指针路径默认不夺 DOM 焦点**:点在编辑器里光标不能丢,点在参数输入框里
     * 焦点不能被窗口抢走.只有程序路径(`reveal()` / Dock 点击)才传
     * `takeDomFocus: true`.
     */
    focus(id: WindowId, options: { takeDomFocus?: boolean } = {}): void {
        const entry = this.entries.get(id);
        if (!entry || this._hidden(entry)) return;

        this.focusedId = id;
        // 从 110 起递增,不做取模回收:会话内几百次提升不会溢出,回收只会引入
        // "层级回绕"的隐蔽 bug.
        this.z += 1;
        entry.zIndex = this.z;
        // z-index 只在这里写(几何写入不碰它).
        entry.frame.element.style.zIndex = String(entry.zIndex);

        for (const other of this.entries.values()) {
            other.frame.element.classList.toggle('is-focused', other.spec.id === id);
        }
        this.dock?.setActive(id);

        if (options.takeDomFocus === true) {
            // `preventScroll`:聚焦不该把窗口正文滚一下.
            entry.frame.element.focus({ preventScroll: true });
        }
    }

    /** 恢复可见 + 抬升聚焦(点条目末尾的"过程",Dock 点击都走这里). */
    reveal(id: WindowId): void {
        const entry = this.entries.get(id);
        if (!entry) return;
        if (this._hidden(entry)) {
            entry.state = 'normal';
            this._applyState(id);
            this._applyGeometry(id);
        }
        this.focus(id, { takeDomFocus: true });
    }

    getState(id: WindowId): WindowState {
        const entry = this.entries.get(id);
        if (!entry) throw new Error(`WindowManager: 未登记的窗口 ${id}`);
        return entry.state;
    }

    getGeometry(id: WindowId): Geometry {
        const entry = this.entries.get(id);
        if (!entry) throw new Error(`WindowManager: 未登记的窗口 ${id}`);
        return entry.geometry;
    }

    /** 几何落地后的回调(编辑器行号/高亮层要跟着重排).返回退订函数. */
    onGeometryChange(listener: (id: WindowId) => void): () => void {
        this.geometryListeners.add(listener);
        return () => this.geometryListeners.delete(listener);
    }

    setMinimized(id: WindowId, minimized: boolean): void {
        const entry = this._require(id);
        if (minimized) {
            if (this._hidden(entry)) return;
            entry.state = 'minimized';
            this._applyState(id);
            this._applyGeometry(id);
            this._refocusAfterHide(id);
        } else {
            if (entry.state !== 'minimized') return;
            entry.state = 'normal';
            this._applyState(id);
            this._applyGeometry(id);
            this.focus(id, { takeDomFocus: true });
        }
    }

    setClosed(id: WindowId, closed: boolean): void {
        const entry = this._require(id);
        if (closed) {
            if (this._hidden(entry)) return;
            entry.state = 'closed';
            this._applyState(id);
            this._applyGeometry(id);
            this._refocusAfterHide(id);
        } else {
            if (entry.state !== 'closed') return;
            entry.state = 'normal';
            this._applyState(id);
            this._applyGeometry(id);
            this.focus(id, { takeDomFocus: true });
        }
    }

    setMaximized(id: WindowId, maximized: boolean): void {
        const entry = this._require(id);
        if (maximized) {
            if (entry.state === 'maximized') return;
            // 无条件记下当前几何:用 `??=` 会把上一次最大化前的旧值留到下一次
            // (用户中途挪过的位置在还原时被丢掉,见 WindowManager.test.ts 的
            // "最大化/还原走两轮"用例).
            entry.restore = entry.geometry;
            entry.state = 'maximized';
        } else {
            if (entry.state !== 'maximized') return;
            entry.geometry = entry.restore ?? entry.geometry;
            // 还原后立刻清掉:留着它下一次最大化就不会再记录新位置.
            entry.restore = null;
            entry.state = 'normal';
        }
        // 先落地状态类,再按新状态决定"写四条行内属性"还是"清掉它们".
        this._applyState(id);
        this._applyGeometry(id);
    }

    /**
     * 单窗口全屏.
     *
     * 从 maximized 进 fullscreen 时 `restore` **不覆盖**(否则退出全屏会回到
     * 全屏尺寸,而不是最大化前的尺寸).
     */
    setFullscreen(id: WindowId, on: boolean): void {
        const entry = this._require(id);
        if (on) {
            if (entry.state === 'fullscreen') return;
            // 单窗口全屏:别的窗口的全屏先退掉(否则两层都铺满,退出时状态混乱).
            for (const other of this.entries.values()) {
                if (other.spec.id !== id && other.state === 'fullscreen') {
                    this.setFullscreen(other.spec.id, false);
                }
            }
            if (entry.state !== 'maximized') entry.restore = entry.geometry;
            entry.state = 'fullscreen';
        } else {
            if (entry.state !== 'fullscreen') return;
            entry.geometry = entry.restore ?? entry.geometry;
            // 与 setMaximized 同一条:还原即作废,否则下一次全屏会回到旧位置.
            entry.restore = null;
            entry.state = 'normal';
        }
        this._applyState(id);
        this._applyGeometry(id);
    }

    /** 当前是否有全屏窗口(`Esc` 绑定的判定要用它:没有就放行 Esc). */
    hasFullscreen(): boolean {
        return [...this.entries.values()].some((entry) => entry.state === 'fullscreen');
    }

    /** 退出当前全屏窗口(有的话);`Esc` 与 Dock 按钮都走这里. */
    exitFullscreen(): void {
        const fullscreen = [...this.entries.values()].find((entry) => entry.state === 'fullscreen');
        if (fullscreen) this.setFullscreen(fullscreen.spec.id, false);
    }

    /** 把五个窗口复位到默认几何(对应参考项目的"恢复默认"). */
    restoreAll(): void {
        const resolved = new Map<WindowId, Geometry>();
        for (const spec of UI_CONFIG.window.windows) {
            resolved.set(spec.id, resolveDefaultGeometry(spec.defaultGeometry, this.desktop, resolved));
        }
        for (const entry of this.entries.values()) {
            entry.state = 'normal';
            entry.restore = null;
            // 复位也收回桌内:小视口下"默认几何"可能本来就越界.
            entry.geometry = fitGeometry(resolved.get(entry.spec.id)!, this._limits(entry));
            this._applyState(entry.spec.id);
            this._applyGeometry(entry.spec.id);
        }
        const first = UI_CONFIG.window.windows[0]?.id;
        if (first) this.focus(first, { takeDomFocus: false });
    }

    /** 几何的唯一入口:过一遍夹取,再交给 `_applyGeometry`. */
    setGeometry(id: WindowId, next: Geometry): void {
        const entry = this._require(id);
        entry.geometry = clampGeometry(next, this._limits(entry));
        this._applyGeometry(id);
    }

    /** 桌面尺寸变化的公开入口(`bind()` 已挂到 `window.resize`;测试也用它). */
    onDesktopResize = (): void => {
        if (!this.root) return;
        this.desktop = this._measureDesktop();
        for (const entry of this.entries.values()) {
            // 隐藏态(最小化/关闭)也要收:它们保留的是普通态几何,而恢复路径
            // 不做夹取--桌面变小期间停在桌外的窗口恢复后就再也抓不回来了.
            if (entry.state !== 'maximized' && entry.state !== 'fullscreen') {
                // resize 是外部变化:把窗口整体收回桌内(拖动仍按 §3.4 的夹取).
                entry.geometry = fitGeometry(entry.geometry, this._limits(entry));
            }
            // maximized/fullscreen 的几何由 CSS 类接管,这里只需重刷状态类.
            this._applyState(entry.spec.id);
            this._applyGeometry(entry.spec.id);
        }
    };

    /**
     * 解绑:摘掉监听,把宿主**还回 `#app`**,再丢状态.
     *
     * 宿主必须在删窗口之前还回去:`#dsl-editor` 这类节点在 `index.html` 里没有
     * 备份,留在已删除的窗口里就等于丢了 DOM(与 `PanelController.dispose()`
     * "先把 DOM 复位再丢状态"同一条约定).
     */
    dispose(): void {
        this.abort.abort();
        this.snapPreview?.dispose();
        this.snapPreview = null;
        this.dock?.dispose();
        this.dock = null;

        for (const entry of this.entries.values()) {
            entry.gesture.abort();
            if (this.root) this.root.append(entry.host);
            entry.frame.dispose();
        }
        this.entries.clear();
        this.geometryListeners.clear();
        this.pendingSnap = null;
        this.focusedId = null;
        this.lastTitleDown.clear();
        this.root = null;
    }

    // ---------------------------------------------------------------- 内部

    private _require(id: WindowId): Entry {
        const entry = this.entries.get(id);
        if (!entry) throw new Error(`WindowManager: 未登记的窗口 ${id}`);
        return entry;
    }

    private _hidden(entry: Entry): boolean {
        return entry.state === 'minimized' || entry.state === 'closed';
    }

    private _measureDesktop(): Desktop {
        const root = this.root;
        return {
            w: root ? root.clientWidth : 0,
            h: root ? root.clientHeight : 0,
            dockReserve: UI_CONFIG.window.dockReserve,
            edgeGap: UI_CONFIG.window.edgeGap,
        };
    }

    private _limits(entry: Entry): Limits {
        return {
            desktop: this.desktop,
            min: entry.spec.minSize,
            edgeKeep: UI_CONFIG.window.edgeKeep,
            headerMinVisible: UI_CONFIG.window.headerMinVisible,
        };
    }

    private _actionButtons(id: WindowId): WindowActionButton[] {
        return UI_CONFIG.window.actions.map((action) => ({
            id: action.id,
            label: action.label,
            glyph: action.glyph,
            onClick: () => this._runWindowAction(id, action.id),
        }));
    }

    private _runWindowAction(id: WindowId, action: string): void {
        switch (action) {
            case 'minimize': this.setMinimized(id, true); break;
            case 'maximize': this.setMaximized(id, this.getState(id) !== 'maximized'); break;
            case 'fullscreen': this.setFullscreen(id, this.getState(id) !== 'fullscreen'); break;
            case 'close': this.setClosed(id, true); break;
            default: break;
        }
    }

    /** Dock 点击按状态分派(§3.6). */
    private _onDockSelect(id: WindowId): void {
        const entry = this._require(id);
        if (this._hidden(entry)) {
            this.reveal(id);
            return;
        }
        if (entry.state === 'maximized' || entry.state === 'fullscreen') {
            if (entry.state === 'maximized') this.setMaximized(id, false);
            else this.setFullscreen(id, false);
            this.focus(id, { takeDomFocus: true });
            return;
        }
        if (this.focusedId === id) {
            this.setMinimized(id, true);
            return;
        }
        this.focus(id, { takeDomFocus: true });
    }

    /** 关闭/最小化当前焦点窗口后,焦点交给可见窗口中 z 最高的那个. */
    private _refocusAfterHide(hiddenId: WindowId): void {
        let best: Entry | null = null;
        for (const entry of this.entries.values()) {
            if (entry.spec.id === hiddenId || this._hidden(entry)) continue;
            if (!best || entry.zIndex > best.zIndex) best = entry;
        }
        this.focusedId = best ? best.spec.id : null;
        for (const entry of this.entries.values()) {
            entry.frame.element.classList.toggle(
                'is-focused',
                best !== null && entry.spec.id === best.spec.id,
            );
        }
        this.dock?.setActive(this.focusedId);
    }

    /** `.window-title` 上的拖动:增量语义,夹取由 `setGeometry` 统一做一次. */
    private _bindWindowMove(entry: Entry): void {
        const id = entry.spec.id;
        /**
         * 这次按下是否还欠一次"从最大化/全屏还原".
         *
         * 刻意**不在 pointerdown 上还原**:单纯点一下标题栏(而不是拖)不该把
         * 最大化窗口还原掉;等第一次真的移动了再还原并跟手.双击序列里夹着的
         * 那些按下因此完全无害.
         */
        let pendingRestore = false;
        bindDragGesture(entry.frame.title, entry.gesture.signal, {
            canStart: (event) => {
                if (this._hidden(entry)) return false;
                // 双击标题栏 = 最大化 / 还原 / 退出全屏(与标题栏按钮同一条写入路径).
                if (this._isTitleDoubleClick(id, event)) {
                    this._toggleTitleDoubleClick(entry);
                    return false;
                }
                return true;
            },
            onStart: () => {
                pendingRestore = entry.state === 'maximized' || entry.state === 'fullscreen';
                entry.frame.element.classList.add('is-dragging');
                this.focus(id);
            },
            onDelta: (dx, dy, event) => {
                // 最大化/全屏下拖标题栏 = 第一次移动时还原,再跟手.
                if (pendingRestore) {
                    pendingRestore = false;
                    if (entry.state === 'maximized') this.setMaximized(id, false);
                    else if (entry.state === 'fullscreen') this.setFullscreen(id, false);
                }
                let next = moveGeometry(entry.geometry, dx, dy, this._limits(entry));
                // 磁吸只是"这一次移动"的修正,不写进 entry.geometry.
                next = magnetize(next, this._otherGeometries(id), UI_CONFIG.window.snap.magnet);

                const snap = resolveEdgeSnap(
                    { x: event.clientX, y: event.clientY },
                    this.desktop,
                    UI_CONFIG.window.snap,
                );
                this.pendingSnap = snap ? { id, kind: snap.kind, target: snap.target } : null;
                if (snap) this.snapPreview?.show(snap.target);
                else this.snapPreview?.hide();

                this.setGeometry(id, next);
            },
            onEnd: () => {
                entry.frame.element.classList.remove('is-dragging');
                this.snapPreview?.hide();
                const snap = this.pendingSnap;
                this.pendingSnap = null;
                if (!snap || snap.id !== id) return;
                // 预览与落地调的是同一个纯函数算出来的几何.
                if (snap.kind === 'maximize') this.setMaximized(id, true);
                else this.setGeometry(id, snap.target);
            },
        });
    }

    /**
     * 窗口上任意位置的 `pointerdown`(捕获阶段)提升焦点.
     *
     * 只调 `focus(id)`(默认不夺 DOM 焦点),不 `preventDefault`,不
     * `stopPropagation`:正文输入框与 `bindDragGesture` 都要照常收到事件.
     */
    private _bindWindowRaise(entry: Entry): void {
        entry.frame.element.addEventListener('pointerdown', () => {
            this.focus(entry.spec.id);
        }, { capture: true, signal: entry.gesture.signal });
    }

    /** 两次标题栏按下的间隔在阈值内算双击(第一次按下只记时间,不影响拖动). */
    private _isTitleDoubleClick(id: WindowId, event: PointerEvent): boolean {
        const stamp = event.timeStamp;
        const last = this.lastTitleDown.get(id);
        // 冷却期把 last 记到"未来",所以这里必须卡住下界:否则下一次按下的差值为负,
        // 反而正好落进 <= 阈值里,三击的中间那一下会被当成双击.
        if (last !== undefined && stamp - last >= 0 && stamp - last <= DOUBLE_CLICK_MS) {
            // 双击之后冷却一拍:否则"三击"的第三下又会被算成一次双击,而中间
            // 那一下还可能触发"拖最大化窗口 = 还原",观感是窗口一闪一闪.
            this.lastTitleDown.set(id, stamp + DOUBLE_CLICK_MS + 1);
            return true;
        }
        this.lastTitleDown.set(id, stamp);
        return false;
    }

    private _toggleTitleDoubleClick(entry: Entry): void {
        const id = entry.spec.id;
        if (entry.state === 'maximized') this.setMaximized(id, false);
        else if (entry.state === 'fullscreen') this.setFullscreen(id, false);
        else if (entry.state === 'normal') this.setMaximized(id, true);
        this.focus(id);
    }

    private _otherGeometries(id: WindowId): Geometry[] {
        const others: Geometry[] = [];
        for (const entry of this.entries.values()) {
            if (entry.spec.id === id || this._hidden(entry)) continue;
            others.push(entry.geometry);
        }
        return others;
    }

    /**
     * 几何的唯一写入点.
     *
     * 最大化/全屏的几何由 CSS 类负责(`inset: 0`),这里必须**先清掉四条行内
     * 几何**:行内 `left/top/width/height` 会压过类规则,不清就是"点了最大化
     * 没反应"(见 §11.2 E9).
     */
    private _applyGeometry(id: WindowId): void {
        const entry = this._require(id);
        if (entry.state === 'maximized' || entry.state === 'fullscreen') {
            clearGeometry(entry.frame.element);
        } else {
            // 隐藏态也照常写几何:隐藏用 opacity + inert,尺寸必须仍然有效,
            // 否则编辑器行号与高亮层会量到 0(见 §5.6).
            writeGeometry(entry.frame.element, entry.geometry);
        }
        // 正文高度写成 CSS 变量:示例浮层的 `max-height` 要按**所属窗口正文**算,
        // 而它在标题栏里,百分比解析不到窗口高度(见 §11.2 E5).这是给 CSS 的派生量,
        // 不是几何副本:四条几何属性仍然只有 writeGeometry 一个来源.
        entry.frame.element.style.setProperty(
            '--window-body-height',
            `${this._effectiveHeight(entry) - UI_CONFIG.window.headerHeight}px`,
        );
        for (const listener of this.geometryListeners) listener(id);
    }

    /** 窗口在屏幕上实际占的高度(最大化/全屏由 CSS 类决定,不看 `geometry`). */
    private _effectiveHeight(entry: Entry): number {
        if (entry.state === 'fullscreen') return this.desktop.h;
        if (entry.state === 'maximized') return this.desktop.h - UI_CONFIG.window.dockReserve;
        return entry.geometry.h;
    }

    /** 状态的唯一写入点:`.window` 上的每一个类都在这里切. */
    private _applyState(id: WindowId): void {
        const entry = this._require(id);
        const element = entry.frame.element;
        const hidden = this._hidden(entry);

        element.classList.toggle('is-maximized', entry.state === 'maximized');
        element.classList.toggle('is-fullscreen', entry.state === 'fullscreen');
        element.classList.toggle('is-hidden', hidden);
        // 关闭与最小化在视觉上是同一件事(都靠 `.is-hidden`);Dock 上的状态点
        // 走 `data-state`,所以这里不再多写一个没有 CSS 消费者的 `is-closed`.
        // 隐藏态用 opacity + inert,不用 display:none:编辑器行号与高亮层
        // 会量到 0 尺寸(见 §5.6).
        element.toggleAttribute('inert', hidden);
        element.setAttribute('aria-hidden', String(hidden));

        // 最大化/全屏时按钮文案变成"退出"(双击/按钮两条入口共用这里).
        entry.frame.controls.get('maximize')?.setText(entry.state === 'maximized' ? '❐' : '▣');
        entry.frame.controls.get('fullscreen')?.setText(entry.state === 'fullscreen' ? '⤡' : '⤢');

        const button = this.dock?.buttons.get(id);
        button?.setState(entry.state);
        button?.setActive(this.focusedId === id);

        // 全屏时 Dock 自动隐藏:这里按"全体里有没有全屏窗口"算一次,不能按当前
        // 这个窗口算(否则后一个普通窗口的 applyState 会把刚亮起的全屏态抹掉).
        this.dock?.setFullscreen(
            [...this.entries.values()].some((other) => other.state === 'fullscreen'),
        );
    }
}
