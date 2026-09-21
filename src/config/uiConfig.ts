/**
 * 界面样式默认值.
 *
 * 与 `numericConfig` / `renderConfig` 同一约定:这里只放纯数据,不含 DOM
 * 或渲染逻辑.真正落到页面的是 `@miko/ui/src/theme/applyUiConfig.ts`,它把这些值写成
 * `:root` 上的 CSS 变量,再由 `css/editor.css` 与 `css/panels.css` 里的 `var()` 消费.
 *
 * 例外:`panel` 里的拖拽夹取范围与整个 `view` 段落**只有 TS 消费**,CSS 没有
 * 同名变量,所以不进 `applyUiConfig` 的映射表(见各自的注释);它们放在这里的
 * 理由是"界面默认值"这一条,而不是"要变成 CSS 变量".
 *
 * 生效方式:改这里 -> 刷新页面(vite 开发态自动重建).
 * `css/base.css` 的 `:root` 里有同名变量的兜底值,必须与本文件保持一致:
 * 兜底只负责脚本执行前的首帧,正常路径一定会被 applyUiConfig 覆盖.
 */
import type {
    AxisSpec,
    DesktopConfig,
    WindowActionId,
    WindowGeometrySpec,
    WindowSlot,
} from '@miko/ui';

// 窗口系统的**通用词汇**(锚点/槽位/动作)由库定义(D4):应用侧只再导出,
// 不重复写第二份,否则"库说 slot 有 3 个,应用说有 4 个"这种事没有编译错误.
export type { AxisSpec, WindowActionId, WindowGeometrySpec, WindowSlot };

/** 窗口 id;数组顺序即 Dock 顺序与默认几何的依赖顺序(应用自己的清单). */
export type WindowId = 'source' | 'view' | 'params' | 'process' | 'objects';

/**
 * 标题栏采用节点的名字.
 *
 * 与 `WindowChrome` 的字段名一一对应(见 @miko/ui/src/desktop/windowChrome.ts):
 * 那边把它当 `Record<ChromeNodeId, HTMLElement>` 的键,所以这里少写一个名字
 * 或多写一个都会编译不过,不存在"配置里有,代码里没有"的漂移.
 */
export type ChromeNodeId = 'exampleButton' | 'runButton' | 'exampleMenu' | 'formulaCopyHint';

/** 采用关系:节点由 `createWindowChrome` 建,落在哪个窗口的哪个槽由这条给. */
export interface AdoptedNodeSpec {
    readonly node: ChromeNodeId;
    readonly window: WindowId;
    readonly slot: WindowSlot;
}

/**
 * 一个窗口:库的 `WindowConfigEntry` 的字段 + 应用自己的正文宿主 id.
 *
 * 为什么不直接 `extends WindowConfigEntry`:`id` 要从库的不透明 `string` **收窄**
 * 成应用的字面量联合,interface 继承做不到收窄.两者的可赋值性由下面
 * `UI_CONFIG.window` 的 `satisfies AppWindowConfig & DesktopConfig` 兜底.
 */
export interface AppWindowEntry {
    readonly id: WindowId;
    /** 标题栏文案,同时是 Dock 按钮的 `title` 与无障碍名. */
    readonly title: string;
    readonly dock: { readonly label: string };
    readonly defaultGeometry: WindowGeometrySpec;
    readonly minSize: { readonly w: number; readonly h: number };
}

/**
 * 应用侧的窗口段:库的 `DesktopConfig` 全部字段 + 两张应用表.
 *
 * - `adopted`:"哪个节点进哪个窗口的哪个槽"只有这一份声明,装配层不再写 if 链
 *   (见 docs/windowing-plan.md §5.3);
 * - `chrome`:标题栏节点的文案,字面量只在配置里,HTML 与 TS 都不留副本.
 */
export interface AppWindowConfig {
    /** 五个窗口,顺序即 z 初始序与 Dock 顺序. */
    readonly windows: readonly AppWindowEntry[];
    /** 标题栏上的窗口按钮:顺序即显示顺序,glyph 进配置不散在 TS 里. */
    readonly actions: readonly {
        readonly id: WindowActionId;
        readonly label: string;
        readonly glyph: string;
    }[];
    readonly adopted: readonly AdoptedNodeSpec[];
    readonly chrome: {
        /** 示例按钮的可见文案. */
        readonly exampleLabel: string;
        /** 运行按钮的可见文案. */
        readonly runLabel: string;
        /** 公式复制提示的初始文案. */
        readonly copyHint: string;
    };
    /** 移动/缩放时窗口至少留在桌内的宽度(px). */
    readonly edgeKeep: number;
    /** 窗口与桌面边缘的间隙(px). */
    readonly edgeGap: number;
    /** 标题栏至少可见高度(px):夹取 `y` 的上界要用它. */
    readonly headerMinVisible: number;
    /** 底部为 Dock 留出的高度(px). */
    readonly dockReserve: number;
    /** `.window-header` 高度(px):经 applyUiConfig 写成 CSS 变量,唯一副本. */
    readonly headerHeight: number;
    readonly z: {
        readonly windowLayer: number;
        readonly first: number;
        readonly snapPreview: number;
        readonly dock: number;
    };
    readonly snap: { readonly edge: number; readonly magnet: number };
}

export const UI_CONFIG = {
    /**
     * 源码编辑区(左面板).
     *
     * `#dsl-editor` 与 `#dsl-editor-lines` 必须共用同一组
     * fontFamily/fontSize/lineHeight,否则行号与文本会错行
     * (见 `src/ui/editor/EditorLineNumbers.ts` 的行号对齐说明).
     */
    editor: {
        /**
         * 字体栈:首选族与根站点(`public/css/index.css`)的拼写保持一致,都写成
         * 带空格的族名并加引号.本仓库不随产物提供该字体(没有 @font-face/字体
         * 文件),系统没装时按后面的 `ui-monospace` 等回退--这是刻意的兜底,
         * 不要再写成 `JetBrains-Mono-Slashed` 那种连字符族名(见 UI-P3.15).
         */
        fontFamily: "'JetBrains Mono Slashed', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        /** 字号,单位 px */
        fontSize: 16,
        /** 无单位行高,行号栏与输入框共用 */
        lineHeight: 1.2,
        /** 制表符宽度(按空格数计) */
        tabSize: 4,
        /**
         * 行号槽宽下限,单位 px;`EditorLineNumbers` 按字体度量出更宽的结果时以
         * 度量为准,只有量出来更窄(个位数行数)才落到这个下限.
         */
        gutterMinWidth: 32,
    },
    /** 公式:底部对象列表里的 KaTeX */
    formula: {
        /**
         * KaTeX 字号,单位 em,基准是 `panels.css`/`.object-expr` 的 16px.
         * 1 -> 16px;只影响样式,不影响 FormulaView 的模板缓存.
         */
        katexFontSize: 1.5,
    },
    /**
     * 面板**内容**的最小可视高度(px).
     *
     * 面板自己的几何(宽度/位置/折叠)已经归窗口系统:见下面的 `window` 段.
     * 这里剩下的两个数是"内容被压到多矮就不再舒服"的下限,由 CSS 消费
     * (`--params-panel-min-height` / `--view-controls-min-height`);窗口比下限
     * 还矮时,由那两块内容自己出内部滚动条,而不是把窗口撑破.
     */
    panel: {
        /** 参数窗口里参数列表的最小可视高度(px). */
        paramsMinHeight: 120,
        /** 视图窗口里视图控件的最小可视高度(px). */
        viewControlsMinHeight: 120,
    },
    /**
     * 桌面窗口化(见 docs/windowing-plan.md).
     *
     * 与 `editor` / `formula` 的区别:**窗口几何不进 CSS** -- 窗口是 JS 建的,
     * 在脚本跑之前窗口层是空的,不存在"CSS 首帧"这回事;几何的唯一真相源是
     * 这里 + `WindowGeometry` 纯函数,由 `WindowManager` 写成行内样式.所以
     * `applyUiConfig` 的映射表里没有任何 `--window-*`,唯一的例外是
     * `headerHeight`(`.window-header` 的高度)与两个夹取常量.
     *
     * 数组顺序即默认几何的依赖顺序(`view` 依赖 `source`,`process` 依赖
     * `params`),也是 Dock 的按钮顺序,不能随意调.
     */
    window: {
        windows: [
            {
                id: 'source',
                title: 'source code',
                dock: { label: '源码' },
                defaultGeometry: {
                    x: { at: 16 },
                    y: { at: 16 },
                    w: { at: 420 },
                    // round((dH - dockReserve - edgeGap) * 0.68):让出左列下部给视图窗口
                    h: { fraction: 0.68, of: 'usableHeight' },
                },
                minSize: { w: 300, h: 220 },
            },
            {
                id: 'view',
                title: '视图',
                dock: { label: '视图' },
                defaultGeometry: {
                    x: { at: 16 },
                    y: { at: 0 }, // 占位:存在 after 时以 after 为准
                    w: { at: 420 },
                    // h = dH - inset - y,与 process 共用同一条底边
                    h: { from: 'bottom', inset: 116 },
                    after: { id: 'source', gap: 12 },
                },
                minSize: { w: 280, h: 180 },
            },
            {
                id: 'params',
                title: '参数',
                dock: { label: '参数' },
                defaultGeometry: {
                    x: { from: 'right', inset: 16 },
                    y: { at: 16 },
                    w: { at: 420 },
                    // round((dH - dockReserve - edgeGap) * 0.55)
                    h: { fraction: 0.55, of: 'usableHeight' },
                },
                minSize: { w: 280, h: 200 },
            },
            {
                id: 'process',
                title: '过程',
                dock: { label: '过程' },
                defaultGeometry: {
                    x: { from: 'right', inset: 16 },
                    y: { at: 0 }, // 占位:存在 after 时以 after 为准
                    w: { at: 420 },
                    h: { from: 'bottom', inset: 116 },
                    after: { id: 'params', gap: 12 },
                },
                minSize: { w: 280, h: 180 },
            },
            {
                id: 'objects',
                title: '对象',
                dock: { label: '对象' },
                defaultGeometry: {
                    // 中列宽度是算出来的:dW - 2 * (420 + 16),夹到 [360, 720]
                    x: 'center',
                    y: { from: 'bottom', inset: 116 },
                    w: { clamp: [360, 720], inset: 2 * 436 + 32 },
                    h: { at: 260 },
                },
                minSize: { w: 360, h: 160 },
            },
        ],
        actions: [
            { id: 'minimize', label: '最小化', glyph: '─' },
            { id: 'maximize', label: '最大化', glyph: '▣' },
            { id: 'fullscreen', label: '全屏', glyph: '⤢' },
            { id: 'close', label: '关闭', glyph: '✕' },
        ],
        // 四个应用节点由 createWindowChrome() 用 el() 建,这里只声明它们落在哪
        // (旧写法是 index.html 里一个 hidden 暂存区 + DslApp 里一条 if 链).
        adopted: [
            { node: 'exampleButton', window: 'source', slot: 'actions' },
            { node: 'runButton', window: 'source', slot: 'actions' },
            { node: 'exampleMenu', window: 'source', slot: 'overlays' },
            { node: 'formulaCopyHint', window: 'objects', slot: 'title' },
        ],
        chrome: {
            exampleLabel: '示例',
            runLabel: 'RUN',
            copyHint: '点击公式复制 TeX',
        },
        edgeKeep: 80,
        edgeGap: 16,
        headerMinVisible: 36,
        dockReserve: 100,
        headerHeight: 36,
        /**
         * 三层容器的 z-index(由 WindowManager 写成行内样式,是**唯一**来源:
         * CSS 里没有这几个数).`snapPreview` 必须在窗口层**之下**--它标记的是
         * "窗口会落到哪里",画在窗口之上会盖住正在拖的那个窗口.
         */
        z: { windowLayer: 100, first: 110, snapPreview: 50, dock: 200 },
        snap: { edge: 16, magnet: 8 },
    } as const satisfies AppWindowConfig,
    /**
     * 过程视图的展示参数.
     *
     * 与 `panel` 里那部分同理,**CSS 用不到**这两个数(`disclosureThreshold` 与
     * `maxSteps` 只被纯函数当数字用),所以它们不进 `applyUiConfig` 的变量表,
     * `css/base.css` 里也没有第二份副本.
     *
     * 过程的**几何**归窗口系统:过程是独立窗口,默认几何与最小尺寸见上面的
     * `window.windows` 里 `process` 那一项,拖宽拖窄由用户自己决定.
     */
    process: {
        /**
         * 三级披露阈值:细节行数**超过**它就进 L2 过程窗口,否则留在 L1 行内
         * `<details>`.与底栏"一屏约 14 行"的上限配合,留在 L1 的最多占掉
         * 不到半个底栏(见 docs/equation-solving-process.md 第 5 节).
         *
         * 默认取 **5**(设计文档建议 6,并写明"由实测定"):一期数据源里最长的
         * 细节是带球坐标回显的梯度(符号展开 / 数值 / 取点 / 球坐标 / 函数值 /
         * 切向量,共 6 行,见 `example/sphere_gradient.miko` 的 `grad` 球坐标写法).
         * 取 5 时典型 3–5 行的梯度仍留在 L1(与文档的"通常 3–5 行"一致),而这条
         * 6 行的最长过程真的进 L2,一期验收才有一条可复现的入口;取 6 则一期
         * 没有任何数据源能触发 L2,入口与过程页都无从验证.
         */
        disclosureThreshold: 5,
        /**
         * 单条过程最多渲染的步骤数.
         *
         * 超长过程必须**截断并注明**,不能无上限铺开;这个上限与 FormulaView
         * 的模板缓存上限(512)分开算:步骤行的 LaTeX 键是"表达式签名 × 步数",
         * 是有限集合,要的是"上限本身有明确语义",不是扩容缓存.
         */
        maxSteps: 48,
    },
    /**
     * 视图控件(右侧"视图"面板)的行为参数.
     *
     * 与 `panel` 里那部分同理,**CSS 用不到**这些值:它们是控件的 min/step 与
     * 选项清单,只被 `ui/view/ViewPanel` 与 `ui/view/controls/*` 当数字/数据用,
     * 所以不进 `applyUiConfig` 的变量表,`css/base.css` 里也就没有第二份副本.
     *
     * 与 `renderConfig` 的分工:那里是**渲染默认值**(点半径 0.2,轴线宽 3),
     * 这里是**控件的可调范围与步长**.同名量的默认值与步长分居两处是刻意的:
     * 改默认值不该顺带改用户能拖多细,也不该让"渲染要不要画这个"受 UI 影响.
     */
    view: {
        point: {
            /** 半径下限(比例模式的下限同为 0). */
            min: 0,
            /** "设定大小"模式的步长. */
            sizeStep: 0.05,
            /** "按比例缩放"模式的步长. */
            scaleStep: 0.1,
        },
        axis: {
            /** 坐标轴线宽(px)的下限与步长. */
            lineWidthMin: 1,
            lineWidthStep: 0.5,
            /** 网格大刻度线宽(px). */
            gridMajorMin: 1,
            gridMajorStep: 0.5,
            /** 网格小刻度线宽(px). */
            gridMinorMin: 0.5,
            gridMinorStep: 0.25,
        },
        /**
         * ViewCube 暴露的预置视角:顺序即按钮顺序,列数取它的长度.
         *
         * 只列 UI 真正给出口的四个(`ViewHome` 还有 bottom/back/left);需要时
         * 在这里加一条即可,值域与 `render/types` 的 `ViewHome` 同域.
         */
        viewCube: [
            { value: 'top', label: '上' },
            { value: 'front', label: '前' },
            { value: 'right', label: '右' },
            { value: 'isometric', label: 'ISO' },
        ],
    },
} as const;

/**
 * 类型契约:应用的窗口段必须能被库的 `WindowManager` **原样**消费(D4).
 *
 * 单独写一条赋值而不是并进上面的 `satisfies AppWindowConfig & DesktopConfig`:
 * 后者是对对象字面量的检查,会走"多余属性"规则,把应用自己的 `adopted` /
 * `chrome` 报成"库的 `DesktopConfig` 里没有这两个属性";这里两边都是非字面量
 * 表达式,只做可赋值性判断 -- 库改了必填字段(比如新增一个夹取常量)会立刻在
 * 这里失败.
 */
const desktopConfigContract: DesktopConfig = UI_CONFIG.window;
void desktopConfigContract;

/**
 * 窗口段里的**库配置部分**(D1/D4):`mountDesktop()` 要的那几个字段.
 *
 * `adopted` / `chrome` 是应用装配用的表(哪个标题栏节点进哪个窗口),不属于
 * 桌面配置;显式列一遍字段而不是解构剔除,是为了让"库配置多了/少了哪一项"
 * 在编译期就能看出来.
 */
export function desktopConfig(): DesktopConfig {
    const {
        windows,
        actions,
        edgeKeep,
        edgeGap,
        headerMinVisible,
        dockReserve,
        headerHeight,
        z,
        snap,
    } = UI_CONFIG.window;
    return {
        windows,
        actions,
        edgeKeep,
        edgeGap,
        headerMinVisible,
        dockReserve,
        headerHeight,
        z,
        snap,
    };
}
