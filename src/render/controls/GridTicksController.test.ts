import { afterEach, describe, expect, it, vi } from 'vitest';
import { GridTicksController } from './GridTicksController';
import { EventBus } from '../../service/EventBus';
import type { GraphCalcEvents } from '../../types';
import { RENDER_CONFIG } from '../../config/renderConfig';

/**
 * GridTicksController 只通过 document.getElementById 读取输入框,
 * 这里用最小假 DOM 覆盖它:不启动浏览器也能验证 π 单位开关的接线.
 * 假 DOM 的 addEventListener 复刻真实 `{ signal }` 语义(见下),
 * 使 dispose() 的 AbortController 接线可被断言.
 */
// 假 DOM 的监听器选项:只关心真实代码用到的 `{ signal }`(AbortSignal 接线).
interface FakeListenerOptions {
    signal?: AbortSignal;
}

interface FakeInput {
    checked: boolean;
    value: string;
    listeners: Map<string, Array<() => void>>;
    addEventListener(
        type: string,
        listener: () => void,
        options?: FakeListenerOptions,
    ): void;
    removeEventListener(type: string, listener: () => void): void;
    dispatch(type: string): void;
    listenerCount(): number;
}

function fakeInput(): FakeInput {
    const listeners = new Map<string, Array<() => void>>();
    const remove = (type: string, listener: () => void): void => {
        const bucket = listeners.get(type);
        if (!bucket) return;
        const index = bucket.indexOf(listener);
        if (index >= 0) bucket.splice(index, 1);
        if (bucket.length === 0) listeners.delete(type);
    };
    return {
        checked: false,
        value: '',
        listeners,
        // 复刻真实 addEventListener 的 signal 语义:已 abort 的信号不再登记,
        // 未 abort 则在 abort 时自动摘除监听器.这样 dispose() 会把监听器
        // 计数清零;若 GridTicksController.ts 丢掉 { signal } 接线,计数会
        // 残留,测试即失败.
        addEventListener(type, listener, options) {
            if (options?.signal?.aborted) return;
            const bucket = listeners.get(type) ?? [];
            bucket.push(listener);
            listeners.set(type, bucket);
            options?.signal?.addEventListener('abort', () => remove(type, listener));
        },
        removeEventListener: remove,
        dispatch(type) {
            // 拷贝一份再遍历,允许监听器在回调中摘除自己
            for (const listener of [...(listeners.get(type) ?? [])]) listener();
        },
        listenerCount() {
            let total = 0;
            for (const bucket of listeners.values()) total += bucket.length;
            return total;
        },
    };
}

const INPUT_IDS = [
    'gridVisibleXZ',
    'gridVisibleXY',
    'gridVisibleYZ',
    'axisTicksVisible',
    'axisTicksPiUnit',
    'gridMajorWidth',
    'gridMinorWidth',
] as const;

function stubDom(): Record<string, FakeInput> {
    const elements: Record<string, FakeInput> = {};
    for (const id of INPUT_IDS) elements[id] = fakeInput();
    vi.stubGlobal('document', {
        getElementById: (id: string) => elements[id] ?? null,
    });
    return elements;
}

/** 所有输入框上仍登记的监听器总数,用于断言 dispose() 已真正解绑. */
function totalListeners(elements: Record<string, FakeInput>): number {
    return Object.values(elements).reduce((sum, el) => sum + el.listenerCount(), 0);
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('GridTicksController', () => {
    it('初始状态与配置一致,切换开关后广播 piUnit', () => {
        const elements = stubDom();
        const eventBus = new EventBus<GraphCalcEvents>();
        const received: Array<GraphCalcEvents['grid:changed']> = [];
        eventBus.on('grid:changed', (payload) => received.push(payload));

        const controller = new GridTicksController(eventBus);

        const initial = received[received.length - 1];
        expect(initial.piUnit).toBe(RENDER_CONFIG.scene.axisTicks.piUnit);
        expect(elements.axisTicksPiUnit.checked).toBe(RENDER_CONFIG.scene.axisTicks.piUnit);

        elements.axisTicksPiUnit.checked = true;
        elements.axisTicksPiUnit.dispatch('change');

        const toggled = received[received.length - 1];
        expect(toggled.piUnit).toBe(true);
        expect(received).toHaveLength(2);

        controller.dispose();
        // dispose() 走 AbortController:全部监听器应被摘除,再派发事件
        // 也不应产生新的广播.
        expect(totalListeners(elements)).toBe(0);
        elements.axisTicksPiUnit.checked = false;
        elements.axisTicksPiUnit.dispatch('change');
        expect(received).toHaveLength(2);
    });

    it('切换 π 单位不影响网格/刻度可见性与线宽', () => {
        const elements = stubDom();
        const eventBus = new EventBus<GraphCalcEvents>();
        const received: Array<GraphCalcEvents['grid:changed']> = [];
        eventBus.on('grid:changed', (payload) => received.push(payload));

        const controller = new GridTicksController(eventBus);
        const before = received[received.length - 1];

        elements.axisTicksPiUnit.checked = true;
        elements.axisTicksPiUnit.dispatch('change');

        const after = received[received.length - 1];
        expect(after.piUnit).toBe(true);
        expect(after.ticksVisible).toBe(before.ticksVisible);
        expect(after.xzVisible).toBe(before.xzVisible);
        expect(after.majorWidth).toBe(before.majorWidth);
        expect(after.minorWidth).toBe(before.minorWidth);

        controller.dispose();
        expect(totalListeners(elements)).toBe(0);
    });

    it('大刻度宽度输入:合法宽度立即广播,非法/空值回退旧值', () => {
        const elements = stubDom();
        const eventBus = new EventBus<GraphCalcEvents>();
        const received: Array<GraphCalcEvents['grid:changed']> = [];
        eventBus.on('grid:changed', (payload) => received.push(payload));

        const controller = new GridTicksController(eventBus);
        expect(received).toHaveLength(1);
        const initial = received[0];

        // 构造函数把当前配置宽度写回输入框,作为后续回退的基准值
        expect(elements.gridMajorWidth.value).toBe(String(initial.majorWidth));

        // 合法数值:input 事件立即广播新的 majorWidth(不等待 change)
        elements.gridMajorWidth.value = '3.5';
        elements.gridMajorWidth.dispatch('input');
        expect(received).toHaveLength(2);
        const typed = received[received.length - 1];
        expect(typed.majorWidth).toBe(3.5);
        // 其余字段不受影响
        expect(typed.minorWidth).toBe(initial.minorWidth);
        expect(typed.piUnit).toBe(initial.piUnit);
        expect(typed.ticksVisible).toBe(initial.ticksVisible);
        expect(typed.xzVisible).toBe(initial.xzVisible);

        // 非法文本:保持旧值,不广播,输入框回填旧值
        elements.gridMajorWidth.value = 'abc';
        elements.gridMajorWidth.dispatch('input');
        expect(received).toHaveLength(2);
        expect(received[received.length - 1].majorWidth).toBe(3.5);
        expect(elements.gridMajorWidth.value).toBe('3.5');

        // 空白串:同上
        elements.gridMajorWidth.value = '   ';
        elements.gridMajorWidth.dispatch('input');
        expect(received).toHaveLength(2);
        expect(elements.gridMajorWidth.value).toBe('3.5');

        // 低于下限(大刻度最小 1):同样回退
        elements.gridMajorWidth.value = '0.5';
        elements.gridMajorWidth.dispatch('input');
        expect(received).toHaveLength(2);
        expect(elements.gridMajorWidth.value).toBe('3.5');

        // 非有限值:回退
        elements.gridMajorWidth.value = 'Infinity';
        elements.gridMajorWidth.dispatch('input');
        expect(received).toHaveLength(2);
        expect(elements.gridMajorWidth.value).toBe('3.5');

        // 回退后仍可继续接受合法输入
        elements.gridMajorWidth.value = '2';
        elements.gridMajorWidth.dispatch('input');
        expect(received).toHaveLength(3);
        expect(received[received.length - 1].majorWidth).toBe(2);

        controller.dispose();
        expect(totalListeners(elements)).toBe(0);
    });
});
