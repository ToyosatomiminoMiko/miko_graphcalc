import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { KIND_PALETTE, kindVariable, type KindPaletteKey } from '@/config/kindPalette';

/**
 * 配色纪律:通用色板在库,领域图例**注册在 TS**.
 *
 * ```text
 *   库的通用色板   miko_ui/styles/tokens.css        --color-*   背景/文字/描边/状态/滚动条/语法高亮
 *   应用的领域图例 src/config/kindPalette.ts  ──┐
 *                                              └─ applyKindPalette() ─▶ :root 的 --kind-*
 * ```
 *
 * **为什么领域图例注册在 TS 而不是写成 CSS 变量**:键的取值来自领域
 * (`SceneObject['kind']`,分析的 op),不是"这个应用看起来什么样";注册表放在 TS
 * 里,键与 CSS 引用才能**互相覆盖地**被机器检查(下面第 4/5 条),而 CSS 侧因此
 * 一个颜色字面量都不需要(第 3 条).理由详见 `src/config/kindPalette.ts` 的文件头.
 *
 * 六条纪律:
 * 1. 库的通用色板确实在库的 tokens.css 里(而不是又被搬回应用);
 * 2. 库里**没有**领域图例(库不认识"旋转体/区域"这类概念) -- 这条就是反耦合本身;
 * 3. 应用的样式表里没有颜色字面量(领域色一律注册进 TS 的注册表);
 * 4. CSS 引用的每个 `--kind-*` 都在注册表里(漏配色的表现是测试红,不是徽章没底色);
 * 5. 注册表里每一项都被 CSS 引用(没有死条目);
 * 6. 注册表里同一个颜色字面量只出现一次(同值写别名 `var(--color-*)`),且库的
 *    色板里没有没人引用的 token.
 *
 * 库自己那半(库内字面量只在 tokens.css 一处,别名指向真实 token)在**库仓库**
 * 的 `src/theme/cssPalette.test.ts`(那是库自己的源码路径,不是包路径,不能 import).
 */

/** 应用自己的样式表(库的不在此列). */
const APP_CSS = [
    'base.css',
    'panels.css',
    'editor.css',
    'process.css',
] as const;

/** 库的样式表:按**包路径**解析,遵循 exports 映射. */
const LIB_CSS = [
    'miko_ui/styles/tokens.css',
    'miko_ui/styles/scrollbar.css',
    'miko_ui/styles/widgets.css',
    'miko_ui/styles/desktop.css',
    'miko_ui/styles/editor.css',
    'miko_ui/styles/feedback.css',
] as const;

const require = createRequire(import.meta.url);
const resolveLib = (specifier: string): string => require.resolve(specifier);

function readApp(name: string): string {
    return readFileSync(new URL(`../../css/${name}`, import.meta.url), 'utf8');
}

function readLib(specifier: string): string {
    return readFileSync(resolveLib(specifier), 'utf8');
}

/** 颜色字面量:十六进制或 rgb()/rgba() */
const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g;

function stripComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 一个 `:root` 声明体里定义的全部变量名. */
function declaredTokens(block: string): string[] {
    return [...block.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]);
}

/** 整份应用样式表(注释已去掉),用来查 `--kind-*` 的引用. */
const APP_CSS_TEXT = APP_CSS.map((name) => stripComments(readApp(name))).join('\n');

/** CSS 里 `var(--kind-<后缀>)` 引用到的全部后缀. */
function referencedKindKeys(): Set<string> {
    return new Set(
        [...APP_CSS_TEXT.matchAll(/var\(\s*--kind-([\w-]+)/g)].map((match) => match[1]),
    );
}

describe('配色纪律(通用色板在库,领域图例注册在 TS)', () => {
    const libTokens = stripComments(readLib('miko_ui/styles/tokens.css'));
    const libBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(libTokens)?.[1] ?? '';
    const libDefined = new Set(declaredTokens(libBlock));

    const registered = new Set(Object.keys(KIND_PALETTE));
    const referenced = referencedKindKeys();

    it('库的通用色板确实在库里(而不是又被搬回应用)', () => {
        expect(libDefined.has('--color-bg-panel')).toBe(true);
        expect(libDefined.has('--color-accent')).toBe(true);
    });

    it('库里没有领域图例(库不认识"旋转体/区域"这类概念)', () => {
        const leaked = [...libDefined].filter((token) => token.startsWith('--kind-'));
        expect(
            leaked,
            `这些领域 token 又跑回库里了: ${leaked.join(', ')}.`
            + '它们该注册在 src/config/kindPalette.ts 里',
        ).toEqual([]);
    });

    it('应用的样式表里没有颜色字面量(领域色一律注册进 TS)', () => {
        for (const name of APP_CSS) {
            const found = [...stripComments(readApp(name)).matchAll(COLOR)].map((match) => match[0]);

            expect(
                found,
                `css/${name} 里还有硬编码颜色,注册进 src/config/kindPalette.ts 或改用 var(--...)`,
            ).toEqual([]);
        }
    });

    it('CSS 引用的每个 --kind-* 都在注册表里', () => {
        const missing = [...referenced].filter((key) => !registered.has(key));

        expect(
            missing,
            `这些图例没有注册: ${missing.join(', ')}.新增一类对象时,配色要在`
            + ' src/config/kindPalette.ts 里补一项',
        ).toEqual([]);
    });

    it('注册表里每一项都被 CSS 引用(没有死条目)', () => {
        const dead = [...registered].filter((key) => !referenced.has(key));

        expect(dead, `注册了但没有任何 CSS 引用: ${dead.join(', ')}`).toEqual([]);
    });

    it('注册表里同一个颜色字面量只出现一次(同值应写别名)', () => {
        const byValue = new Map<string, string[]>();
        for (const [key, value] of Object.entries(KIND_PALETTE)) {
            // 别名(var(--color-*))不算字面量:它的唯一性由库的色板负责.
            if (value.startsWith('var(')) continue;
            const bucket = byValue.get(value.toLowerCase()) ?? [];
            bucket.push(key);
            byValue.set(value.toLowerCase(), bucket);
        }
        const duplicated = [...byValue.entries()]
            .filter(([, keys]) => keys.length > 1)
            .map(([value, keys]) => `${value} (= ${keys.join(', ')})`);

        expect(
            duplicated,
            '同一个颜色值注册了多次;同值应当写别名,如 var(--color-accent)',
        ).toEqual([]);
    });

    it('应用引用的 --color-* 都在库的 tokens.css 里', () => {
        const missing = new Set<string>();

        for (const match of APP_CSS_TEXT.matchAll(/var\(\s*(--color-[\w-]+)/g)) {
            if (!libDefined.has(match[1])) missing.add(match[1]);
        }

        expect([...missing], '这些变量在库的色板里没有定义,检查拼写').toEqual([]);
    });

    it('库的色板里没有没人引用的 token(应用的 CSS 与注册表一起算)', () => {
        const all = [
            APP_CSS_TEXT,
            ...LIB_CSS.map((specifier) => stripComments(readLib(specifier))),
            // 注册表的值里也会引用库的 token(如 var(--color-accent)),
            // 只算 CSS 会把这些误判成死 token.
            Object.values(KIND_PALETTE).join('\n'),
        ].join('\n');
        const unused = [...libDefined].filter(
            (token) => !new RegExp(`var\\(\\s*${token}[\\s,)]`).test(all),
        );

        expect(unused, `这些 token 没有任何消费者: ${unused.join(', ')}`).toEqual([]);
    });

    it('注册表生成的变量名就是 CSS 里写的那个(键改名字要能被发现)', () => {
        const keys = Object.keys(KIND_PALETTE) as KindPaletteKey[];
        const expected = keys.map(kindVariable).sort();
        const actual = [...referenced].map((key) => `--kind-${key}`).sort();

        expect(actual).toEqual(expected);
    });
});
