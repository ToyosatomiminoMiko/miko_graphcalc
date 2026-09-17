/**
 * GridTicksController 回归测试.
 *
 * 老版本按 7 个 id 去 `document.getElementById` 拿输入框,测试手搓一套假 input
 * 塞进 `globalThis.document`;现在控制器接收 `ViewPanel` 的 `AxisControls`
 * 句柄,这里直接装配真面板 + 真控件(跑在 `testing/domStub.ts` 上),断言的是
 * "输入 -> 广播"的真实链路.
 *
 * 锁的行为:
 * - 初值来自面板(`RENDER_CONFIG`),启动广播一次;
 * - π 单位开关只影响 piUnit,不牵动网格/刻度可见性与线宽;
 * - 线宽输入框"合法立即广播,非法/空值回填上一个合法值";
 * - dispose 后不再响应输入(控件内部 AbortController 已解绑).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installDomStub, StubElement } from '@/testing/domStub';
import { EventBus } from '@/core/EventBus';
import type { GraphCalcEvents } from '@/contract/events';
import { RENDER_CONFIG } from '@/config/renderConfig';
import { createViewPanel, type ViewPanel } from '@/ui/view/ViewPanel';
import { GridTicksController } from './GridTicksController';

let panel: ViewPanel;

beforeEach(() => {
    installDomStub();
    const host = document.createElement('section');
    document.body.append(host);
    panel = createViewPanel(host);
});

function stub(element: unknown): StubElement {
    return element as StubElement;
}

describe('GridTicksController', () => {
    it('初始状态与配置一致,切换开关后广播 piUnit', () => {
        const eventBus = new EventBus<GraphCalcEvents>();
        const received: Array<GraphCalcEvents['grid:changed']> = [];
        eventBus.on('grid:changed', (payload) => received.push(payload));

        const controller = new GridTicksController(eventBus, panel.axis);

        const initial = received[received.length - 1];
        expect(initial.piUnit).toBe(RENDER_CONFIG.scene.axisTicks.piUnit);
        expect(panel.axis.piUnit.get()).toBe(RENDER_CONFIG.scene.axisTicks.piUnit);

        const piUnitInput = panel.axis.piUnit.input;
        piUnitInput.checked = true;
        stub(piUnitInput).dispatch('change');

        const toggled = received[received.length - 1];
        expect(toggled.piUnit).toBe(true);
        expect(received).toHaveLength(2);

        controller.dispose();
        // dispose() 走 AbortController:控件监听器应被摘除,再派发事件
        // 也不应产生新的广播.
        piUnitInput.checked = false;
        stub(piUnitInput).dispatch('change');
        expect(received).toHaveLength(2);
    });

    it('切换 π 单位不影响网格/刻度可见性与线宽', () => {
        const eventBus = new EventBus<GraphCalcEvents>();
        const received: Array<GraphCalcEvents['grid:changed']> = [];
        eventBus.on('grid:changed', (payload) => received.push(payload));

        const controller = new GridTicksController(eventBus, panel.axis);
        const before = received[received.length - 1];

        const piUnitInput = panel.axis.piUnit.input;
        piUnitInput.checked = true;
        stub(piUnitInput).dispatch('change');

        const after = received[received.length - 1];
        expect(after.piUnit).toBe(true);
        expect(after.ticksVisible).toBe(before.ticksVisible);
        expect(after.xzVisible).toBe(before.xzVisible);
        expect(after.majorWidth).toBe(before.majorWidth);
        expect(after.minorWidth).toBe(before.minorWidth);

        controller.dispose();
    });

    it('单个平面网格开关只改自己那一位', () => {
        const eventBus = new EventBus<GraphCalcEvents>();
        const received: Array<GraphCalcEvents['grid:changed']> = [];
        eventBus.on('grid:changed', (payload) => received.push(payload));

        const controller = new GridTicksController(eventBus, panel.axis);
        const xzInput = panel.axis.grids.xz.input;
        xzInput.checked = false;
        stub(xzInput).dispatch('change');

        const after = received[received.length - 1];
        expect(after.xzVisible).toBe(false);
        expect(after.xyVisible).toBe(true);
        expect(after.yzVisible).toBe(true);

        controller.dispose();
    });

    it('大刻度宽度输入:合法宽度立即广播,非法/空值回退旧值', () => {
        const eventBus = new EventBus<GraphCalcEvents>();
        const received: Array<GraphCalcEvents['grid:changed']> = [];
        eventBus.on('grid:changed', (payload) => received.push(payload));

        const controller = new GridTicksController(eventBus, panel.axis);
        expect(received).toHaveLength(1);
        const initial = received[0];
        const major = panel.axis.majorWidth;

        // 面板按配置写入初值,作为后续回退的基准
        expect(major.readText()).toBe(String(initial.majorWidth));

        // 合法数值:input 事件立即广播新的 majorWidth(不等待 change)
        major.writeText('3.5');
        stub(major.input).dispatch('input');
        expect(received).toHaveLength(2);
        const typed = received[received.length - 1];
        expect(typed.majorWidth).toBe(3.5);
        // 其余字段不受影响
        expect(typed.minorWidth).toBe(initial.minorWidth);
        expect(typed.piUnit).toBe(initial.piUnit);
        expect(typed.ticksVisible).toBe(initial.ticksVisible);
        expect(typed.xzVisible).toBe(initial.xzVisible);

        // 非法文本:保持旧值,不广播,输入框回填旧值
        major.writeText('abc');
        stub(major.input).dispatch('input');
        expect(received).toHaveLength(2);
        expect(received[received.length - 1].majorWidth).toBe(3.5);
        expect(major.readText()).toBe('3.5');

        // 空白串:同上
        major.writeText('   ');
        stub(major.input).dispatch('input');
        expect(received).toHaveLength(2);
        expect(major.readText()).toBe('3.5');

        // 低于下限(大刻度最小 1):同样回退
        major.writeText('0.5');
        stub(major.input).dispatch('input');
        expect(received).toHaveLength(2);
        expect(major.readText()).toBe('3.5');

        // 非有限值:回退
        major.writeText('Infinity');
        stub(major.input).dispatch('input');
        expect(received).toHaveLength(2);
        expect(major.readText()).toBe('3.5');

        // 回退后仍可继续接受合法输入
        major.writeText('2');
        stub(major.input).dispatch('input');
        expect(received).toHaveLength(3);
        expect(received[received.length - 1].majorWidth).toBe(2);

        // change 阶段走同一条 apply,重复值不重复广播
        stub(major.input).dispatch('change');
        expect(received).toHaveLength(3);

        controller.dispose();
        major.writeText('9');
        stub(major.input).dispatch('input');
        expect(received).toHaveLength(3);
    });
});
