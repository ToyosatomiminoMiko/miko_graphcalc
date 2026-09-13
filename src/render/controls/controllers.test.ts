import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../service/EventBus';
import type { GraphCalcEvents } from '../../types';
import { RotationLockController } from './RotationLockController';
import { ViewCubeController } from './ViewCubeController';
import { AxisUpController } from './AxisUpController';
import { PointStyleController } from './PointStyleController';
import { RENDER_CONFIG } from '../../config/renderConfig';

/**
 * 控制层小项的回归测试.
 *
 * 这些控制器只通过 document 读取 DOM,这里用最小假 DOM 覆盖:不启动浏览器
 * 也能验证"启动时同步一次"(RND-P3.1),"data-* 非法值不生效"(RND-P3.5)
 * 与"大小/比例只有一个状态来源"(RND-P3.2).
 */

interface FakeListenerOptions {
    signal?: AbortSignal;
}

interface FakeElement {
    dataset: Record<string, string>;
    classList: {
        toggle(className: string, on: boolean): void;
        contains(className: string): boolean;
    };
    addEventListener(
        type: string,
        listener: () => void,
        options?: FakeListenerOptions,
    ): void;
    removeEventListener(type: string, listener: () => void): void;
    dispatch(type: string): void;
    listenerCount(): number;
}

function fakeElement(dataset: Record<string, string> = {}): FakeElement {
    const listeners = new Map<string, Array<() => void>>();
    const active = new Set<string>();
    const remove = (type: string, listener: () => void): void => {
        const bucket = listeners.get(type);
        if (!bucket) return;
        const index = bucket.indexOf(listener);
        if (index >= 0) bucket.splice(index, 1);
    };
    return {
        dataset,
        classList: {
            toggle(className, on) {
                if (on) active.add(className);
                else active.delete(className);
            },
            contains: (className) => active.has(className),
        },
        addEventListener(type, listener, options) {
            if (options?.signal?.aborted) return;
            const bucket = listeners.get(type) ?? [];
            bucket.push(listener);
            listeners.set(type, bucket);
            options?.signal?.addEventListener('abort', () => remove(type, listener));
        },
        removeEventListener: remove,
        dispatch(type) {
            for (const listener of [...(listeners.get(type) ?? [])]) listener();
        },
        listenerCount() {
            let total = 0;
            for (const bucket of listeners.values()) total += bucket.length;
            return total;
        },
    };
}

interface FakeCheckbox extends FakeElement {
    checked: boolean;
}

function fakeCheckbox(checked = false): FakeCheckbox {
    return Object.assign(fakeElement(), { checked });
}

interface FakeInput extends FakeElement {
    value: string;
    step: string;
}

function fakeInput(value = ''): FakeInput {
    return Object.assign(fakeElement(), { value, step: '' });
}

interface FakeLabel extends FakeElement {
    textContent: string;
}

function fakeLabel(): FakeLabel {
    return Object.assign(fakeElement(), { textContent: '' });
}

function installDom(byId: Record<string, unknown>, bySelector: Record<string, unknown[]>): void {
    (globalThis as unknown as { document: unknown }).document = {
        getElementById: (id: string) => byId[id] ?? null,
        querySelectorAll: (selector: string) => bySelector[selector] ?? [],
    };
}

const originalDocument = (globalThis as unknown as { document?: unknown }).document;

afterEach(() => {
    (globalThis as unknown as { document?: unknown }).document = originalDocument;
});

describe('RotationLockController(RND-P3.1)', () => {
    it('启动时按 DOM 状态同步一次,并在 dispose 后解绑', () => {
        const toggle = fakeCheckbox(true);
        installDom({ rotationLockToggle: toggle }, {});
        const bus = new EventBus<GraphCalcEvents>();
        const seen: boolean[] = [];
        bus.on('camera:rotationLock', ({ locked }) => seen.push(locked));

        const controller = new RotationLockController(bus);
        // 勾选态已存在(浏览器软重载)时必须发出初始事件,否则锁定态与
        // OrbitControls 脱钩
        expect(seen).toEqual([true]);

        toggle.checked = false;
        toggle.dispatch('change');
        expect(seen).toEqual([true, false]);

        controller.dispose();
        expect(toggle.listenerCount()).toBe(0);
    });

    it('复选框缺失时不抛错', () => {
        installDom({}, {});
        const bus = new EventBus<GraphCalcEvents>();
        expect(() => new RotationLockController(bus).dispose()).not.toThrow();
    });
});

describe('data-* 校验(RND-P3.5)', () => {
    it('ViewCubeController 忽略非法的 data-view,不发出 camera:view', () => {
        const valid = fakeElement({ view: 'top' });
        const invalid = fakeElement({ view: 'nonsense' });
        installDom({}, { '[data-view]': [valid, invalid] });
        const bus = new EventBus<GraphCalcEvents>();
        const views: string[] = [];
        bus.on('camera:view', ({ view }) => views.push(view));

        const controller = new ViewCubeController(bus);
        invalid.dispatch('click');
        expect(views).toEqual([]);

        valid.dispatch('click');
        expect(views).toEqual(['top']);
        expect(valid.classList.contains('active')).toBe(true);

        controller.dispose();
    });

    it('AxisUpController 忽略非法的 data-axis-up', () => {
        const x = fakeElement({ axisUp: 'x' });
        const invalid = fakeElement({ axisUp: 'nope' });
        installDom({}, { '[data-axis-up]': [x, invalid] });
        const bus = new EventBus<GraphCalcEvents>();
        const axes: string[] = [];
        bus.on('axis:upChanged', ({ axis }) => axes.push(axis));

        const controller = new AxisUpController(bus);
        expect(axes).toEqual([RENDER_CONFIG.scene.upAxis]);

        invalid.dispatch('click');
        expect(axes).toEqual([RENDER_CONFIG.scene.upAxis]);

        x.dispatch('click');
        expect(axes).toEqual([RENDER_CONFIG.scene.upAxis, 'x']);

        controller.dispose();
    });

    it('PointStyleController 忽略非法的 data-point-mode', () => {
        const visible = fakeCheckbox(true);
        const value = fakeInput();
        const label = fakeLabel();
        const sizeButton = fakeElement({ pointMode: 'size' });
        const scaleButton = fakeElement({ pointMode: 'scale' });
        const invalidButton = fakeElement({ pointMode: 'huge' });
        installDom(
            { pointVisible: visible, pointValue: value, pointValueLabel: label },
            { '[data-point-mode]': [sizeButton, scaleButton, invalidButton] },
        );
        const bus = new EventBus<GraphCalcEvents>();
        const emitted: number[] = [];
        bus.on('point:changed', ({ radius }) => emitted.push(radius));

        const controller = new PointStyleController(bus);
        expect(emitted).toEqual([RENDER_CONFIG.scene.point.radius]);

        invalidButton.dispatch('click');
        expect(emitted).toHaveLength(1);

        controller.dispose();
    });
});

describe('PointStyleController 大小/比例单一来源(RND-P3.2)', () => {
    it('切换模式保持实际半径,比例模式按基准半径换算', () => {
        const visible = fakeCheckbox(true);
        const value = fakeInput();
        const label = fakeLabel();
        const sizeButton = fakeElement({ pointMode: 'size' });
        const scaleButton = fakeElement({ pointMode: 'scale' });
        installDom(
            { pointVisible: visible, pointValue: value, pointValueLabel: label },
            { '[data-point-mode]': [sizeButton, scaleButton] },
        );
        const bus = new EventBus<GraphCalcEvents>();
        const emitted: number[] = [];
        bus.on('point:changed', ({ radius }) => emitted.push(radius));
        const base = RENDER_CONFIG.scene.point.radius;

        const controller = new PointStyleController(bus);
        expect(emitted).toEqual([base]);
        // 初始显示绝对半径
        expect(value.value).toBe(String(base));

        // 切到比例:实际半径不变,显示换算成 1
        scaleButton.dispatch('click');
        expect(emitted[1]).toBeCloseTo(base, 10);
        expect(value.value).toBe('1');

        // 比例 2 -> 半径 2 倍
        value.value = '2';
        value.dispatch('input');
        expect(emitted[2]).toBeCloseTo(base * 2, 10);

        // 切回大小:仍显示同一实际半径(旧实现会被配置里的 scale 覆盖)
        sizeButton.dispatch('click');
        expect(emitted[3]).toBeCloseTo(base * 2, 10);
        expect(value.value).toBe(String(Number((base * 2).toFixed(4))));

        // 大小模式直接输入绝对值
        value.value = '0.5';
        value.dispatch('input');
        expect(emitted[4]).toBeCloseTo(0.5, 10);

        // 清空/非法输入保留旧值
        value.value = '';
        value.dispatch('input');
        value.value = 'abc';
        value.dispatch('input');
        expect(emitted).toHaveLength(5);

        controller.dispose();
    });
});
