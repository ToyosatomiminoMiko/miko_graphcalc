/**
 * 把领域类型图例色板写进 `:root`.
 *
 * 与 `applyUiConfig()` **同一条机制**:真相源在 TS(这里是
 * `src/config/kindPalette.ts`),库只提供 `applyTheme()` 这个写入口,值由应用算.
 * 两个文件形状相同不是巧合,是同一约定了两次 -- `uiConfig.ts` 那边是"这个应用
 * 看起来什么样",这边是"这个领域的对象各是什么色".
 *
 * ## 为什么可以只由 JS 写(而不是像通用 token 那样在 CSS 里留默认值)
 *
 * 通用 token 有 CSS 兜底,是因为页面上可能有"脚本尚未执行"就已经存在的节点
 * (例如 `index.html` 里手写的宿主).**这个应用没有那种节点**:`index.html` 里
 * 只有一个空的 `<div id="app">`,全部内容节点与组件都由 JS 建(见
 * `src/app/appViews.ts` 与 `DslApp`).所以只要在 `new DslApp()` 之前写好变量,
 * 第一个徽章出现时变量就已经在 `:root` 上了,不存在"先无底色,后补色"的闪烁.
 *
 * 这条顺序与 `applyUiConfig()` 共享(见 `src/main.ts` 的注释):晚一步的后果,
 * 那边是量错行号槽宽,这边是徽章没有底色.
 */
import { applyTheme } from 'miko_ui';
import { kindPaletteTokens } from '@/config/kindPalette';

/** 把注册表写到根元素上;默认写 `document.documentElement`(应用侧的默认值). */
export function applyKindPalette(root: HTMLElement = document.documentElement): void {
    applyTheme(root, kindPaletteTokens());
}
