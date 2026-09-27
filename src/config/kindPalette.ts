/**
 * 领域类型图例色板(**注册表**).
 *
 * 一行列表里"这是哪一类东西"要靠色相区分,所以"对象类型 -> 颜色"这份映射需要
 * 一个真相源.它**注册在 TS 里**,不写成 CSS 里的 `:root` 变量,三条理由:
 *
 * 1. **键是领域数据,不是样式表数据**.键的取值来自领域(`SceneObject['kind']`
 *    与分析的 op:gradient/divergence/curl/laplacian...),不是"这个应用看起来
 *    什么样".TS 是它天然的住处;
 * 2. **缺一项要能被机器拦住**.`KIND_PALETTE` 的键与 `css/panels.css` 里
 *    `var(--kind-*)` 的引用必须**互相覆盖**(两个方向都查,见
 *    `src/config/cssPalette.test.ts`):新增一类对象却忘了配色,表现是测试红,
 *    而不是"徽章悄悄没有底色";
 * 3. **CSS 里因此一个颜色字面量都没有**.`css/*.css` 只写 `var(--kind-*)`,
 *    字面量集中在这一张表里 -- 与库的 `tokens.css` 是同一种纪律,只是这份表
 *    归应用.
 *
 * 写入口是 `src/app/applyKindPalette.ts`(与 `UI_CONFIG` -> `applyUiConfig()`
 * 同一条机制:真相源在 TS,由库的 `applyTheme()` 翻译成 `:root` 上的变量).
 * 调用时机见 `src/main.ts`:必须在建任何 DOM 之前.
 *
 * 键是**变量后缀**,不是类名:`.kind-vector_field` 与 `.kind-vector` 共用
 * `--kind-vector` 一个变量(两者本来就是同一个色),那条类名映射归 CSS.
 */
import type { ThemeTokens } from 'miko_ui';

/**
 * 图例变量后缀 -> 颜色值.
 *
 * 值可以引用库的通用 token(`var(--color-*)`)-- 与通用色板同色的项不写第二遍
 * 字面量,和库的 `tokens.css` 里"同值写别名"是同一条约定.
 */
export const KIND_PALETTE = {
    curve: 'var(--color-accent)',
    surface: '#ff6b8a',
    vector: '#b49cff',
    point: 'var(--color-warning)',
    sphere: '#7ee0c8',
    box: '#ff9f6b',
    conic: '#d08cff',
    region: '#a9e07b',
    implicit: '#9fb3ff',
    integral: 'var(--color-success)',
    intersection: '#ffd93d',
    solve: '#7fd8ff',
    antiderivative: '#ffb3d9',
    ode: '#b8f0a0',
    'divergence-bg': 'rgba(142, 230, 165, 0.16)',
    'curl-bg': 'rgba(255, 194, 109, 0.18)',
    'laplacian-bg': 'rgba(196, 168, 255, 0.20)',
} as const;

/** 注册表里的一项的键(变量后缀). */
export type KindPaletteKey = keyof typeof KIND_PALETTE;

/** 注册表某一项对应的 CSS 变量名. */
export function kindVariable(key: KindPaletteKey): string {
    return `--kind-${key}`;
}

/**
 * 整张注册表翻成 `applyTheme()` 要的 token 表.
 *
 * 变量名一律由 {@link kindVariable} 生成,调用方不手写 `--kind-*` 字符串 --
 * 否则"注册表改了键名,CSS 没跟上"这种事会没有编译错误.
 */
export function kindPaletteTokens(): ThemeTokens {
    const tokens: Record<string, string> = {};
    for (const key of Object.keys(KIND_PALETTE) as KindPaletteKey[]) {
        tokens[kindVariable(key)] = KIND_PALETTE[key];
    }
    return tokens;
}
