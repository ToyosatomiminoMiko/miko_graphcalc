/**
 * 窗口外壳:声明式建 `.window` / `.window-header` / `.window-body` / 八根手柄.
 *
 * **窗外壳不写进 `index.html`**:标记只在 TS 里有一份真相源,`index.html` 只留
 * 正文宿主(见 docs/windowing-plan.md §5.3/§5.4).本文件只负责建结构,不订阅
 * 任何状态:拖动,缩放,按钮语义都由 `WindowManager` 在建完之后接线,与
 * "`PanelController.bind()` 才挂手柄"是同一时序.
 *
 * 与 `spec.actions` / `spec.overlays` / `spec.titleContent` 里的节点是**搬过来
 * 的,不是重建的**:`#example-btn` / `#run-btn` 的监听,`#example-menu` 的浮层
 * 状态,`#formula-copy-hint` 的回显都不能丢,所以只 `append` 现成节点,不按
 * innerHTML 重做一份(见 §4.4).
 */
import { createButton, type ButtonHandle } from '@/ui/widgets/Button';
import { el, type Child } from '@/ui/widgets/dom';
import {
    geometryStyle,
    type Geometry,
} from './WindowGeometry';
import { RESIZE_DIRECTIONS, type ResizeDirection } from './WindowResize';

/** 标题栏上的一枚窗口按钮;`onClick` 由 `WindowManager` 给(它持有状态). */
export interface WindowActionButton {
    readonly id: 'minimize' | 'maximize' | 'fullscreen' | 'close';
    readonly label: string;
    readonly glyph: string;
    readonly onClick: () => void;
}

export interface WindowFrameSpec {
    readonly id: string;
    readonly title: string;
    /** 标题里的额外内容(对象窗口放 `#formula-copy-hint`). */
    readonly titleContent: readonly Child[];
    /** 标题栏动作的现成节点:示例按钮 / RUN. */
    readonly actions: readonly Child[];
    /** 标题栏浮层的现成节点:`#example-menu`. */
    readonly overlays: readonly Child[];
    /** 由 `UI_CONFIG.window.actions` 生成的窗口按钮. */
    readonly controls: readonly WindowActionButton[];
    /** 建好即刻写入行内样式,避免首帧闪在左上角. */
    readonly geometry: Geometry;
}

export interface WindowFrameHandle {
    readonly element: HTMLElement;
    readonly header: HTMLElement;
    /** 拖动起手元素(`.window-title`) */
    readonly title: HTMLElement;
    readonly body: HTMLElement;
    readonly handles: readonly {
        readonly direction: ResizeDirection;
        readonly element: HTMLElement;
    }[];
    readonly controls: ReadonlyMap<string, ButtonHandle>;
    setTitle(text: string): void;
    dispose(): void;
}

/**
 * 逐条写四条几何属性:窗口几何**唯一允许的写入形状**.
 *
 * 不要用 `element.style.cssText = geometryToCss(...)`:`cssText` 赋值会清空整个
 * 行内声明块,把 `focus()` 写的 `z-index` 一起清掉,被拖的窗口会当场掉到其它
 * 窗口后面(见 docs/windowing-plan.md §11.2 E8).
 */
export function writeGeometry(element: HTMLElement, g: Geometry): void {
    for (const [name, value] of Object.entries(geometryStyle(g))) {
        element.style.setProperty(name, value);
    }
}

/** 清掉四条行内几何;进入 maximized/fullscreen 前必须调它(E9). */
export function clearGeometry(element: HTMLElement): void {
    for (const name of ['left', 'top', 'width', 'height'] as const) {
        element.style.removeProperty(name);
    }
}

/** `el()` 会跳过假值,直接 `append` 不会:这里统一把 `Child[]` 收成真节点. */
function concrete(children: readonly Child[]): Array<Node | string> {
    return children.filter(
        (child): child is Node | string => child !== null && child !== undefined && child !== false,
    );
}

export function createWindowFrame(spec: WindowFrameSpec): WindowFrameHandle {
    const element = el('section', {
        class: 'window',
        attrs: { 'data-window': spec.id, role: 'region' },
    });
    // 可脚本聚焦(`reveal()` 的落点)但不进 Tab 序.
    element.tabIndex = -1;

    const title = el('span', { class: 'window-title' });
    // 读屏名指向标题文本;id 由窗口 id 派生,一个窗口只有一个标题.
    title.id = `window-title-${spec.id}`;
    const label = el('span', { text: spec.title });
    title.append(label, ...concrete(spec.titleContent));
    element.setAttribute('aria-labelledby', title.id);

    const actions = el('div', { class: 'window-actions' }, ...concrete(spec.actions));

    const controls = el('div', { class: 'window-controls' });
    const controlHandles = new Map<string, ButtonHandle>();
    for (const control of spec.controls) {
        const button = createButton({
            class: 'window-control-btn',
            text: control.glyph,
            ariaLabel: control.label,
            title: control.label,
        });
        button.onClick(control.onClick);
        controlHandles.set(control.id, button);
        controls.append(button.element);
    }

    // 浮层是 header 的直接子节点(不是 .window-actions 的子节点,那一层是按钮行),
    // 也必须在 .window-body 之外,否则会被正文的裁切切掉(§11.1 B2).
    const header = el('header', { class: 'window-header' }, title, actions, controls, ...concrete(spec.overlays));
    const body = el('div', { class: 'window-body' });

    const handles = RESIZE_DIRECTIONS.map((direction) => ({
        direction,
        element: el('div', {
            class: 'resize-handle',
            attrs: { 'data-window-resize': direction },
        }),
    }));

    element.append(header, body, ...handles.map((handle) => handle.element));
    writeGeometry(element, spec.geometry);

    return {
        element,
        header,
        title,
        body,
        handles,
        controls: controlHandles,
        setTitle: (text: string) => {
            // 只换标题文字那个 span:titleContent(如 #formula-copy-hint)是
            // 现成节点,不能被 textContent 一起清掉.
            label.textContent = text;
        },
        dispose() {
            for (const button of controlHandles.values()) button.dispose();
            controlHandles.clear();
            element.remove();
        },
    };
}
