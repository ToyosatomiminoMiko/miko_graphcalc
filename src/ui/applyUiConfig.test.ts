import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UI_CONFIG } from '../config/uiConfig';
import { applyUiConfig, uiConfigCssVariables } from './applyUiConfig';

/**
 * 解析 css/base.css 里 `:root {...}` 的 CSS 变量声明.
 *
 * 只支持"扁平的 变量名: 值"块(base.css 的 :root 正是如此);目的是把
 * "兜底值必须与 UI_CONFIG 一致"这条注释变成一条会失败的断言(UI-P3.14).
 */
function readRootCssVariables(css: string): Record<string, string> {
    const block = /:root\s*\{([\s\S]*?)\}/.exec(css);
    if (!block) throw new Error('base.css 里找不到 :root 变量块');
    const variables: Record<string, string> = {};
    for (const declaration of block[1].split(';')) {
        const match = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(declaration);
        if (match) variables[match[1]] = match[2];
    }
    return variables;
}

describe('uiConfigCssVariables', () => {
    it('把 UI_CONFIG 映射到约定好的 CSS 变量名', () => {
        const variables = uiConfigCssVariables();

        expect(variables['--code-font-family']).toBe(UI_CONFIG.editor.fontFamily);
        expect(variables['--code-font-size']).toBe(`${UI_CONFIG.editor.fontSize}px`);
        expect(variables['--code-line-height']).toBe(String(UI_CONFIG.editor.lineHeight));
        expect(variables['--code-tab-size']).toBe(String(UI_CONFIG.editor.tabSize));
        expect(variables['--katex-font-size']).toBe(
            `${UI_CONFIG.formula.katexFontSize}em`,
        );
    });

    it('只产生这五个变量,不夹带空值', () => {
        const variables = uiConfigCssVariables();

        expect(Object.keys(variables)).toHaveLength(5);
        for (const value of Object.values(variables)) {
            expect(typeof value).toBe('string');
            expect(value.length).toBeGreaterThan(0);
        }
    });
});

describe('UI_CONFIG', () => {
    it('字号与行高都是可用的正数', () => {
        expect(UI_CONFIG.editor.fontSize).toBeGreaterThan(0);
        expect(UI_CONFIG.editor.lineHeight).toBeGreaterThan(0);
        expect(UI_CONFIG.editor.tabSize).toBeGreaterThan(0);
        expect(UI_CONFIG.formula.katexFontSize).toBeGreaterThan(0);
    });
});

describe('applyUiConfig', () => {
    it('把变量写到传入的根元素上(用 stub 避免依赖 DOM 环境)', () => {
        const written = new Map<string, string>();
        const root = {
            style: {
                setProperty: (name: string, value: string): void => {
                    written.set(name, value);
                },
            },
        } as unknown as HTMLElement;

        applyUiConfig(root);

        expect(written.size).toBe(5);
        expect(written.get('--code-font-size')).toBe(`${UI_CONFIG.editor.fontSize}px`);
    });
});

describe('base.css 的 :root 兜底(UI-P3.14)', () => {
    it('五个变量与 UI_CONFIG 映射出的值逐字一致', () => {
        const css = readFileSync(
            new URL('../../css/base.css', import.meta.url),
            'utf8',
        );
        const fallbacks = readRootCssVariables(css);

        // 兜底只负责脚本执行前的首帧;值不一致就会闪一下旧字号/旧行高.
        expect(fallbacks).toMatchObject(uiConfigCssVariables());
    });
});
