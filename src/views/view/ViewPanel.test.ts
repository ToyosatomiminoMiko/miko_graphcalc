/**
 * 视图面板装配的结构契约与绑定行为(最小 DOM 桩,见 `test/domStub.ts`).
 *
 * 两半:
 * 1. **样式契约**:`ViewPanel` 把原来 `index.html` 里的手写标记搬进了 TS,
 *    类名就是 `styles/widgets.css` 的选择器.少一个类名不会报错,只会静默丢样式,
 *    所以在这里把"每个控件长什么样,挂在哪一层"钉死;
 * 2. **绑定行为**(P3):控件与 `createViewState()` 的 signal 双向绑定 -- 写状态
 *    控件自己更新,用户操作写回状态.原来这半边由 9 个控制器 + EventBus 的
 *    测试覆盖,现在直接对着状态断言(少了两层中间物).
 *
 * 初值来源:面板是唯一读结构配置(`UI_CONFIG.view`)的地方,渲染默认值归
 * `createViewState()`;配置错了会在这一层先暴露.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installDomStub, StubElement } from '@/testing/domStub';
import { RENDER_CONFIG } from '@/config/renderConfig';
import { UI_CONFIG } from '@/config/uiConfig';
import { createViewPanel, type ViewPanelHandle } from './ViewPanel';
import { createViewState, type ViewState } from './viewState';

let state: ViewState;
let panel: ViewPanelHandle;
let host: HTMLElement;

beforeEach(() => {
    installDomStub();
    host = document.createElement('section');
    host.id = 'view-controls';
    document.body.append(host);
    state = createViewState();
    panel = createViewPanel(host, state);
});

function stub(element: unknown): StubElement {
    return element as StubElement;
}

/** 面板的直接子元素(过滤文本节点). */
function childrenOf(element: unknown): StubElement[] {
    return stub(element).children
        .filter((child): child is StubElement => child instanceof StubElement);
}

/** 直接子元素(过滤文本节点)的类名序列. */
function childClasses(element: unknown): string[] {
    return childrenOf(element).map((child) => child.className);
}

/** 第 index 个小节(顺序 相机 / 预置视角 / 点 / 坐标轴 / 曲面). */
function groupAt(index: number): StubElement {
    return childrenOf(host)[index];
}

function descendants(element: unknown, selector: string): StubElement[] {
    return stub(element).querySelectorAll<StubElement>(selector)
        .filter((node): node is StubElement => node instanceof StubElement);
}

/** 找出 `for` 指向某控件的可见标签(一行里可能有多条标签). */
function labelFor(root: unknown, id: string): StubElement {
    const labels = descendants(root, 'label').filter((label) => label.htmlFor === id);
    if (labels.length === 0) throw new Error(`没有 for=${id} 的标签`);
    return labels[0];
}

/** 取某控件根节点上的复选框/数字框(数字框的根节点本身就是 input). */
function firstInput(element: unknown): StubElement {
    const node = stub(element);
    return node.tagName === 'input'
        ? node
        : node.querySelector<StubElement>('input')!;
}

describe('createViewPanel 分组结构', () => {
    it('按 相机 / 预置视角 / 点 / 坐标轴 / 曲面 的顺序挂进宿主,且可重复装配', () => {
        expect(childClasses(host)).toEqual([
            'control-row',
            'segmented',
            'control-group',
            'control-group',
            'control-group',
        ]);

        // 再次装配应整体替换,而不是叠加(旧句柄要先 dispose,否则旧订阅还挂在状态上)
        panel.dispose();
        createViewPanel(host, state);
        expect(childClasses(host)).toHaveLength(5);
    });

    it('每个小节用标题给自己命名(aria-labelledby),标题类名统一', () => {
        for (const [index, title] of [[2, '点'], [3, '坐标轴'], [4, '曲面']] as const) {
            const group = groupAt(index);
            const header = childrenOf(group)[0];
            expect(group.className).toBe('control-group');
            expect(group.getAttribute('aria-labelledby')).toBe(header.id);
            expect(header.tagName).toBe('header');
            expect(header.className).toBe('control-title');
            expect(header.textContent).toBe(title);
        }
    });

    it('相机行:两个可点模式文字夹一个开关,再加锁定旋转', () => {
        const camera = groupAt(0);
        expect(camera.className).toBe('control-row');
        // 顺序:透视 / 开关 / 正交(默认高亮) / "锁定旋转"标签(无类名) / 开关
        expect(childClasses(camera)).toEqual([
            'cam-label',
            'switch',
            'cam-label active',
            '',
            'switch',
        ]);

        const [perspective, toggle, orthographic] = childrenOf(camera);
        expect(perspective.textContent).toBe('透视');
        expect(orthographic.textContent).toBe('正交');
        // 默认模式是正交 -> 开关勾选,"正交"高亮
        expect(firstInput(toggle).checked).toBe(true);
        expect(orthographic.classList.contains('active')).toBe(true);
        expect(perspective.classList.contains('active')).toBe(false);
        // 旋转锁定的可见文字是一个关联到开关的 label
        const rotationLabel = childrenOf(camera)[3];
        expect(rotationLabel.tagName).toBe('label');
        expect(rotationLabel.textContent).toBe('锁定旋转');
        expect(rotationLabel.htmlFor).toBe(firstInput(childrenOf(camera)[4]).id);
    });

    it('预置视角:选项与列数来自 UI_CONFIG,默认视角高亮', () => {
        const viewCube = groupAt(1);
        expect(viewCube.className).toBe('segmented');
        expect(viewCube.style.getPropertyValue('--segmented-columns'))
            .toBe(String(UI_CONFIG.view.viewCube.length));

        const buttons = childrenOf(viewCube);
        expect(buttons.map((button) => button.textContent))
            .toEqual(UI_CONFIG.view.viewCube.map((item) => item.label));
        const active = buttons.filter((button) => button.classList.contains('active'));
        expect(active).toHaveLength(1);
        expect(active[0].textContent).toBe('ISO');
    });

    it('点:标题 + 全局可见开关 + 模式二选一 + 大小数字框', () => {
        const point = groupAt(2);
        const switches = descendants(point, '.switch');
        expect(firstInput(switches[0]).checked).toBe(RENDER_CONFIG.scene.point.visible);

        const mode = descendants(point, '.segmented')[0];
        const modeButtons = childrenOf(mode);
        expect(modeButtons.map((button) => button.textContent)).toEqual([
            '设定大小',
            '按比例缩放',
        ]);
        expect(modeButtons[0].classList.contains('active')).toBe(true);
        expect(mode.style.getPropertyValue('--segmented-columns')).toBe('2');

        const value = descendants(point, 'input[type="number"]')[0];
        expect(value.min).toBe(String(UI_CONFIG.view.point.min));
        expect(value.step).toBe(String(UI_CONFIG.view.point.sizeStep));
        expect(value.value).toBe(String(RENDER_CONFIG.scene.point.radius));
        // 行内文字是 label,不是 span(可访问名的来源);数字框那一条由 for 指到它
        const label = labelFor(point, value.id);
        expect(label.tagName).toBe('label');
    });

    it('坐标轴:向上三选一 + 两个线宽 + 刻度/π 单位 + 六组行内开关', () => {
        const axis = groupAt(3);
        const up = descendants(axis, '.segmented')[0];
        expect(up.className).toBe('segmented segmented--inline');
        expect(up.style.getPropertyValue('--segmented-columns')).toBe('3');

        const upButtons = childrenOf(up);
        expect(upButtons.map((button) => button.textContent)).toEqual(['X', 'Y', 'Z']);
        const activeUp = upButtons.filter((button) => button.classList.contains('active'));
        expect(activeUp).toHaveLength(1);
        expect(activeUp[0].textContent).toBe(RENDER_CONFIG.scene.upAxis.toUpperCase());

        const numbers = descendants(axis, 'input[type="number"]');
        const byValue = (index: number, expected: number): StubElement => {
            const field = numbers[index];
            expect(field.value).toBe(String(expected));
            return field;
        };
        const lineWidth = byValue(0, RENDER_CONFIG.scene.axisLineWidth);
        const majorWidth = byValue(1, RENDER_CONFIG.scene.grid.majorLineWidth);
        const minorWidth = byValue(2, RENDER_CONFIG.scene.grid.minorLineWidth);

        // 下限/步长全部来自 UI_CONFIG.view.axis
        expect(lineWidth.min).toBe(String(UI_CONFIG.view.axis.lineWidthMin));
        expect(lineWidth.step).toBe(String(UI_CONFIG.view.axis.lineWidthStep));
        expect(majorWidth.min).toBe(String(UI_CONFIG.view.axis.gridMajorMin));
        expect(majorWidth.step).toBe(String(UI_CONFIG.view.axis.gridMajorStep));
        expect(minorWidth.min).toBe(String(UI_CONFIG.view.axis.gridMinorMin));
        expect(minorWidth.step).toBe(String(UI_CONFIG.view.axis.gridMinorStep));

        const switches = descendants(axis, '.switch');
        // 刻度 / π 单位 / 三个轴标签 / 三个网格平面 = 8 个开关
        expect(switches).toHaveLength(8);
        expect(firstInput(switches[0]).checked).toBe(RENDER_CONFIG.scene.axisTicks.visible);
        expect(firstInput(switches[1]).checked).toBe(RENDER_CONFIG.scene.axisTicks.piUnit);
        for (const [offset, axisName] of ['x', 'y', 'z'].entries()) {
            expect(firstInput(switches[2 + offset]).checked)
                .toBe(RENDER_CONFIG.scene.axisLabels[axisName as 'x' | 'y' | 'z']);
        }
        for (const [offset, plane] of ['xz', 'xy', 'yz'].entries()) {
            expect(firstInput(switches[5 + offset]).checked)
                .toBe(RENDER_CONFIG.scene.grid.planes[plane as 'xz' | 'xy' | 'yz']);
        }

        expect(descendants(axis, '.control-toggle-group')).toHaveLength(6);
    });

    it('曲面:标题 + 网格/颜色映射两个开关', () => {
        const surface = groupAt(4);
        expect(surface.querySelector<StubElement>('header')!.textContent).toBe('曲面');
        const switches = descendants(surface, '.switch');
        expect(firstInput(switches[0]).checked).toBe(RENDER_CONFIG.surfaceMesh.wireframeVisible);
        expect(firstInput(switches[1]).checked).toBe(RENDER_CONFIG.surfaceMesh.colorMapEnabled);
    });

    it('所有开关都是 .switch + .slider 结构(复用库的 styles/widgets.css)', () => {
        const switches = descendants(host, '.switch');
        expect(switches.length).toBeGreaterThanOrEqual(13);
        for (const element of switches) {
            expect(element.querySelector('.slider')).not.toBeNull();
            expect(element.querySelector<StubElement>('input')!.type).toBe('checkbox');
        }
    });
});

describe('控件与视图状态双向绑定(P3)', () => {
    it('相机:开关与文字标签都写同一个状态源,高亮跟着状态走', () => {
        const camera = groupAt(0);
        const [perspective, toggle, orthographic] = childrenOf(camera);

        perspective.dispatch('click');
        expect(state.camMode.peek()).toBe('perspective');
        expect(orthographic.classList.contains('active')).toBe(false);
        expect(perspective.classList.contains('active')).toBe(true);
        expect(firstInput(toggle).checked).toBe(false);

        // 反向:状态变了,开关与标签自己跟上(不需要任何 set 调用)
        state.camMode.value = 'orthographic';
        expect(firstInput(toggle).checked).toBe(true);
        expect(orthographic.classList.contains('active')).toBe(true);
    });

    it('开关切换直接写派生视图,再落到真相上', () => {
        const toggle = childrenOf(groupAt(0))[1];
        firstInput(toggle).checked = false;
        firstInput(toggle).dispatch('change');

        expect(state.camMode.peek()).toBe('perspective');
    });

    it('旋转锁定:写状态与读状态都通', () => {
        const rotation = descendants(groupAt(0), '.switch')[1];
        firstInput(rotation).checked = true;
        firstInput(rotation).dispatch('change');
        expect(state.rotationLock.peek()).toBe(true);

        state.rotationLock.value = false;
        expect(firstInput(rotation).checked).toBe(false);
    });

    it('预置视角:点按钮写状态,状态变化改高亮', () => {
        const buttons = childrenOf(groupAt(1));

        buttons[0].dispatch('click');
        expect(state.viewHome.peek()).toBe('top');

        state.viewHome.value = 'right';
        expect(buttons[2].classList.contains('active')).toBe(true);
        expect(buttons[0].classList.contains('active')).toBe(false);
    });

    it('点:切换模式改标签文案与步长,数字框显示换算后的值', () => {
        const point = groupAt(2);
        const mode = descendants(point, '.segmented')[0];
        const value = descendants(point, 'input[type="number"]')[0];
        const label = labelFor(point, value.id);

        state.pointMode.value = 'scale';

        expect(label.textContent).toBe('缩放');
        expect(value.step).toBe(String(UI_CONFIG.view.point.scaleStep));
        // 半径 0.2 / 基准 0.2 = 1(比例模式)
        expect(value.value).toBe('1');
        expect(childrenOf(mode)[1].classList.contains('active')).toBe(true);
    });

    it('点:数字框输入的是"显示值",写回的是实际半径', () => {
        const value = descendants(groupAt(2), 'input[type="number"]')[0];

        value.value = '0.5';
        value.dispatch('input');
        expect(state.pointRadius.peek()).toBe(0.5);

        state.pointMode.value = 'scale';
        value.value = '3';
        value.dispatch('input');
        expect(state.pointRadius.peek()).toBeCloseTo(0.6, 12);
    });

    it('点:低于下限的输入不进状态,文本回退到当前值', () => {
        const value = descendants(groupAt(2), 'input[type="number"]')[0];

        value.value = '-1';
        value.dispatch('input');

        expect(state.pointRadius.peek()).toBe(RENDER_CONFIG.scene.point.radius);
        expect(value.value).toBe(String(RENDER_CONFIG.scene.point.radius));
    });

    it('线条宽度的下限保护同样成立', () => {
        const numbers = descendants(groupAt(3), 'input[type="number"]');
        const lineWidth = numbers[0];

        lineWidth.value = '0';
        lineWidth.dispatch('input');

        expect(state.axisLineWidth.peek()).toBe(RENDER_CONFIG.scene.axisLineWidth);
        expect(lineWidth.value).toBe(String(RENDER_CONFIG.scene.axisLineWidth));
    });

    it('坐标轴与网格:开关直接写状态', () => {
        const axis = groupAt(3);
        const switches = descendants(axis, '.switch');

        const upButtons = childrenOf(descendants(axis, '.segmented')[0]);
        upButtons[1].dispatch('click');
        expect(state.upAxis.peek()).toBe('y');

        firstInput(switches[1]).checked = true;
        firstInput(switches[1]).dispatch('change');
        expect(state.axisPiUnit.peek()).toBe(true);

        const xzPlane = switches[5];
        firstInput(xzPlane).checked = false;
        firstInput(xzPlane).dispatch('change');
        expect(state.gridPlaneXZ.peek()).toBe(false);
    });

    it('曲面:开关写状态,状态写开关', () => {
        const switches = descendants(groupAt(4), '.switch');

        firstInput(switches[0]).checked = false;
        firstInput(switches[0]).dispatch('change');
        expect(state.surfaceWireframe.peek()).toBe(false);

        state.surfaceColorMap.value = false;
        expect(firstInput(switches[1]).checked).toBe(false);
    });

    it('dispose 之后改状态不再碰 DOM(订阅已摘)', () => {
        const toggle = childrenOf(groupAt(0))[1];

        panel.dispose();
        state.camMode.value = 'perspective';

        // 面板已经拆了,但节点还在:它不该再被订阅更新
        expect(firstInput(toggle).checked).toBe(true);
    });
});
