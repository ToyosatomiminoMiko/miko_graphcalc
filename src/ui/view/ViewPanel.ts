/**
 * 右侧"视图"面板的声明式装配.
 *
 * 这一块以前散在 `index.html`(约 150 行手写 `div/label/input/span`)与 10 个
 * 控制器各自的 `getElementById` 之间:加一个控件要同时改 HTML,改某个控制器的
 * id 字符串,再祈祷页面上没有同名 id.
 *
 * P3 之后的形状更短:
 *
 * ```text
 * createViewState()   唯一的视图状态源(signal / 派生信号 / 计算值)
 *      │  value: Signal<...>
 *      ▼
 * ViewPanel(本文件)   结构 + 控件 + 双向绑定(值变了控件自己更新)
 *      │  effect
 *      ▼
 * RenderController    订阅状态,推到 CameraManager / Plotter / SceneManager
 * ```
 *
 * 原来夹在中间的 9 个控制器(每个都存一份自己的状态再用 EventBus 广播)没有了:
 * 状态只有一份,**读值再转发**这件事由 `effect` 直接做.
 *
 * 三条约定:
 * 1. **本文件不认识渲染器**:它只把控件绑到状态上;谁订阅状态,推到哪由
 *    `RenderController` 决定.所以这里是纯视图,可以在测试里单独装配断言.
 * 2. **配置只在这里读结构性的部分**:控件能拖多细/有哪些选项来自
 *    `UI_CONFIG.view`;初值(渲染默认值)归 `createViewState()`.
 * 3. **面板拥有自己的控件与订阅**:`dispose()` 解绑全部控件,标签点击监听与
 *    内部订阅.重复装配前必须先 dispose 上一个句柄,否则旧控件会继续监听.
 *
 * 产出的 DOM 与原来的手写 HTML 同构,类名沿用库的 `styles/widgets.css` /
 * `css/panels.css`,所以样式一个字符都没改.唯一有意的差别是"行内可见文字"
 * 由 `<span>` 变成 `<label for>`(见 `widgets/Row.ts`),以及去掉了那些只给
 * `getElementById` 用的 id.
 */
import { UI_CONFIG } from '@/config/uiConfig';
import type { PointMode, UpAxis, ViewHome } from '@/contract/view';
import {
    createControlGroup,
    createFieldLabel,
    createInlineToggle,
    createNumberField,
    createNumberRow,
    createRow,
    createSegmented,
    createSwitch,
    createSwitchRow,
    create_element,
    watchValue,
    type NumberFieldHandle,
} from 'miko_ui';
import {
    CAM_MODE_WHEN_CHECKED,
    CAM_MODE_WHEN_UNCHECKED,
    type ViewState,
} from './viewState';

export { CAM_MODE_WHEN_CHECKED, CAM_MODE_WHEN_UNCHECKED };

/** 面板句柄:建完只留一个拆卸入口(控件与订阅都归面板所有). */
export interface ViewPanelHandle {
    readonly element: HTMLElement;
    dispose(): void;
}

/** 点的数值显示口径:保留 4 位小数再去零(与老 `PointStyleController` 一致). */
function formatPointValue(value: number): string {
    return String(Number(value.toFixed(4)));
}

/** 会被 `dispose()` 一起解绑的东西:控件句柄与内部订阅. */
interface Disposable {
    dispose(): void;
}

/**
 * 建出整块视图面板并挂进 `host`;**`host` 原有内容会被清空**.
 *
 * 返回值只有 `dispose()`:面板自己拥有全部控件与订阅(不再"把每个句柄交给
 * 一个控制器"),所以拆卸也只有一处.想刷新面板不要"再调一次",而是
 * `dispose()` 之后再建(否则旧订阅会留在状态上).
 */
export function createViewPanel(host: HTMLElement, state: ViewState): ViewPanelHandle {
    const view = UI_CONFIG.view;
    const abort = new AbortController();
    const disposables: Disposable[] = [];
    const stops: Array<() => void> = [];

    /**
     * 数字框的"即时回退":下限只是 HTML 约束,浏览器拦不住手工输入的负数;
     * 低于下限时把文本回填成当前值(值本身到不了状态源,见 `boundedInput`).
     */
    const guardLowerBound = (field: NumberFieldHandle, min: number, current: () => number): void => {
        field.onInput((raw) => {
            if (raw === null || raw < min) field.write(current());
        });
    };

    // ── 相机 ────────────────────────────────────────────────────────────
    // 透视/正交两段文字是"点一下也能切"的旁路入口;开关才是可访问的主入口,
    // 所以文字保持 <span>(不用 <label for>,否则会与开关的可访问名打架).
    const perspective = create_element({ tag: 'span' }, { class: 'cam-label' }, '透视');
    const orthographic = create_element({ tag: 'span' }, { class: 'cam-label' }, '正交');
    const modeLabels = [
        { mode: CAM_MODE_WHEN_UNCHECKED, element: perspective },
        { mode: CAM_MODE_WHEN_CHECKED, element: orthographic },
    ] as const;
    const cameraToggle = createSwitch({ value: state.camIsOrtho, ariaLabel: '正交投影' });
    // 旋转锁定没有配置默认值(老代码读 DOM 的勾选态,软重载会被浏览器恢复);
    // 面板由脚本生成,浏览器不会恢复动态节点的表单态,所以固定从 false 起.
    const rotationLock = createSwitch({ value: state.rotationLock });
    disposables.push(cameraToggle, rotationLock);

    // 两套 UI 都由 camMode 推导:开关是派生视图(双向),标签只读.
    stops.push(watchValue(state.camMode, (mode) => {
        for (const label of modeLabels) {
            label.element.classList.toggle('active', label.mode === mode);
        }
    }));
    for (const label of modeLabels) {
        label.element.addEventListener('click', () => {
            state.camIsOrtho.value = label.mode === CAM_MODE_WHEN_CHECKED;
        }, { signal: abort.signal });
    }

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
        value: state.viewHome,
        items: view.viewCube,
    });
    disposables.push(viewCube);

    // ── 点 ──────────────────────────────────────────────────────────────
    const pointVisible = createSwitch({ value: state.pointVisible });
    const pointMode = createSegmented<PointMode>({
        columns: 2,
        ariaLabel: '点的显示方式',
        value: state.pointMode,
        items: [
            { value: 'size', label: '设定大小' },
            { value: 'scale', label: '按比例缩放' },
        ],
    });
    const pointValue = createNumberField({
        value: state.pointDisplay,
        min: view.point.min,
        // 步长跟着模式走:绝对值与比例各一档(见 viewState.pointStep).
        step: state.pointStep,
        format: formatPointValue,
    });
    disposables.push(pointVisible, pointMode, pointValue);
    guardLowerBound(pointValue, view.point.min, () => state.pointDisplay.peek());

    const pointValueRow = createNumberRow('大小', pointValue);
    // 标签文案随模式变:大小模式是绝对值,比例模式是倍数.
    stops.push(watchValue(state.pointMode, (mode) => {
        pointValueRow.label.textContent = mode === 'size' ? '大小' : '缩放';
    }));

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
        value: state.upAxis,
        items: [
            { value: 'x', label: 'X' },
            { value: 'y', label: 'Y' },
            { value: 'z', label: 'Z' },
        ],
    });
    const axisLineWidth = createNumberField({
        value: state.axisLineWidthInput,
        min: view.axis.lineWidthMin,
        step: view.axis.lineWidthStep,
    });
    const axisTicks = createSwitch({ value: state.axisTicks });
    const axisPiUnit = createSwitch({ value: state.axisPiUnit });
    const axisLabels = {
        x: createSwitch({ value: state.axisLabelX }),
        y: createSwitch({ value: state.axisLabelY }),
        z: createSwitch({ value: state.axisLabelZ }),
    };
    const gridPlanes = {
        xz: createSwitch({ value: state.gridPlaneXZ }),
        xy: createSwitch({ value: state.gridPlaneXY }),
        yz: createSwitch({ value: state.gridPlaneYZ }),
    };
    const gridMajorWidth = createNumberField({
        value: state.gridMajorWidthInput,
        min: view.axis.gridMajorMin,
        step: view.axis.gridMajorStep,
    });
    const gridMinorWidth = createNumberField({
        value: state.gridMinorWidthInput,
        min: view.axis.gridMinorMin,
        step: view.axis.gridMinorStep,
    });
    disposables.push(
        upAxis,
        axisLineWidth,
        axisTicks,
        axisPiUnit,
        axisLabels.x,
        axisLabels.y,
        axisLabels.z,
        gridPlanes.xz,
        gridPlanes.xy,
        gridPlanes.yz,
        gridMajorWidth,
        gridMinorWidth,
    );
    guardLowerBound(axisLineWidth, view.axis.lineWidthMin, () => state.axisLineWidth.peek());
    guardLowerBound(gridMajorWidth, view.axis.gridMajorMin, () => state.gridMajorWidth.peek());
    guardLowerBound(gridMinorWidth, view.axis.gridMinorMin, () => state.gridMinorWidth.peek());

    const axis = createControlGroup(
        '坐标轴',
        createRow(create_element({ tag: 'span' }, {}, '向上'), upAxis.element),
        createNumberRow('线宽', axisLineWidth).row,
        createSwitchRow('刻度', axisTicks),
        createSwitchRow('π 单位', axisPiUnit),
        createRow(
            create_element({ tag: 'span' }, {}, '标签'),
            createInlineToggle('X', axisLabels.x),
            createInlineToggle('Y', axisLabels.y),
            createInlineToggle('Z', axisLabels.z),
        ),
        createRow(
            create_element({ tag: 'span' }, {}, '网格'),
            createInlineToggle('XZ', gridPlanes.xz),
            createInlineToggle('XY', gridPlanes.xy),
            createInlineToggle('YZ', gridPlanes.yz),
        ),
        createNumberRow('大刻度线宽', gridMajorWidth).row,
        createNumberRow('小刻度线宽', gridMinorWidth).row,
    );

    // ── 曲面 ────────────────────────────────────────────────────────────
    const surfaceWireframe = createSwitch({ value: state.surfaceWireframe });
    const surfaceColorMap = createSwitch({ value: state.surfaceColorMap });
    disposables.push(surfaceWireframe, surfaceColorMap);
    const surface = createControlGroup(
        '曲面',
        createSwitchRow('网格', surfaceWireframe),
        createSwitchRow('颜色映射', surfaceColorMap),
    );

    host.replaceChildren(camera, viewCube.element, point, axis, surface);

    return {
        element: host,
        dispose(): void {
            abort.abort();
            for (const stop of stops) stop();
            for (const disposable of disposables) disposable.dispose();
            disposables.length = 0;
        },
    };
}
