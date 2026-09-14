/**
 * 界面样式默认值.
 *
 * 与 `numericConfig` / `renderConfig` 同一约定:这里只放纯数据,不含 DOM
 * 或渲染逻辑.真正落到页面的是 `src/ui/theme/applyUiConfig.ts`,它把这些值写成
 * `:root` 上的 CSS 变量,再由 `css/editor.css` 与 `css/panels.css` 里的 `var()` 消费.
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
} as const;
