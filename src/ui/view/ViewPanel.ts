/**
 * 右侧"视图"面板的声明式装配.
 *
 * 这一块以前散在 `index.html`(约 150 行手写 `div/label/input/span`)与 10 个
 * 控制器各自的 `document.getElementById` 之间:加一个控件要同时改 HTML,
 * 改某个控制器的 id 字符串,再祈祷页面上没有同名 id.现在改成:
 *
 * ```text
 * ViewPanel(本文件)   布局 + 控件实例 + 初值(唯一读配置的视图代码)
 *      │  handles
 *      ▼
 * 10 个 Controller     状态 + 校验 + EventBus 广播(不再碰 document)
 * ```
 *
 * 三条约定:
 * 1. **本文件不认识 EventBus**:它只建控件,给初值,把 handle 交出去;谁订阅,
 *    广播什么事件由控制器决定.所以这里是纯视图,可以在测试里单独装配断言.
 * 2. **配置只在这里读一次**:`RENDER_CONFIG` 给的是"渲染默认值"(初值),
 *    `UI_CONFIG.view` 给的是"控件能拖多细/有哪些选项"(min/step/清单).
 *    控制器不再各自持有"配置初值 + DOM 初值"两份,而是开局用 `handle.get()`
 *    把视图当前值收进自己的状态,再广播一次(等价于老代码的"启动时按配置
 *    同步一次").
 * 3. **句柄所有权归控制器**:面板本身不 `dispose` -- 每个控件恰好交给一个
 *    控制器,由它的 `dispose()` 统一解绑(见 `RenderController.wireViewControls`).
 *
 * 产出的 DOM 与原来的手写 HTML 同构,类名沿用 `css/controls.css` /
 * `css/panels.css`,所以样式一个字符都没改.唯一有意的差别是"行内可见文字"
 * 由 `<span>` 变成 `<label for>`(见 `widgets/Row.ts`),以及去掉了那些只给
 * `getElementById` 用的 id.
 */
import { RENDER_CONFIG, type UpAxis } from '../../config/renderConfig';
import { UI_CONFIG } from '../../config/uiConfig';
import type { AxisName, CamMode, GridPlane, PointMode, ViewHome } from '../../render/types';
import { el } from '../widgets/dom';
import { createNumberField, type NumberFieldHandle } from '../widgets/NumberField';
import {
    createControlGroup,
    createFieldLabel,
    createInlineToggle,
    createNumberRow,
    createRow,
    createSwitchRow,
} from '../widgets/Row';
import { createSegmented, type SegmentedHandle } from '../widgets/Segmented';
import { createSwitch, type SwitchHandle } from '../widgets/Switch';

/**
 * 相机模式复选框的语义:勾选 = 正交.
 *
 * 两个字面量只在这里出现一次,由 `CameraToggle` 反向解释 -- 面板负责给开关
 * 定"勾选代表什么",控制器负责在勾选/点标签时把它翻译成 `CamMode`.若两处
 * 各写一份映射,改默认模式时就会"开关在南极,标签在北极".
 */
export const CAM_MODE_WHEN_CHECKED: CamMode = 'orthographic';
export const CAM_MODE_WHEN_UNCHECKED: CamMode = 'perspective';

/** 点的数值显示口径:保留 4 位小数再去零(与老 `PointStyleController` 一致). */
function formatPointValue(value: number): string {
    return String(Number(value.toFixed(4)));
}

/** 相机分组:`透视 / 开关 / 正交` + 旋转锁定. */
export interface CameraControls {
    readonly toggle: SwitchHandle;
    /** 可点击的模式文字;点它与拨开关等价,是旁路入口. */
    readonly modeLabels: readonly { readonly mode: CamMode; readonly element: HTMLElement }[];
    readonly rotationLock: SwitchHandle;
}

/** 点分组. */
export interface PointControls {
    readonly visible: SwitchHandle;
    readonly mode: SegmentedHandle<PointMode>;
    readonly value: NumberFieldHandle;
    /** "大小 / 缩放"那个可见标签,文案随模式改,由控制器持有引用. */
    readonly valueLabel: HTMLLabelElement;
}

/** 坐标轴分组(含与坐标轴同节的网格刻度). */
export interface AxisControls {
    readonly up: SegmentedHandle<UpAxis>;
    readonly lineWidth: NumberFieldHandle;
    readonly ticks: SwitchHandle;
    readonly piUnit: SwitchHandle;
    readonly labels: Readonly<Record<AxisName, SwitchHandle>>;
    readonly grids: Readonly<Record<GridPlane, SwitchHandle>>;
    readonly majorWidth: NumberFieldHandle;
    readonly minorWidth: NumberFieldHandle;
}

/** 曲面分组. */
export interface SurfaceControls {
    readonly wireframe: SwitchHandle;
    readonly colorMap: SwitchHandle;
}

export interface ViewPanel {
    /** 宿主节点(`#view-controls`),即右面板里可滚动的那一块. */
    readonly element: HTMLElement;
    readonly camera: CameraControls;
    readonly viewCube: SegmentedHandle<ViewHome>;
    readonly point: PointControls;
    readonly axis: AxisControls;
    readonly surface: SurfaceControls;
}

/** 建出整块视图面板并挂进 `host`.`host` 原有内容会被清空. */
export function createViewPanel(host: HTMLElement): ViewPanel {
    const config = RENDER_CONFIG;
    const view = UI_CONFIG.view;

    // ── 相机 ────────────────────────────────────────────────────────────
    // 透视/正交两段文字是"点一下也能切"的旁路入口;开关才是可访问的主入口,
    // 所以文字保持 <span>(不用 <label for>,否则会与开关的可访问名打架).
    const perspective: HTMLElement = el('span', { class: 'cam-label', text: '透视' });
    const orthographic: HTMLElement = el('span', { class: 'cam-label', text: '正交' });
    const modeLabels: CameraControls['modeLabels'] = [
        { mode: CAM_MODE_WHEN_UNCHECKED, element: perspective },
        { mode: CAM_MODE_WHEN_CHECKED, element: orthographic },
    ];
    for (const label of modeLabels) {
        label.element.classList.toggle('active', label.mode === config.camera.defaultMode);
    }
    const cameraToggle = createSwitch({
        value: config.camera.defaultMode === CAM_MODE_WHEN_CHECKED,
        ariaLabel: '正交投影',
    });
    // 旋转锁定没有配置默认值(老代码读 DOM 的勾选态,软重载会被浏览器恢复);
    // 面板由脚本生成,浏览器不会恢复动态节点的表单态,所以固定从 false 起.
    const rotationLock = createSwitch({ value: false });

    const camera = createRow(
        perspective,
        cameraToggle.element,
        orthographic,
        createFieldLabel('锁定旋转', rotationLock.input.id),
        rotationLock.element,
    );

    // ── 预置视角 ────────────────────────────────────────────────────────
    // 选项与列数都来自 UI_CONFIG:加一个视角只改配置,这里不用动.
    const viewCube = createSegmented<ViewHome>({
        columns: view.viewCube.length,
        ariaLabel: '预置视角',
        value: config.camera.defaultHome,
        items: view.viewCube,
    });

    // ── 点 ──────────────────────────────────────────────────────────────
    const pointVisible = createSwitch({ value: config.scene.point.visible });
    const pointMode = createSegmented<PointMode>({
        columns: 2,
        ariaLabel: '点的显示方式',
        value: 'size',
        items: [
            { value: 'size', label: '设定大小' },
            { value: 'scale', label: '按比例缩放' },
        ],
    });
    const pointValue = createNumberField({
        value: config.scene.point.radius,
        min: view.point.min,
        step: view.point.sizeStep,
        format: formatPointValue,
    });
    const pointValueRow = createNumberRow('大小', pointValue);
    const point = createControlGroup(
        '点',
        createSwitchRow('全局可见', pointVisible),
        pointMode.element,
        pointValueRow.row,
    );

    // ── 坐标轴(含网格刻度)────────────────────────────────────────────
    const upAxis = createSegmented<UpAxis>({
        columns: 3,
        // 三选一按钮组在行内吃掉剩余宽度,又不无限拉长
        modifier: 'segmented--inline',
        ariaLabel: '向上轴',
        value: config.scene.upAxis,
        items: [
            { value: 'x', label: 'X' },
            { value: 'y', label: 'Y' },
            { value: 'z', label: 'Z' },
        ],
    });
    const axisLineWidth = createNumberField({
        value: config.scene.axisLineWidth,
        min: view.axis.lineWidthMin,
        step: view.axis.lineWidthStep,
    });
    const axisTicks = createSwitch({ value: config.scene.axisTicks.visible });
    const axisPiUnit = createSwitch({ value: config.scene.axisTicks.piUnit });
    const axisLabels: Record<AxisName, SwitchHandle> = {
        x: createSwitch({ value: config.scene.axisLabels.x }),
        y: createSwitch({ value: config.scene.axisLabels.y }),
        z: createSwitch({ value: config.scene.axisLabels.z }),
    };
    const gridPlanes: Record<GridPlane, SwitchHandle> = {
        xz: createSwitch({ value: config.scene.grid.planes.xz }),
        xy: createSwitch({ value: config.scene.grid.planes.xy }),
        yz: createSwitch({ value: config.scene.grid.planes.yz }),
    };
    const gridMajorWidth = createNumberField({
        value: config.scene.grid.majorLineWidth,
        min: view.axis.gridMajorMin,
        step: view.axis.gridMajorStep,
    });
    const gridMinorWidth = createNumberField({
        value: config.scene.grid.minorLineWidth,
        min: view.axis.gridMinorMin,
        step: view.axis.gridMinorStep,
    });

    const axis = createControlGroup(
        '坐标轴',
        createRow(el('span', { text: '向上' }), upAxis.element),
        createNumberRow('线宽', axisLineWidth).row,
        createSwitchRow('刻度', axisTicks),
        createSwitchRow('π 单位', axisPiUnit),
        createRow(
            el('span', { text: '标签' }),
            createInlineToggle('X', axisLabels.x),
            createInlineToggle('Y', axisLabels.y),
            createInlineToggle('Z', axisLabels.z),
        ),
        createRow(
            el('span', { text: '网格' }),
            createInlineToggle('XZ', gridPlanes.xz),
            createInlineToggle('XY', gridPlanes.xy),
            createInlineToggle('YZ', gridPlanes.yz),
        ),
        createNumberRow('大刻度线宽', gridMajorWidth).row,
        createNumberRow('小刻度线宽', gridMinorWidth).row,
    );

    // ── 曲面 ────────────────────────────────────────────────────────────
    const surfaceWireframe = createSwitch({ value: config.surfaceMesh.wireframeVisible });
    const surfaceColorMap = createSwitch({ value: config.surfaceMesh.colorMapEnabled });
    const surface = createControlGroup(
        '曲面',
        createSwitchRow('网格', surfaceWireframe),
        createSwitchRow('颜色映射', surfaceColorMap),
    );

    host.replaceChildren(camera, viewCube.element, point, axis, surface);

    return {
        element: host,
        camera: { toggle: cameraToggle, modeLabels, rotationLock },
        viewCube,
        point: { visible: pointVisible, mode: pointMode, value: pointValue, valueLabel: pointValueRow.label },
        axis: {
            up: upAxis,
            lineWidth: axisLineWidth,
            ticks: axisTicks,
            piUnit: axisPiUnit,
            labels: axisLabels,
            grids: gridPlanes,
            majorWidth: gridMajorWidth,
            minorWidth: gridMinorWidth,
        },
        surface: { wireframe: surfaceWireframe, colorMap: surfaceColorMap },
    };
}
