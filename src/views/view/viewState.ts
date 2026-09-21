/**
 * "视图"面板的状态源(P3:spec + signal).
 *
 * ## 它替掉了什么
 *
 * 过去这一块是"9 个控制器 + EventBus 广播 + RenderController 订阅":
 *
 * ```text
 * SwitchHandle ──onChange──▶ CameraToggle ──emit('camera:changed')──▶ EventBus
 *                                                                      │
 *                                              RenderController.on(...) ┘ ──▶ CameraManager
 * ```
 *
 * 每个控制器内部还要再存一份自己的状态(`RotationLockController.locked`,
 * `PointStyleController.sizeValue`,...),于是"控件里的值"与"控制器里的值"是
 * 两个状态源,靠 `onChange` + `set()` 手工对齐.
 *
 * 现在只有一份:这里的一组 `signal`.面板把控件绑到它们上面(双向),渲染侧用
 * `effect` 订阅它们并推到 CameraManager/Plotter/SceneManager.中间那两层都消失.
 *
 * ## 两个"同一状态,两套表示"的地方
 *
 * | 真相 | 面板上的第二套表示 | 处理 |
 * | --- | --- | --- |
 * | `camMode: CamMode` | 开关的"勾选 = 正交" | `camIsOrtho`(`derivedSignal`) |
 * | `pointRadius: number` | 比例模式下的"倍数" | `pointDisplay`(`derivedSignal`) |
 *
 * 用可写派生信号而不是"再存一个布尔值/显示值":两个入口(开关与文字标签,
 * 数字框与模式按钮)都写同一个真相,不存在"改了一边忘了另一边".
 *
 * ## 输入下限
 *
 * 数字框的 `min` 只是 HTML 约束,浏览器不会拦住手工输入的 `-1`;而这三个量
 * (点大小,线宽,大/小刻度线宽)的下限是**语义**上的.所以每个都配一个
 * *Input 视图(派生信号)挡在控件与真相之间:低于下限的输入到不了真相,
 * 面板再把文本回填成当前值(`NumberField` 的"即时回退"策略).
 */
import { RENDER_CONFIG } from '@/config/renderConfig';
import { UI_CONFIG } from '@/config/uiConfig';
import type { CamMode, PointMode, UpAxis, ViewHome } from '@/contract/view';
import {
    computed,
    derivedSignal,
    signal,
    type ReadonlySignal,
    type Signal,
} from '@miko/ui';

/** 相机模式的两个字面量:勾选 = 正交.面板与状态源共用这一份映射. */
export const CAM_MODE_WHEN_CHECKED: CamMode = 'orthographic';
export const CAM_MODE_WHEN_UNCHECKED: CamMode = 'perspective';

/** 点的比例模式以"配置里的半径"为基准(1 = 100%). */
function baseRadius(): number {
    return RENDER_CONFIG.scene.point.radius;
}

/** 显示值 -> 实际半径(比例模式乘基准半径). */
function radiusFromDisplay(display: number, mode: PointMode): number {
    return mode === 'size' ? display : baseRadius() * display;
}

/** 实际半径 -> 显示值(比例模式除以基准半径). */
function displayFromRadius(radius: number, mode: PointMode): number {
    if (mode === 'size') return radius;
    return baseRadius() > 0 ? radius / baseRadius() : 0;
}

/**
 * 下限保护的输入视图:数字框绑它,低于 `min` 的输入不会写进真相.
 *
 * 真相信号上不会出现非法值,所以订阅它的渲染侧不必各自再判断一次.
 */
function boundedInput(truth: Signal<number>, min: number): Signal<number> {
    return derivedSignal(
        () => truth.value,
        (next) => {
            if (next >= min) truth.value = next;
        },
    );
}

/** 视图面板的全部状态;由 `createViewState()` 建一次,跟随应用存活. */
export interface ViewState {
    // ── 相机 ────────────────────────────────────────────────────────────
    readonly camMode: Signal<CamMode>;
    /** 开关与文字标签用的派生视图:勾选 = 正交. */
    readonly camIsOrtho: Signal<boolean>;
    readonly viewHome: Signal<ViewHome>;
    readonly rotationLock: Signal<boolean>;
    // ── 点 ──────────────────────────────────────────────────────────────
    readonly pointVisible: Signal<boolean>;
    readonly pointMode: Signal<PointMode>;
    /** 真相:点的**实际半径**. */
    readonly pointRadius: Signal<number>;
    /** 数字框显示值:大小模式=半径,比例模式=倍数. */
    readonly pointDisplay: Signal<number>;
    /** 数字框步长随模式变(绝对值一档,比例一档). */
    readonly pointStep: ReadonlySignal<number>;
    // ── 坐标轴 ──────────────────────────────────────────────────────────
    readonly upAxis: Signal<UpAxis>;
    readonly axisLineWidth: Signal<number>;
    readonly axisLineWidthInput: Signal<number>;
    readonly axisTicks: Signal<boolean>;
    readonly axisPiUnit: Signal<boolean>;
    readonly axisLabelX: Signal<boolean>;
    readonly axisLabelY: Signal<boolean>;
    readonly axisLabelZ: Signal<boolean>;
    readonly gridPlaneXZ: Signal<boolean>;
    readonly gridPlaneXY: Signal<boolean>;
    readonly gridPlaneYZ: Signal<boolean>;
    readonly gridMajorWidth: Signal<number>;
    readonly gridMajorWidthInput: Signal<number>;
    readonly gridMinorWidth: Signal<number>;
    readonly gridMinorWidthInput: Signal<number>;
    // ── 曲面 ────────────────────────────────────────────────────────────
    readonly surfaceWireframe: Signal<boolean>;
    readonly surfaceColorMap: Signal<boolean>;
}

/**
 * 建一份视图状态,初值全部来自 `RENDER_CONFIG`(渲染默认值)与
 * `UI_CONFIG.view`(控件范围/步长).
 *
 * 这两个配置的读取点从 9 个控制器收拢到这一个函数:改默认值只改配置,改
 * "读哪个默认值"只改这里.
 */
export function createViewState(): ViewState {
    const config = RENDER_CONFIG;
    const view = UI_CONFIG.view;

    // 相机:开关是 camMode 的派生视图,两个入口写同一个真相.
    const camMode = signal<CamMode>(config.camera.defaultMode);
    const camIsOrtho = derivedSignal(
        () => camMode.value === CAM_MODE_WHEN_CHECKED,
        (checked) => {
            camMode.value = checked ? CAM_MODE_WHEN_CHECKED : CAM_MODE_WHEN_UNCHECKED;
        },
    );

    // 点:半径是真相,显示值按模式换算.
    const pointMode = signal<PointMode>('size');
    const pointRadius = signal(config.scene.point.radius);
    const pointDisplay = derivedSignal(
        () => displayFromRadius(pointRadius.value, pointMode.value),
        (next) => {
            if (next < view.point.min) return;
            pointRadius.value = radiusFromDisplay(next, pointMode.peek());
        },
    );
    const pointStep = computed(() => (
        pointMode.value === 'size' ? view.point.sizeStep : view.point.scaleStep
    ));

    // 坐标轴与网格:三个线宽都走"下限保护"的输入视图.
    const axisLineWidth = signal(config.scene.axisLineWidth);
    const gridMajorWidth = signal(config.scene.grid.majorLineWidth);
    const gridMinorWidth = signal(config.scene.grid.minorLineWidth);

    return {
        camMode,
        camIsOrtho,
        viewHome: signal<ViewHome>(config.camera.defaultHome),
        rotationLock: signal(false),
        pointVisible: signal(config.scene.point.visible),
        pointMode,
        pointRadius,
        pointDisplay,
        pointStep,
        upAxis: signal<UpAxis>(config.scene.upAxis),
        axisLineWidth,
        axisLineWidthInput: boundedInput(axisLineWidth, view.axis.lineWidthMin),
        axisTicks: signal(config.scene.axisTicks.visible),
        axisPiUnit: signal(config.scene.axisTicks.piUnit),
        axisLabelX: signal(config.scene.axisLabels.x),
        axisLabelY: signal(config.scene.axisLabels.y),
        axisLabelZ: signal(config.scene.axisLabels.z),
        gridPlaneXZ: signal(config.scene.grid.planes.xz),
        gridPlaneXY: signal(config.scene.grid.planes.xy),
        gridPlaneYZ: signal(config.scene.grid.planes.yz),
        gridMajorWidth,
        gridMajorWidthInput: boundedInput(gridMajorWidth, view.axis.gridMajorMin),
        gridMinorWidth,
        gridMinorWidthInput: boundedInput(gridMinorWidth, view.axis.gridMinorMin),
        surfaceWireframe: signal(config.surfaceMesh.wireframeVisible),
        surfaceColorMap: signal(config.surfaceMesh.colorMapEnabled),
    };
}
