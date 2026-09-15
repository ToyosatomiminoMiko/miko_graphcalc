/**
 * 视图控制层小项的回归测试.
 *
 * 老版本这些控制器各自 `document.getElementById` / `querySelectorAll`,测试
 * 只能手搓一套假 DOM 把节点塞进 `globalThis.document`;现在控制器只接收
 * `ViewPanel` 交出的句柄,所以这里直接用**真的面板 + 真的控件**(跑在
 * `test/domStub.ts` 的最小 DOM 上),断言的是"用户操作 -> 广播"的完整链路.
 *
 * 覆盖的不变量:
 * - (RND-P3.1)启动时按面板初值同步一次,否则 UI 状态与场景脱钩;
 * - (RND-P3.2)点的大小/比例只有一个状态来源(实际半径);
 * - dispose 后控件不再响应事件(控件内部走 AbortController 解绑).
 *
 * 老测试里的"data-* 非法值不生效"(RND-P3.5)一条已经不需要了:值域由
 * `SegmentedHandle<CamMode/ViewHome/UpAxis>` 的泛型保证,非法字符串在类型
 * 层面就不存在,对应地 `isCamMode` / `isViewHome` / `isUpAxis` 三个运行时
 * 校验也一并删除了.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installDomStub, StubElement } from '../../test/domStub';
import { EventBus } from '../../service/EventBus';
import type { CamMode, GraphCalcEvents, ViewHome } from '../../types';
import { RENDER_CONFIG } from '../../config/renderConfig';
import { UI_CONFIG } from '../../config/uiConfig';
import { createViewPanel, type ViewPanel } from '../../ui/view/ViewPanel';
import { CameraToggle } from './CameraToggle';
import { RotationLockController } from './RotationLockController';
import { ViewCubeController } from './ViewCubeController';
import { AxisUpController } from './AxisUpController';
import { PointStyleController } from './PointStyleController';

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

/** 点第 index 个分段按钮(真控件自己维护高亮与选中值). */
function clickSegment(element: unknown, index: number): void {
    (stub(element).children[index] as StubElement).dispatch('click');
}

/** 拨动开关:先写勾选态,再派发 change(与浏览器行为一致). */
function toggleSwitch(element: unknown, checked: boolean): void {
    const input = stub(element).querySelector<StubElement>('input')!;
    input.checked = checked;
    input.dispatch('change');
}

describe('RotationLockController(RND-P3.1)', () => {
    it('启动时按面板初值广播一次,切换后再广播,dispose 后解绑', () => {
        const bus = new EventBus<GraphCalcEvents>();
        const seen: boolean[] = [];
        bus.on('camera:rotationLock', ({ locked }) => seen.push(locked));

        const controller = new RotationLockController(bus, panel.camera.rotationLock);
        // 面板初值是未锁定;必须发出初始事件,否则锁定态与 OrbitControls 脱钩
        expect(seen).toEqual([false]);
        expect(panel.camera.rotationLock.get()).toBe(false);

        toggleSwitch(panel.camera.rotationLock.element, true);
        expect(seen).toEqual([false, true]);
        expect(controller.locked).toBe(true);

        controller.dispose();
        toggleSwitch(panel.camera.rotationLock.element, false);
        expect(seen).toEqual([false, true]);
    });
});

describe('CameraToggle', () => {
    it('初值来自面板(正交),点文字或拨开关都收口到同一状态', () => {
        const bus = new EventBus<GraphCalcEvents>();
        const modes: CamMode[] = [];
        bus.on('camera:changed', ({ camMode }) => modes.push(camMode));

        const controller = new CameraToggle(bus, panel.camera);
        expect(controller.mode).toBe(RENDER_CONFIG.camera.defaultMode);
        expect(panel.camera.toggle.get()).toBe(true);

        // 入口一:点"透视"文字
        stub(panel.camera.modeLabels[0].element).dispatch('click');
        expect(modes).toEqual(['perspective']);
        expect(panel.camera.toggle.get()).toBe(false);
        expect(panel.camera.modeLabels[0].element.classList.contains('active')).toBe(true);
        expect(panel.camera.modeLabels[1].element.classList.contains('active')).toBe(false);

        // 入口二:拨开关回正交
        toggleSwitch(panel.camera.toggle.element, true);
        expect(modes).toEqual(['perspective', 'orthographic']);
        expect(panel.camera.modeLabels[1].element.classList.contains('active')).toBe(true);

        // 重复点当前模式不重复广播
        stub(panel.camera.modeLabels[1].element).dispatch('click');
        expect(modes).toHaveLength(2);

        controller.dispose();
    });
});

describe('ViewCubeController', () => {
    it('点击预置视角广播一次并把高亮挪过去', () => {
        const bus = new EventBus<GraphCalcEvents>();
        const views: ViewHome[] = [];
        bus.on('camera:view', ({ view }) => views.push(view));

        const controller = new ViewCubeController(bus, panel.viewCube);
        // 初始不动:面板只给了默认高亮,没有"用户选了视角"这回事
        expect(views).toEqual([]);

        clickSegment(panel.viewCube.element, 0);
        expect(views).toEqual(['top']);
        const buttons = stub(panel.viewCube.element).children as StubElement[];
        expect(buttons[0].classList.contains('active')).toBe(true);
        expect(buttons[3].classList.contains('active')).toBe(false);

        controller.dispose();
        clickSegment(panel.viewCube.element, 1);
        expect(views).toEqual(['top']);
    });
});

describe('AxisUpController', () => {
    it('启动广播默认轴,选中新轴后广播,重复点已选项不广播', () => {
        const bus = new EventBus<GraphCalcEvents>();
        const axes: string[] = [];
        bus.on('axis:upChanged', ({ axis }) => axes.push(axis));

        const controller = new AxisUpController(bus, panel.axis.up);
        expect(axes).toEqual([RENDER_CONFIG.scene.upAxis]);

        clickSegment(panel.axis.up.element, 0);
        expect(axes).toEqual([RENDER_CONFIG.scene.upAxis, 'x']);

        clickSegment(panel.axis.up.element, 0);
        expect(axes).toHaveLength(2);

        controller.dispose();
    });
});

describe('PointStyleController 大小/比例单一来源(RND-P3.2)', () => {
    it('切换模式保持实际半径,比例模式按基准半径换算', () => {
        const bus = new EventBus<GraphCalcEvents>();
        const emitted: number[] = [];
        bus.on('point:changed', ({ radius }) => emitted.push(radius));
        const base = RENDER_CONFIG.scene.point.radius;
        const field = panel.point.value;

        const controller = new PointStyleController(bus, panel.point);
        expect(emitted).toEqual([base]);
        // 初始显示绝对半径
        expect(field.readText()).toBe(String(base));

        // 切到比例:实际半径不变,显示换算成 1
        clickSegment(panel.point.mode.element, 1);
        expect(emitted[1]).toBeCloseTo(base, 10);
        expect(field.readText()).toBe('1');
        expect(panel.point.valueLabel.textContent).toBe('缩放');
        expect(field.input.step).toBe(String(UI_CONFIG.view.point.scaleStep));

        // 比例 2 -> 半径 2 倍
        field.writeText('2');
        stub(field.input).dispatch('input');
        expect(emitted[2]).toBeCloseTo(base * 2, 10);

        // 切回大小:仍显示同一实际半径(旧实现会被配置里的 scale 覆盖)
        clickSegment(panel.point.mode.element, 0);
        expect(emitted[3]).toBeCloseTo(base * 2, 10);
        expect(field.readText()).toBe(String(Number((base * 2).toFixed(4))));
        expect(panel.point.valueLabel.textContent).toBe('大小');
        expect(field.input.step).toBe(String(UI_CONFIG.view.point.sizeStep));

        // 大小模式直接输入绝对值
        field.writeText('0.5');
        stub(field.input).dispatch('input');
        expect(emitted[4]).toBeCloseTo(0.5, 10);

        // 清空/非法输入保留旧值,不广播,并把文本回填成当前值
        field.writeText('');
        stub(field.input).dispatch('input');
        field.writeText('abc');
        stub(field.input).dispatch('input');
        expect(emitted).toHaveLength(5);
        expect(field.readText()).toBe('0.5');

        controller.dispose();
    });
});
