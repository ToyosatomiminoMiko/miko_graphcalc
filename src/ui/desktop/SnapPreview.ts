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
 */
import { writeGeometry } from './WindowFrame';
import type { Geometry } from './WindowGeometry';

export type SnapKind = 'left' | 'right' | 'maximize';

export interface SnapPreviewHandle {
    show(target: Geometry, kind: SnapKind): void;
    hide(): void;
    dispose(): void;
}

export function createSnapPreview(element: HTMLElement): SnapPreviewHandle {
    return {
        show(target: Geometry, kind: SnapKind) {
            writeGeometry(element, target);
            element.className = `snap-preview is-open is-${kind}`;
        },
        hide() {
            element.className = 'snap-preview';
        },
        dispose() {
            element.className = 'snap-preview';
        },
    };
}
