/**
 * 八向缩放的几何解释.
 *
 * 纯函数部分逐个方向断言(最容易写错的是西/北:只改尺寸不改坐标会让窗口
 * "看着不动,右边却在跑");绑定部分走共用拖动件在 DOM 桩里跑一遍,包括
 * `canStart` 在非 normal 态返回 false 这一条.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installDomStub, type StubElement } from '@/testing/domStub';
import type { Geometry } from './WindowGeometry';
import type { WindowState } from './WindowManager';
import { applyResize, bindWindowResize, RESIZE_DIRECTIONS } from './WindowResize';

const START: Geometry = { x: 100, y: 200, w: 400, h: 300 };

beforeEach(() => {
    installDomStub();
});

describe('applyResize', () => {
    it('east / south 只动一条', () => {
        expect(applyResize(START, 'e', 10, 5)).toEqual({ x: 100, y: 200, w: 410, h: 300 });
        expect(applyResize(START, 's', 10, 5)).toEqual({ x: 100, y: 200, w: 400, h: 305 });
    });

    it('west / north 同时动坐标与尺寸', () => {
        expect(applyResize(START, 'w', 10, 5)).toEqual({ x: 110, y: 200, w: 390, h: 300 });
        expect(applyResize(START, 'n', 10, 5)).toEqual({ x: 100, y: 205, w: 400, h: 295 });
    });

    it('四个角是两轴之并', () => {
        expect(applyResize(START, 'se', 10, 5)).toEqual({ x: 100, y: 200, w: 410, h: 305 });
        expect(applyResize(START, 'sw', 10, 5)).toEqual({ x: 110, y: 200, w: 390, h: 305 });
        expect(applyResize(START, 'ne', 10, 5)).toEqual({ x: 100, y: 205, w: 410, h: 295 });
        expect(applyResize(START, 'nw', 10, 5)).toEqual({ x: 110, y: 205, w: 390, h: 295 });
    });

    it('零位移不改几何;负位移反向', () => {
        expect(applyResize(START, 'nw', 0, 0)).toEqual(START);
        expect(applyResize(START, 'e', -10, 0).w).toBe(390);
        expect(applyResize(START, 'w', -10, 0)).toEqual({ x: 90, y: 200, w: 410, h: 300 });
    });

    it('八个方向都有定义,且没有重复', () => {
        expect(new Set(RESIZE_DIRECTIONS).size).toBe(8);
        for (const direction of RESIZE_DIRECTIONS) {
            expect(applyResize(START, direction, 0, 0)).toEqual(START);
        }
    });
});

describe('bindWindowResize', () => {
    function setup(state: WindowState = 'normal'): {
        handle: StubElement;
        calls: Geometry[];
        controller: AbortController;
        setState(next: WindowState): void;
    } {
        const handle = document.createElement('div') as unknown as StubElement;
        // 真标记里八根手柄的光标由 css/window.css 给;桩不解析样式表,拖动读到的
        // 光标要像真标记那样写在元素上.
        handle.style.cursor = 'nwse-resize';

        let current = state;
        const calls: Geometry[] = [];
        const controller = new AbortController();
        bindWindowResize(
            handle as unknown as HTMLElement,
            controller.signal,
            'se',
            (next) => calls.push(next),
            { geometry: () => START, state: () => current },
        );
        return { handle, calls, controller, setState: (next) => { current = next; } };
    }

    it('拖一根手柄:增量经 applyResize 解释后回调', () => {
        const { handle, calls } = setup();

        handle.dispatch('pointerdown', { clientX: 500, clientY: 500, pointerId: 1 });
        expect(handle.classList.contains('is-dragging')).toBe(true);

        handle.dispatch('pointermove', { clientX: 510, clientY: 505, pointerId: 1 });
        expect(calls).toEqual([{ x: 100, y: 200, w: 410, h: 305 }]);

        // 增量:第二次只按 5px/3px 解释(不累计成 15px/8px);几何由调用方给,
        // 本模块只负责"这一次的增量 -> 几何".
        handle.dispatch('pointermove', { clientX: 515, clientY: 508, pointerId: 1 });
        expect(calls[1]).toEqual({ x: 100, y: 200, w: 405, h: 303 });

        handle.dispatch('pointerup', { clientX: 515, clientY: 508, pointerId: 1 });
        expect(handle.classList.contains('is-dragging')).toBe(false);
    });

    it('最大化/全屏态下不起手', () => {
        const { handle, calls, setState } = setup();
        setState('maximized');

        handle.dispatch('pointerdown', { clientX: 500, clientY: 500, pointerId: 1 });
        handle.dispatch('pointermove', { clientX: 600, clientY: 600, pointerId: 1 });

        expect(handle.classList.contains('is-dragging')).toBe(false);
        expect(calls).toEqual([]);
    });

    it('signal abort 后不再起手', () => {
        const { handle, calls, controller } = setup();
        controller.abort();

        handle.dispatch('pointerdown', { clientX: 500, clientY: 500, pointerId: 1 });
        handle.dispatch('pointermove', { clientX: 600, clientY: 600, pointerId: 1 });

        expect(calls).toEqual([]);
    });
});
