import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * 应用侧的配色纪律.
 *
 * 色板的**真相源**已经随 UI 库走(`miko_ui/styles/tokens.css`,P4/D8).应用这边
 * 要守的是三条"消费者纪律":
 * 1. 应用的样式表里不出现颜色字面量 -- 想加色就加进库的色板(或先想清楚
 *    它是不是该由主题覆盖);
 * 2. 应用引用的每个色板变量(`--color-...` 与 `--kind-...`)都能在库的
 *    tokens.css 里找到;
 * 3. 色板里没有**没人引用**的 token(库的 CSS + 应用的 CSS 一起算) -- 死 token
 *    会让下一个人以为改了它就能改样式.
 *
 * 库自己那半(字面量只有一处,别名指向真实 token)在
 * `miko_ui/src/theme/cssPalette.test.ts`.
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

describe('应用配色纪律(P4/D8 之后:色板在库里)', () => {
    const tokensCss = stripComments(readLib('miko_ui/styles/tokens.css'));
    const block = /:root\s*\{([\s\S]*?)\n\}/.exec(tokensCss)?.[1] ?? '';
    const defined = new Set(
        [...block.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]),
    );

    it('色板确实在库里(而不是又被搬回应用)', () => {
        expect(defined.has('--color-bg-panel')).toBe(true);
        expect(defined.has('--color-accent')).toBe(true);
    });

    it('应用的样式表里没有颜色字面量', () => {
        for (const name of APP_CSS) {
            const found = [...stripComments(readApp(name)).matchAll(COLOR)].map((match) => match[0]);

            expect(
                found,
                `css/${name} 里还有硬编码颜色,请改成 var(--...) 并在库的 tokens.css 里定义`,
            ).toEqual([]);
        }
    });

    it('应用引用的色板变量都在库的 tokens.css 里有定义', () => {
        const missing = new Set<string>();

        for (const name of APP_CSS) {
            const references = stripComments(readApp(name)).matchAll(
                /var\(\s*(--(?:color|kind)-[\w-]+)/g,
            );
            for (const match of references) {
                if (!defined.has(match[1])) missing.add(match[1]);
            }
        }

        expect([...missing], '这些变量没有定义,检查拼写或补进库的 tokens.css').toEqual([]);
    });

    it('色板里没有没人引用的 token(库 + 应用一起算)', () => {
        const all = [
            ...APP_CSS.map((name) => stripComments(readApp(name))),
            ...LIB_CSS.map((specifier) => stripComments(readLib(specifier))),
        ].join('\n');
        const unused = [...defined].filter(
            (token) => !new RegExp(`var\\(\\s*${token}[\\s,)]`).test(all),
        );

        expect(unused, `这些 token 没有任何消费者: ${unused.join(', ')}`).toEqual([]);
    });
});
