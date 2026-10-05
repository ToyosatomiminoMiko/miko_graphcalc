/**
 * 视图窗口的**元素清单**:分组 / 顺序 / 行标签 / 控件种类 / 绑定的状态键.
 *
 * ## 它解决了什么
 *
 * 在这之前,"视图窗口里有哪些元素"只能从 `ViewPanel.ts` 的装配代码里读出来:
 * 分组标题,行标签,控件类型,顺序,绑定的 signal 全散在 ~120 行命令式代码里,
 * 而**数值**在 `UI_CONFIG.view`,**渲染默认值**在 `RENDER_CONFIG`,**状态**在
 * `viewState.ts`,**状态到渲染器的接线**在 `RenderController.ts`.一个"点的大小"
 * 因此要在 6 个文件之间来回看.
 *
 * 现在这张表回答"**有什么,叫什么,什么顺序,绑哪个状态键**",其余四处各回答
 * 自己的问题,不再互相遮着:
 *
 * ```text
 *   viewSpec.ts(本文件)  结构 + 文案 + 绑定的状态键     ← 视图窗口的"目录"
 *   UI_CONFIG.view       控件可调范围 / 步长 / 选项     ← 数值
 *   RENDER_CONFIG        渲染默认值                     ← 渲染侧自己也读,不能搬
 *   viewState.ts         状态 + 派生(换算 / 下限保护)   ← 逻辑
 *   RenderController.ts  状态 -> 渲染器的接线(effect)   ← 逻辑
 * ```
 *
 * 为什么不做成"一个大配置管全部":`render/core` 的六个文件(Plotter /
 * AnalysisRenderer / CameraManager / SceneManager ...)直接读 `RENDER_CONFIG`,
 * 把默认值并进 UI 配置就等于让渲染层依赖界面配置;"点大小的半径<->倍数换算"
 * 与"下限保护"也不是数据能表达的,只能是函数.所以并的只有同属 UI 的
 * 结构(这里)与数值(`UI_CONFIG.view`).
 *
 * ## 与 `ViewPanel.ts` 的分工
 *
 * 本文件**只声明**,不挂载:表格里的 `key` 是一个 `keyof ViewState` 字面量,
 * 取值域由 `viewState.ts` 的字段类型给(见下面的 `BoolKey` / `NumberKey`).
 * `ViewPanel.ts` 是解释器:按 `kind` 渲染出控件,收集句柄,统一拆卸.
 * 两行内容随状态变(相机行 / 点的大小行)不是通用 `kind` 能表达的,作为
 * `custom` 行把构建函数放在表里 -- 它们仍然是**这张表的一部分**,
 * 不会又散回装配代码去.
 *
 * ## 守卫
 *
 * `viewSpec.test.ts` 会红的三件事:表里写了不存在的状态键;某个 `ViewState`
 * 字段既没被本表引用,也没被 `RenderController` 订阅(孤儿 signal);同一个
 * 状态键被两行主绑定(两个控件抢一个真相).
 */
import { UI_CONFIG } from '@/config/uiConfig';
import type { PointMode, UpAxis, ViewHome } from '@/contract/view';
import {
    create_element,
    createFieldLabel,
    createNumberField,
    createNumberRow,
    createRow,
    createSwitch,
    numberText,
    watchValue,
    type SegmentedItem,
    type Signal,
} from 'miko_ui';
import type { ViewState } from './viewState';

/** 视图状态的键全集. */
export type ViewStateKey = keyof ViewState;

/**
 * 字段类型**恰好是** `Signal<boolean>` 的键:能绑到开关上.
 *
 * 用映射类型从 `ViewState` 自己推,而不是再抄一份名单:抄一份的代价是"新增一个
 * 开关 signal 忘了加进名单",而那正是要防的漂移.布尔字段现在全是 `Signal<boolean>`
 * (可写),所以判据写成"可写"这一档,`ReadonlySignal` 不会被误收.
 */
export type BoolKey = {
    [K in ViewStateKey]: ViewState[K] extends Signal<boolean> ? K : never;
}[ViewStateKey];

/** 字段类型**恰好是** `Signal<number>` 的键:能绑到数字框上(可调的那几个). */
export type NumberKey = {
    [K in ViewStateKey]: ViewState[K] extends Signal<number> ? K : never;
}[ViewStateKey];

/**
 * 渲染一行时面板交给构建器的三件事.
 *
 * 句柄与订阅由面板统一持有,构建器不自己存:拆卸路径只有 `createViewPanel` 的
 * `dispose()` 一条(见 `ViewPanel.ts`).
 */
export interface ViewSpecContext {
    /** 收一个控件/整行句柄,面板 `dispose()` 时统一解绑. */
    readonly own: (disposable: { dispose(): void }) => void;
    /** 收一个内部订阅的退订函数(值变了改文案这类). */
    readonly stop: (stop: () => void) => void;
    /** 相机两段文字那两条 click 监听共用的中止信号(随面板拆卸一起失效). */
    readonly signal: AbortSignal;
}

/** 一行"文字 + 开关":`createSwitchRow`. */
interface SwitchRowSpec {
    readonly kind: 'switch';
    readonly label: string;
    readonly key: BoolKey;
}

/** 一行"文字 + 数字框":`createNumberRow`;范围与步长是 `UI_CONFIG.view` 的数值. */
interface NumberRowSpec {
    readonly kind: 'number';
    readonly label: string;
    readonly key: NumberKey;
    readonly min: number;
    readonly step: number;
    /**
     * 是否给这一行挂"即时回退":低于 `min` 的输入不回写真相,文本回填当前值.
     *
     * `min` 只是 HTML 约束,浏览器拦不住手工输入的负数;而这三个线宽的下限是
     * **语义**上的(见 `viewState.ts` 的 `boundedInput`).
     */
    readonly guardLowerBound?: boolean;
}

/** 一行"文字 + 若干行内小开关":`createRow` + `createInlineToggle`(标签 / 网格). */
interface ToggleRowSpec {
    readonly kind: 'toggle-row';
    readonly label: string;
    readonly toggles: readonly { readonly text: string; readonly key: BoolKey }[];
}

/**
 * 分段行的公共部分.`label` 有值 = 包一层 `.control-row`(行内组,配
 * `segmented--inline`);没有 = 裸 `.segmented` 直接落在分组里(点模式 / 预置视角).
 */
interface SegmentedRowCommon {
    readonly ariaLabel: string;
    readonly columns: number;
    readonly label?: string;
    readonly modifier?: string;
}

/**
 * 分段行**按键分开列**:值的域是三个互不相同的联合类型
 * (`PointMode` / `UpAxis` / `ViewHome`),绑到哪个字段就要求 `items` 的
 * `value` 是哪个域.合成一个泛型行做不到这件事(表是异构的),而按 `key` 判别的
 * 联合既让类型成立,也让解释器能用 `switch (row.key)` 逐键收窄,不必强转.
 */
type PointModeRowSpec = SegmentedRowCommon & {
    readonly kind: 'segmented';
    readonly key: 'pointMode';
    readonly items: readonly SegmentedItem<PointMode>[];
};
type UpAxisRowSpec = SegmentedRowCommon & {
    readonly kind: 'segmented';
    readonly key: 'upAxis';
    readonly items: readonly SegmentedItem<UpAxis>[];
};
type ViewHomeRowSpec = SegmentedRowCommon & {
    readonly kind: 'segmented';
    readonly key: 'viewHome';
    readonly items: readonly SegmentedItem<ViewHome>[];
};
export type SegmentedRowSpec = PointModeRowSpec | UpAxisRowSpec | ViewHomeRowSpec;

/**
 * 内容随状态变的一行(相机行 / 点的大小行).
 *
 * `keys` 是这一行读到的状态键,**只给守卫用**(绑定写在 `build` 里,类型系统看不到);
 * 漏写 `keys` 不会让界面出错,只会让"孤儿 signal"那条守卫失去这一行的信息.
 */
interface CustomRowSpec {
    readonly kind: 'custom';
    readonly keys: readonly ViewStateKey[];
    readonly build: (state: ViewState, context: ViewSpecContext) => HTMLElement;
}

export type ViewRowSpec =
    | SwitchRowSpec
    | NumberRowSpec
    | ToggleRowSpec
    | SegmentedRowSpec
    | CustomRowSpec;

/** 分组:`createControlGroup`(小节标题 + 分隔线). */
export interface ViewGroupSpec {
    readonly kind: 'group';
    readonly title: string;
    readonly rows: readonly ViewRowSpec[];
}

/** 顶层的一块:分组,或一个不归宿任何分组的行(相机行 / 预置视角). */
export type ViewBlockSpec = ViewGroupSpec | ViewRowSpec;

/**
 * 点的数值口径:**显示文本与编辑文本共用同一个 `ValueText`**,输出与老
 * `PointStyleController` 的 `String(Number(v.toFixed(4)))` 逐字符相同.
 *
 * 为什么必须显式给 `exponentialAt`:库的编辑档默认在 `|v| < 1e-4` 或 `|v| >= 1e6`
 * 时切成 `e+n`(`1e-5` 排成 `1.0000e-5`),而"点的大小"这个读数一路是定点.
 * 把区间开成 `[0, Infinity)`(判据 `low <= |v| < high`,`Infinity` 恒成立)就是让
 * 定点分支吃下全部有限值.**这条等价关系由 `ViewPanel.test.ts` 的"口径等价"逐值
 * 钉住**,不靠注释:改库版本或改选项时它会先红.
 *
 * 非有限值给空串(库编辑档的固定写法):`<input type="number">` 本来就会把
 * `NaN` / `Infinity` 消毒成空串,显式写出来免得"值是 NaN"伪装成"用户清空了框";
 * 回读走库的 `parseNumber`,所以显示与编辑是同一份口径.
 *
 * 版本前提:编辑档"舍入到零去符号"那条修正(`-0.00004` 给 `0` 而不是 `-0`)与
 * "katex 收进库 `dependencies`"同属一批未发布改动,`^0.1.10` 之前的发布版没有它.
 */
export const POINT_DISPLAY_TEXT = numberText({
    syntax: 'edit',
    digits: 4,
    exponentialAt: { low: 0, high: Infinity },
});

/**
 * 相机行:`透视 [开关] 正交` 加一个"锁定旋转"开关,共处一行.
 *
 * 为什么是 `custom` 而不是通用行:两段文字是"点一下也能切"的旁路入口(写同一个
 * 真相),开关才是可访问的主入口,而锁定旋转又只是同一个行里的另一个开关 --
 * "文字 + 开关交替 + 行尾再来一组标签+开关"不是任何通用 `kind` 的形状.
 *
 * 文字的 `.active` 高亮已删:库与应用的样式表里都没有 `.cam-label` /
 * `.cam-label.active` 规则(全库唯一带 `.active` 的规则是 `.segmented
 * button.active`),那套订阅零可见效果.相机模式的选中态要等这一行改用库的
 * `createSegmented` 之后由控件自己给(那时本行会缩成一条普通的分段行).
 */
function buildCameraRow(state: ViewState, context: ViewSpecContext): HTMLElement {
    const perspective = create_element({ tag: 'span' }, { class: 'cam-label' }, '透视');
    const orthographic = create_element({ tag: 'span' }, { class: 'cam-label' }, '正交');
    const cameraToggle = createSwitch({ value: state.camIsOrtho, ariaLabel: '正交投影' });
    // 旋转锁定没有配置默认值(老代码读 DOM 的勾选态,软重载会被浏览器恢复);
    // 面板由脚本生成,浏览器不会恢复动态节点的表单态,所以固定从 false 起.
    const rotationLock = createSwitch({ value: state.rotationLock });
    context.own(cameraToggle);
    context.own(rotationLock);

    // 两段文字只写真相(勾选 = 正交),不自己存高亮.
    perspective.addEventListener('click', () => {
        state.camIsOrtho.value = false;
    }, { signal: context.signal });
    orthographic.addEventListener('click', () => {
        state.camIsOrtho.value = true;
    }, { signal: context.signal });

    return createRow(
        perspective,
        cameraToggle.element,
        orthographic,
        createFieldLabel('锁定旋转', rotationLock.input.id),
        rotationLock.element,
    );
}

/**
 * 点的大小行:一个数字框,标签与步长都跟着"设定大小 / 按比例缩放"走.
 *
 * 为什么是 `custom`:通用数字行的 `label` / `step` 是静态数值,而这一行的
 * 标签在 `大小` / `缩放` 之间换,步长来自 `viewState.pointStep`(随模式计算的
 * 派生信号),两者都要读状态.数字框绑的是 `pointDisplay`(显示值),写回由
 * `viewState` 的派生信号换算成真实半径 -- 界面这一层不做换算.
 */
function buildPointSizeRow(state: ViewState, context: ViewSpecContext): HTMLElement {
    const min = UI_CONFIG.view.point.min;
    const field = createNumberField({
        value: state.pointDisplay,
        min,
        step: state.pointStep,
        text: POINT_DISPLAY_TEXT,
    });
    context.own(field);

    // 下限的"即时回退":状态源上不会出现非法值(见 viewState 的 boundedInput),
    // 这里只负责把框里的文本拉回当前值,免得上限之外的输入留在眼前.
    field.onInput((raw) => {
        if (raw === null || raw < min) field.write(state.pointDisplay.peek());
    });

    const row = createNumberRow('大小', field);
    context.stop(watchValue(state.pointMode, (mode) => {
        row.label.textContent = mode === 'size' ? '大小' : '缩放';
    }));
    return row.row;
}

/**
 * 视图窗口的元素清单.**顺序即显示顺序**,顶层不归宿任何分组的行直接给出.
 *
 * 数值一律引用 `UI_CONFIG.view`(可调范围 / 步长 / 选项),不在这里抄第二份:
 * 抄一份就会与"用户能拖多细"那个真相分叉,而分叉不会报错.
 */
export const VIEW_BLOCKS: readonly ViewBlockSpec[] = [
    // 相机:没有分组标题,是窗口最上面的一行(高亮问题见 buildCameraRow 的说明).
    {
        kind: 'custom',
        keys: ['camIsOrtho', 'rotationLock'],
        build: buildCameraRow,
    },
    // 预置视角:裸分段行,没有可见标签,可访问名走 aria-label.
    {
        kind: 'segmented',
        key: 'viewHome',
        ariaLabel: '预置视角',
        columns: UI_CONFIG.view.viewCube.length,
        items: UI_CONFIG.view.viewCube,
    },
    {
        kind: 'group',
        title: '点',
        rows: [
            { kind: 'switch', label: '全局可见', key: 'pointVisible' },
            {
                kind: 'segmented',
                key: 'pointMode',
                ariaLabel: '点的显示方式',
                columns: 2,
                items: [
                    { value: 'size', label: '设定大小' },
                    { value: 'scale', label: '按比例缩放' },
                ],
            },
            {
                kind: 'custom',
                keys: ['pointDisplay', 'pointStep', 'pointMode'],
                build: buildPointSizeRow,
            },
        ],
    },
    {
        kind: 'group',
        title: '坐标轴',
        rows: [
            {
                kind: 'segmented',
                key: 'upAxis',
                ariaLabel: '向上轴',
                label: '向上',
                columns: 3,
                // 行内变体:在 `.control-row` 里吃掉剩余宽度,又不无限拉长
                modifier: 'segmented--inline',
                items: [
                    { value: 'x', label: 'X' },
                    { value: 'y', label: 'Y' },
                    { value: 'z', label: 'Z' },
                ],
            },
            {
                kind: 'number',
                label: '线宽',
                key: 'axisLineWidthInput',
                min: UI_CONFIG.view.axis.lineWidthMin,
                step: UI_CONFIG.view.axis.lineWidthStep,
                guardLowerBound: true,
            },
            { kind: 'switch', label: '刻度', key: 'axisTicks' },
            { kind: 'switch', label: 'π 单位', key: 'axisPiUnit' },
            {
                kind: 'toggle-row',
                label: '标签',
                toggles: [
                    { text: 'X', key: 'axisLabelX' },
                    { text: 'Y', key: 'axisLabelY' },
                    { text: 'Z', key: 'axisLabelZ' },
                ],
            },
            {
                kind: 'toggle-row',
                label: '网格',
                toggles: [
                    { text: 'XZ', key: 'gridPlaneXZ' },
                    { text: 'XY', key: 'gridPlaneXY' },
                    { text: 'YZ', key: 'gridPlaneYZ' },
                ],
            },
            {
                kind: 'number',
                label: '大刻度线宽',
                key: 'gridMajorWidthInput',
                min: UI_CONFIG.view.axis.gridMajorMin,
                step: UI_CONFIG.view.axis.gridMajorStep,
                guardLowerBound: true,
            },
            {
                kind: 'number',
                label: '小刻度线宽',
                key: 'gridMinorWidthInput',
                min: UI_CONFIG.view.axis.gridMinorMin,
                step: UI_CONFIG.view.axis.gridMinorStep,
                guardLowerBound: true,
            },
        ],
    },
    {
        kind: 'group',
        title: '曲面',
        rows: [
            { kind: 'switch', label: '网格', key: 'surfaceWireframe' },
            { kind: 'switch', label: '颜色映射', key: 'surfaceColorMap' },
        ],
    },
];
