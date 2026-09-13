/**
 * 界面样式默认值.
 *
 * 与 `numericConfig` / `renderConfig` 同一约定:这里只放纯数据,不含 DOM
 * 或渲染逻辑.真正落到页面的是 `src/ui/applyUiConfig.ts`,它把这些值写成
 * `:root` 上的 CSS 变量,再由 `css/panels.css` 里的 `var()` 消费.
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
     * (见 `src/ui/EditorLineNumbers.ts` 的行号对齐说明).
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
    },
    /** 公式:底部对象列表里的 KaTeX */
    formula: {
        /**
         * KaTeX 字号,单位 em,基准是 `panels.css`/`.object-expr` 的 16px.
         * 1 -> 16px;只影响样式,不影响 FormulaView 的模板缓存.
         */
        katexFontSize: 1.5,
    },
} as const;
