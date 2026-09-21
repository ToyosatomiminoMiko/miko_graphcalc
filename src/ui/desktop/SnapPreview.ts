/**
 * 吸附预览层:拖动时显示"松开会变成什么样"的一层高亮.
 *
 * 只有一个元素(`#snap-preview`),由 `WindowManager` 在拖动每帧调用:
 * 预览的几何**就是** `WindowGeometry.resolveEdgeSnap` 返回的落点几何,与松手
 * 后的落地结果调的是同一个纯函数,所以"预览与落地不一致"这类 bug 在结构上
 * 不存在(见 docs/windowing-plan.md §3.5).
 *
 * 它必须 `pointer-events: none`(写在 CSS 里):否则这层会挡住正在拖的指针,
 * 吸附一开始就再也收不到 `pointermove`.
 *
 * 形状差异全部来自行内几何(半屏就是 `desktop.w / 2` 宽的矩形,最大化就是整块
 * 桌面),所以这里不再按 `kind` 写 `is-left` / `is-right` / `is-maximize` 之类
 * 没有 CSS 消费者的类名;开合只有 `.is-open` 一个状态(与 CSS 里的唯一规则对应).
 */
import { writeGeometry } from './WindowFrame';
import type { Geometry } from './WindowGeometry';

export interface SnapPreviewHandle {
    show(target: Geometry): void;
    hide(): void;
    dispose(): void;
}

export function createSnapPreview(element: HTMLElement): SnapPreviewHandle {
    return {
        show(target: Geometry) {
            writeGeometry(element, target);
            element.classList.add('is-open');
        },
        hide() {
            element.classList.remove('is-open');
        },
        dispose() {
            element.classList.remove('is-open');
        },
    };
}
