/**
 * 界面样式默认值.
 *
 * 与 `numericConfig` / `renderConfig` 同一约定:这里只放纯数据,不含 DOM
 * 或渲染逻辑.真正落到页面的是 `src/ui/theme/applyUiConfig.ts`,它把这些值写成
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
     * 面板布局几何(左源码 / 右参数 / 底部输出三个面板).
     *
     * 生效链路与 editor/formula 相同:`applyUiConfig()` 把需要写进 CSS 的那部分
     * 写成 `:root` 变量,`css/base.css` 的同名兜底只负责脚本执行前的首帧.
     * 区别在于**这里有一部分值 CSS 根本用不到**:
     *
     * - 拖拽的夹取上下限(sideMin/MaxWidth,footerMin/MaxHeight,splitMin/MaxRatio)
     *   只有 `PanelController` / `RightSplitController` 当数字用,CSS 里没有同名变量,
     *   所以不存在第二处副本,改这里就够了;
     * - 默认尺寸,折叠尺寸,两个最小高度,默认分割比例 CSS 首帧要消费,因此在
     *   `css/base.css` 的 `:root` 里有一份兜底,由 `applyUiConfig.test.ts` 锁住一致性:
     *   改这里却漏改兜底,测试会直接失败,不会静默闪一帧旧样式.
     */
    panel: {
        /** 左右侧面板宽度(px):拖拽夹取范围与初始宽度. */
        sideMinWidth: 220,
        sideMaxWidth: 875,
        sideDefaultWidth: 300,
        /** 底部面板高度(px):拖拽夹取范围与初始高度. */
        footerMinHeight: 160,
        footerMaxHeight: 640,
        footerDefaultHeight: 240,
        /** 折叠后只留一条窄边(px),`layout.css` 的 `.collapsed` 消费. */
        collapsedSideWidth: 44,
        collapsedFooterHeight: 40,
        /** 右面板上下两块内容各自的最小可视高度(px). */
        paramsMinHeight: 120,
        viewControlsMinHeight: 120,
        /** 参数区占右面板高度的默认比例与拖拽范围. */
        splitMinRatio: 0.15,
        splitMaxRatio: 0.8,
        splitDefaultRatio: 0.4,
    },
    /**
     * 视图控件(右侧"视图"面板)的行为参数.
     *
     * 与 `panel` 里那部分同理,**CSS 用不到**这些值:它们是控件的 min/step 与
     * 选项清单,只被 `ui/view/ViewPanel` 与 `render/controls/*` 当数字/数据用,
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
