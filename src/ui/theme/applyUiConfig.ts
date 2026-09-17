/**
 * 把 `UI_CONFIG` 写成页面级的 CSS 变量.
 *
 * 界面样式(代码字体/KaTeX 字号/面板几何)不做运行时设置界面,也不落
 * localStorage:唯一真相源是 `src/config/uiConfig.ts`,这里只负责把配置翻译成
 * CSS 变量,其余交给 `css/editor.css`,`css/panels.css`,`css/controls.css`
 * 与 `css/base.css` 的 `var()`.
 *
 * 调用时机:`src/main.ts` 在 `new DslApp()` **之前**调用.原因是
 * `EditorLineNumbers` 构造时会按最终字体度量行号宽度,晚一步就会量到兜底字体.
 */
import { UI_CONFIG } from '@/config/uiConfig';

/**
 * 配置值 -> CSS 变量名.
 *
 * 变量名就是 TS 与 CSS 之间的契约,单独抽成纯函数便于单测
 * (改名字时测试会先失败,而不是页面悄悄少一条样式).
 */
export function uiConfigCssVariables(): Record<string, string> {
    return {
        // 编辑器 / 公式:消费者是 css/editor.css 与 css/panels.css.
        '--code-font-family': UI_CONFIG.editor.fontFamily,
        '--code-font-size': `${UI_CONFIG.editor.fontSize}px`,
        '--code-line-height': String(UI_CONFIG.editor.lineHeight),
        '--code-tab-size': String(UI_CONFIG.editor.tabSize),
        '--katex-font-size': `${UI_CONFIG.formula.katexFontSize}em`,
        '--code-gutter-width': `${UI_CONFIG.editor.gutterMinWidth}px`,

        // 面板几何:这里只映射"CSS 首帧要消费"的那部分.拖拽的夹取上下限
        // (sideMin/MaxWidth 等)CSS 用不到,不进这张表,避免多出一份副本.
        // --side-default-width / --footer-default-height 由 base.css 的 #app
        // 派生成 --left/right-panel-width 与 --footer-height 的初值.
        '--side-default-width': `${UI_CONFIG.panel.sideDefaultWidth}px`,
        '--footer-default-height': `${UI_CONFIG.panel.footerDefaultHeight}px`,
        '--collapsed-side-width': `${UI_CONFIG.panel.collapsedSideWidth}px`,
        '--collapsed-footer-height': `${UI_CONFIG.panel.collapsedFooterHeight}px`,
        '--right-split-basis': `${UI_CONFIG.panel.splitDefaultRatio * 100}%`,
        '--params-panel-min-height': `${UI_CONFIG.panel.paramsMinHeight}px`,
        '--view-controls-min-height': `${UI_CONFIG.panel.viewControlsMinHeight}px`,
    };
}

/** 把配置写到根元素(`:root`)上;默认写入 document.documentElement. */
export function applyUiConfig(root: HTMLElement = document.documentElement): void {
    for (const [name, value] of Object.entries(uiConfigCssVariables())) {
        root.style.setProperty(name, value);
    }
}
