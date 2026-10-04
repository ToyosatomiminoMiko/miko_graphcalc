/**
 * 把应用的 `UI_CONFIG` 写成页面级的 CSS 变量.
 *
 * 界面样式(代码字体/KaTeX 字号/面板几何)不做运行时设置界面,也不落
 * localStorage:唯一真相源是 `src/config/uiConfig.ts`,这里只负责把配置翻译成
 * CSS 变量,其余交给 `css/editor.css`,`css/panels.css`,库的 `styles/widgets.css`
 * 与 `css/base.css` 的 `var()`.
 *
 * 为什么这个文件在应用侧不在库里(docs/ui-library-extraction-plan.md D4):
 * "代码字号是 16px"是本应用的配置,不是 UI 库的通用常量.库只提供
 * `applyTheme(root, tokens)` 这个写入口,值由应用算.
 *
 * 调用时机:`src/main.ts` 在 `new DslApp()` **之前**调用.原因是
 * `EditorLineNumbers` 构造时会按最终字体度量行号宽度,晚一步就会量到兜底字体
 * (计划附录 C1).
 */
import { applyTheme, type ThemeTokens } from 'miko_ui';
import { UI_CONFIG } from '@/config/uiConfig';

/**
 * 配置值 -> CSS 变量名.
 *
 * 变量名就是 TS 与 CSS 之间的契约,单独抽成纯函数便于单测
 * (改名字时测试会先失败,而不是页面悄悄少一条样式).
 */
export function uiConfigCssVariables(): ThemeTokens {
    return {
        // 编辑器:消费者是 css/editor.css.
        '--code-font-family': UI_CONFIG.editor.fontFamily,
        '--code-font-size': `${UI_CONFIG.editor.fontSize}px`,
        '--code-line-height': String(UI_CONFIG.editor.lineHeight),
        '--code-tab-size': String(UI_CONFIG.editor.tabSize),
        // 公式字号:库的 `.ui-formula > .katex` 读它(见 uiConfig.formula).
        // 应用侧没有 `.katex` 选择器了,这里是**唯一**的写入点 -- 删掉它公式会
        // 静默落到库默认的 1.21em,所以守卫钉住这一处.
        '--katex-font-size': `${UI_CONFIG.formula.katexFontSize}em`,
        '--code-gutter-width': `${UI_CONFIG.editor.gutterMinWidth}px`,

        // 面板内容的最小高度:窗口再矮,这两块也保留下限并自己出滚动条.
        '--params-panel-min-height': `${UI_CONFIG.panel.paramsMinHeight}px`,
        '--view-controls-min-height': `${UI_CONFIG.panel.viewControlsMinHeight}px`,

        // 窗口外壳的两个样式常量(窗口几何本身不进 CSS,见 uiConfig.window 的说明):
        // - 标题栏高度:`.window-header` 消费它,夹取 `headerMinVisible` 与它同源;
        // - Dock 预留高度:`.window.is-maximized` 的 `bottom` 消费它,否则最大化会
        //   盖住 Dock.
        '--window-header-height': `${UI_CONFIG.window.headerHeight}px`,
        '--dock-reserve': `${UI_CONFIG.window.dockReserve}px`,
    };
}

/** 把配置写到根元素上;默认写 `document.documentElement`(应用侧的默认值). */
export function applyUiConfig(root: HTMLElement = document.documentElement): void {
    applyTheme(root, uiConfigCssVariables());
}
