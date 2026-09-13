/**
 * 把 `UI_CONFIG` 写成页面级的 CSS 变量.
 *
 * 界面样式(代码字体/KaTeX 字号)不做运行时设置界面,也不落 localStorage:
 * 唯一真相源是 `src/config/uiConfig.ts`,这里只负责把配置翻译成 CSS 变量,
 * 其余交给 `css/panels.css` 的 `var()`.
 *
 * 调用时机:`src/main.ts` 在 `new DslApp()` **之前**调用.原因是
 * `EditorLineNumbers` 构造时会按最终字体度量行号宽度,晚一步就会量到兜底字体.
 */
import { UI_CONFIG } from '../config/uiConfig';

/**
 * 配置值 -> CSS 变量名.
 *
 * 变量名就是 TS 与 CSS 之间的契约,单独抽成纯函数便于单测
 * (改名字时测试会先失败,而不是页面悄悄少一条样式).
 */
export function uiConfigCssVariables(): Record<string, string> {
    return {
        '--code-font-family': UI_CONFIG.editor.fontFamily,
        '--code-font-size': `${UI_CONFIG.editor.fontSize}px`,
        '--code-line-height': String(UI_CONFIG.editor.lineHeight),
        '--code-tab-size': String(UI_CONFIG.editor.tabSize),
        '--katex-font-size': `${UI_CONFIG.formula.katexFontSize}em`,
    };
}

/** 把配置写到根元素(`:root`)上;默认写入 document.documentElement. */
export function applyUiConfig(root: HTMLElement = document.documentElement): void {
    for (const [name, value] of Object.entries(uiConfigCssVariables())) {
        root.style.setProperty(name, value);
    }
}
