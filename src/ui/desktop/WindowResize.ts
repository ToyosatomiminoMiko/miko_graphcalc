/**
 * 八向缩放的**几何解释**(纯函数)与手柄绑定.
 *
 * 机制原样保留:拖动仍然只有 `ui/shared/dragGesture.ts` 一份,光标仍然只由
 * CSS 给(起手时读 `getComputedStyle(handle).cursor`),`is-dragging` 仍然由
 * 共用件负责,解绑仍然走 `{ signal }`.本模块只多一件事:把
 * `(方向, dx, dy)` 翻译成 `x/y/w/h` 的改变.
 *
 * 三条必守的细节(否则会出现"拖不动""窗口跳""拖到自己身上"):
 * 1. `west`/`north` 必须**同时**动 `x/y` 与 `w/h`:只改尺寸会让窗口"看着不动,
 *    右边却在跑";
 * 2. `applyResize` **不夹取**:`w -= dx` 与 `x += dx` 之间插夹取会把窗口整体
 *    往右推,夹取必须由调用方在累加后统一做一次(`WindowManager` 的
 *    `setGeometry` 过 `clampGeometry`);
 * 3. 至少 `EDGE_KEEP` 宽留在桌内,这条同样由调用方那次夹取保证.
 */
import { bindDragGesture } from '@/ui/shared/dragGesture';
import type { Geometry } from './WindowGeometry';
import type { WindowState } from './WindowManager';

export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * 八根手柄的方向清单:顺序即 DOM 顺序,`WindowFrame` 与 DOM 契约测试共用.
 *
 * 角 = 两轴并集,所以下面的判断用 `includes`:一个 `se` 同时命中 `e` 与 `s`.
 */
export const RESIZE_DIRECTIONS: readonly ResizeDirection[] = [
    'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw',
];

/** 方向 + 增量 -> 未夹取的几何(纯算术). */
export function applyResize(
    g: Geometry,
    direction: ResizeDirection,
    dx: number,
    dy: number,
): Geometry {
    let { x, y, w, h } = g;

    if (direction.includes('e')) w += dx;
    if (direction.includes('s')) h += dy;
    // 西/北:坐标与尺寸一起动(见文件头第 1 条).
    if (direction.includes('w')) {
        x += dx;
        w -= dx;
    }
    if (direction.includes('n')) {
        y += dy;
        h -= dy;
    }
    return { x, y, w, h };
}

/** 手柄绑定要读的窗口侧状态(几何与状态都是唯一真相源,不读 DOM 类名). */
export interface ResizeContext {
    geometry(): Geometry;
    state(): WindowState;
}

/** 把某根手柄接到 `applyResize` 上;DOM 部分只做这一件事. */
export function bindWindowResize(
    handle: HTMLElement,
    signal: AbortSignal,
    direction: ResizeDirection,
    onGeometry: (next: Geometry) => void,
    read: ResizeContext,
): void {
    bindDragGesture(handle, signal, {
        // 最大化/全屏态下缩放无意义(几何由 CSS 类接管),直接不起手.
        canStart: () => read.state() === 'normal',
        onStart: () => {},
        onDelta: (dx, dy) => onGeometry(applyResize(read.geometry(), direction, dx, dy)),
        onEnd: () => {},
    });
}
