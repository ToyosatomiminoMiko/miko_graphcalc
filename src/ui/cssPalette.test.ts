import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 界面配色的**单一来源**契约.
 *
 * 约定写在 `css/base.css` 的"主题色板"注释里,这里把它变成会失败的断言:
 * 1. 颜色字面量只在 `base.css` 的 `:root` 里出现一次,同一个**值**不允许有
 *    第二处定义(改色只开一个文件);
 * 2. 其余 css 文件一律 `var(--...)`,不再出现 `#rrggbb` / `rgba(...)`;
 * 3. 语境不同但同值的写成别名(`--x: var(--y)`),别名也要指向真实存在的 token.
 *
 * 这三条靠注释守不住:新写一条硬编码色值,拼错变量名,或者留下一个没人引用的
 * token,都会先失败在这里(与 editorStyles.test.ts 同一思路).
 *
 * 注意本测试只覆盖 `css/*.css`.PWA 的 theme_color 是另一条链路
 * (index.html 的 meta 与 vite.config.ts 的 manifest),不在色板管辖范围内.
 */

const CSS_FILES = [
    'base.css',
    'layout.css',
    'panels.css',
    'editor.css',
    'controls.css',
    'diagnostics.css',
] as const;

/** 颜色字面量:十六进制或 rgb()/rgba() */
const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g;

function read(name: string): string {
    return readFileSync(new URL(`../../css/${name}`, import.meta.url), 'utf8');
}

function stripComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** `base.css` 里 `:root` 的声明体(注释已去掉). */
function rootBlock(css: string): string {
    const match = /:root\s*\{([\s\S]*?)\n\}/.exec(stripComments(css));
    if (!match) throw new Error('base.css 里找不到 :root 变量块');
    return match[1];
}

/** `:root` 里定义的全部变量名,按出现顺序. */
function definedTokens(block: string): string[] {
    return [...block.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]);
}

/**
 * 把颜色字面量规范化成 `rgb(r,g,b,a)`.
 *
 * `#0d1120` / `#fff` / `rgba(109, 213, 255, 0.6)` / `rgba(109,213,255,0.60)`
 * 都能落到同一种写法上,这样"同值只能有一处定义"判的是**颜色值**而不是字符串
 * (小数位数的写法差异不该算两个颜色).
 */
function canonical(literal: string): string {
    const rgba = /^rgba?\(([^)]*)\)$/.exec(literal);
    if (rgba) {
        const [r, g, b, a = 1] = rgba[1].split(',').map((part) => Number(part.trim()));
        return `rgb(${r},${g},${b},${a.toFixed(4)})`;
    }

    let hex = literal.slice(1);
    if (hex.length === 3) hex = [...hex].map((char) => char + char).join('');
    const channel = (index: number): number => parseInt(hex.slice(index, index + 2), 16);
    const alpha = hex.length === 8 ? channel(6) / 255 : 1;
    return `rgb(${channel(0)},${channel(2)},${channel(4)},${alpha.toFixed(4)})`;
}

describe('界面配色单一来源', () => {
    const base = read('base.css');
    const block = rootBlock(base);
    const tokens = definedTokens(block);

    it('色板存在,且每个颜色值只定义一次', () => {
        expect(tokens).toContain('--color-bg-panel');
        expect(tokens).toContain('--color-accent');

        const values = [...block.matchAll(COLOR)].map((match) => canonical(match[0]));
        const duplicated = [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];

        // 同一个值出现两次,就应该有一处改成别名 var(--...)
        expect(duplicated, `同一个颜色值被定义了多次: ${duplicated.join(', ')}`).toEqual([]);
    });

    it('除 base.css 的 :root 外,任何 css 文件都不再有颜色字面量', () => {
        for (const name of CSS_FILES) {
            const css =
                name === 'base.css'
                    ? stripComments(base).replace(block, '')
                    : stripComments(read(name));
            const found = [...css.matchAll(COLOR)].map((match) => match[0]);

            expect(
                found,
                `${name} 里还有硬编码颜色,请改成 var(--...) 并在 base.css 色板里定义`,
            ).toEqual([]);
        }
    });

    it('引用的色板变量都有定义(拼错会在这里失败)', () => {
        const defined = new Set(tokens);
        const missing = new Set<string>();

        for (const name of CSS_FILES) {
            const references = stripComments(read(name)).matchAll(
                /var\(\s*(--(?:color|kind)-[\w-]+)/g,
            );
            for (const match of references) {
                if (!defined.has(match[1])) missing.add(match[1]);
            }
        }

        expect([...missing], '这些变量没有定义,检查拼写或补进 base.css 色板').toEqual([]);
    });

    it('色板里没有没人引用的 token', () => {
        const all = CSS_FILES.map((name) => stripComments(read(name))).join('\n');
        const unused = tokens.filter(
            (token) => !new RegExp(`var\\(\\s*${token}[\\s,)]`).test(all),
        );

        // 死 token 会让下一个人以为改了它就能改样式,所以一并清掉
        expect(unused, `这些 token 没有任何消费者: ${unused.join(', ')}`).toEqual([]);
    });

    it('别名只指向色板里已有的 token', () => {
        const defined = new Set(tokens);
        const aliases = [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)];

        for (const [, name, value] of aliases) {
            for (const match of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
                expect(defined.has(match[1]), `${name} 指向了不存在的 ${match[1]}`).toBe(true);
            }
        }
    });
});
