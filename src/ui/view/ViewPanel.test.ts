/**
 * 视图面板装配的结构契约(最小 DOM 桩,见 `test/domStub.ts`).
 *
 * 这份测试锁的是**样式契约**:`ViewPanel` 把原来 `index.html` 里的手写标记
 * 搬进了 TS,类名就是 `css/controls.css` 的选择器.少一个类名不会报错,只会
 * 静默丢样式,所以在这里把"每个控件长什么样,挂在哪一层"钉死.
 *
 * 顺带锁初值来源:面板是唯一按 `RENDER_CONFIG` 给视图灌初值的地方,控制器
 * 开局从这里读回状态,所以初值错了会在这一层先暴露.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installDomStub, StubElement } from '../../test/domStub';
import { RENDER_CONFIG } from '../../config/renderConfig';
import { createViewPanel, type ViewPanel } from './ViewPanel';

let panel: ViewPanel;

beforeEach(() => {
    installDomStub();
    const host = document.createElement('section');
    host.id = 'view-controls';
    document.body.append(host);
    panel = createViewPanel(host);
});

function stub(element: unknown): StubElement {
    return element as StubElement;
}

/** 直接子元素(过滤文本节点)的类名序列. */
function childClasses(element: unknown): string[] {
    return stub(element).children
        .filter((child): child is StubElement => child instanceof StubElement)
        .map((child) => child.className);
}

function descendants(element: unknown, selector: string): StubElement[] {
    return stub(element).querySelectorAll<StubElement>(selector)
        .filter((node): node is StubElement => node instanceof StubElement);
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
        expect(childClasses(panel.element)).toEqual([
            'cam-toggle',
            'viewcube',
            'point-controls',
            'axis-controls',
            'surface-controls',
        ]);

        // 再次装配应整体替换,而不是叠加
        createViewPanel(panel.element);
        expect(childClasses(panel.element)).toHaveLength(5);
    });

    it('相机行:两个可点模式文字夹一个开关,再加锁定旋转', () => {
        const camera = panel.element.querySelector('.cam-toggle')!;
        // 顺序:透视 / 开关 / 正交(默认高亮) / "锁定旋转"标签(无类名) / 开关
        expect(childClasses(camera)).toEqual([
            'cam-label',
            'switch',
            'cam-label active',
            '',
            'switch',
        ]);

        const [perspective, , orthographic] = stub(camera).children as StubElement[];
        expect(perspective.textContent).toBe('透视');
        expect(orthographic.textContent).toBe('正交');
        // 默认模式是正交 -> 开关勾选,"正交"高亮
        expect(panel.camera.toggle.get()).toBe(true);
        expect(orthographic.classList.contains('active')).toBe(true);
        expect(perspective.classList.contains('active')).toBe(false);
        // 旋转锁定的可见文字是一个关联到开关的 label
        const rotationLabel = stub(camera).children[3] as StubElement;
        expect(rotationLabel.tagName).toBe('label');
        expect(rotationLabel.textContent).toBe('锁定旋转');
        expect(rotationLabel.htmlFor).toBe(panel.camera.rotationLock.input.id);
    });

    it('预置视角:四个按钮,默认视角高亮', () => {
        const buttons = stub(panel.viewCube.element).children as StubElement[];
        expect(buttons.map((button) => button.textContent)).toEqual(['上', '前', '右', 'ISO']);
        const active = buttons.filter((button) => button.classList.contains('active'));
        expect(active).toHaveLength(1);
        expect(active[0].textContent).toBe('ISO');
    });

    it('点:标题 + 全局可见开关 + 模式二选一 + 大小数字框', () => {
        const point = panel.element.querySelector('.point-controls')!;
        expect(stub(point).querySelector<StubElement>('header')!.textContent).toBe('点');
        expect(stub(point).querySelector<StubElement>('header')!.className).toBe('point-title');

        const modeButtons = stub(panel.point.mode.element).children as StubElement[];
        expect(modeButtons.map((button) => button.textContent)).toEqual([
            '设定大小',
            '按比例缩放',
        ]);
        expect(modeButtons[0].classList.contains('active')).toBe(true);

        expect(firstInput(panel.point.visible.element).checked)
            .toBe(RENDER_CONFIG.scene.point.visible);
        const value = firstInput(panel.point.value.element);
        expect(value.type).toBe('number');
        expect(value.min).toBe('0');
        expect(value.step).toBe('0.05');
        expect(value.value).toBe(String(RENDER_CONFIG.scene.point.radius));
        expect(panel.point.valueLabel.textContent).toBe('大小');
        expect(panel.point.valueLabel.htmlFor).toBe(value.id);
    });

    it('坐标轴:向上三选一 + 两个线宽 + 刻度/π 单位 + 六组行内开关', () => {
        const axis = panel.element.querySelector('.axis-controls')!;
        expect(stub(axis).querySelector<StubElement>('header')!.textContent).toBe('坐标轴');

        const upButtons = stub(panel.axis.up.element).children as StubElement[];
        expect(upButtons.map((button) => button.textContent)).toEqual(['X', 'Y', 'Z']);
        const activeUp = upButtons.filter((button) => button.classList.contains('active'));
        expect(activeUp).toHaveLength(1);
        expect(activeUp[0].textContent).toBe(RENDER_CONFIG.scene.upAxis.toUpperCase());

        expect(firstInput(panel.axis.lineWidth.element).value)
            .toBe(String(RENDER_CONFIG.scene.axisLineWidth));
        expect(firstInput(panel.axis.majorWidth.element).value)
            .toBe(String(RENDER_CONFIG.scene.grid.majorLineWidth));
        expect(firstInput(panel.axis.minorWidth.element).value)
            .toBe(String(RENDER_CONFIG.scene.grid.minorLineWidth));

        expect(firstInput(panel.axis.ticks.element).checked)
            .toBe(RENDER_CONFIG.scene.axisTicks.visible);
        expect(firstInput(panel.axis.piUnit.element).checked)
            .toBe(RENDER_CONFIG.scene.axisTicks.piUnit);

        // 三个轴标签 + 三个网格平面
        expect(descendants(axis, '.axis-switch-group')).toHaveLength(6);
        for (const axisName of ['x', 'y', 'z'] as const) {
            expect(firstInput(panel.axis.labels[axisName].element).checked)
                .toBe(RENDER_CONFIG.scene.axisLabels[axisName]);
        }
        for (const plane of ['xz', 'xy', 'yz'] as const) {
            expect(firstInput(panel.axis.grids[plane].element).checked)
                .toBe(RENDER_CONFIG.scene.grid.planes[plane]);
        }
    });

    it('曲面:标题 + 网格/颜色映射两个开关', () => {
        const surface = panel.element.querySelector('.surface-controls')!;
        expect(stub(surface).querySelector<StubElement>('header')!.textContent).toBe('曲面');
        expect(firstInput(panel.surface.wireframe.element).checked)
            .toBe(RENDER_CONFIG.surfaceMesh.wireframeVisible);
        expect(firstInput(panel.surface.colorMap.element).checked)
            .toBe(RENDER_CONFIG.surfaceMesh.colorMapEnabled);
    });

    it('所有开关都是 .switch + .slider 结构(复用 css/controls.css)', () => {
        const switches = descendants(panel.element, '.switch');
        expect(switches.length).toBeGreaterThanOrEqual(13);
        for (const element of switches) {
            expect(element.querySelector('.slider')).not.toBeNull();
            expect(element.querySelector<StubElement>('input')!.type).toBe('checkbox');
        }
    });
});
