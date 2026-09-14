import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UI_CONFIG } from '../config/uiConfig';
import { applyUiConfig, uiConfigCssVariables } from './applyUiConfig';

/**
 * 解析 css/base.css 里 `:root {...}` 的 CSS 变量声明.
 *
 * 只支持"扁平的 变量名: 值"块(base.css 的 :root 正是如此);先把注释整段
 * 去掉,否则紧跟在注释后面的声明会因为前缀匹配不上而被静默漏掉.
 * 目的是把"兜底值必须与 UI_CONFIG 一致"这条注释变成一条会失败的断言
 * (UI-P3.14).
 */
function readRootCssVariables(css: string): Record<string, string> {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const block = /:root\s*\{([\s\S]*?)\}/.exec(withoutComments);
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
        expect(variables['--code-gutter-width']).toBe(
            `${UI_CONFIG.editor.gutterMinWidth}px`,
        );
        expect(variables['--side-default-width']).toBe(
            `${UI_CONFIG.panel.sideDefaultWidth}px`,
        );
        expect(variables['--footer-default-height']).toBe(
            `${UI_CONFIG.panel.footerDefaultHeight}px`,
        );
        expect(variables['--collapsed-side-width']).toBe(
            `${UI_CONFIG.panel.collapsedSideWidth}px`,
        );
        expect(variables['--collapsed-footer-height']).toBe(
            `${UI_CONFIG.panel.collapsedFooterHeight}px`,
        );
        expect(variables['--right-split-basis']).toBe(
            `${UI_CONFIG.panel.splitDefaultRatio * 100}%`,
        );
        expect(variables['--params-panel-min-height']).toBe(
            `${UI_CONFIG.panel.paramsMinHeight}px`,
        );
        expect(variables['--view-controls-min-height']).toBe(
            `${UI_CONFIG.panel.viewControlsMinHeight}px`,
        );
    });

    it('拖拽夹取上下限不进 CSS:它们只被控制器当数字用', () => {
        const variables = uiConfigCssVariables();

        // 上限只活在 UI_CONFIG.panel 里,CSS 没有同名变量也就没有第二处副本.
        expect(Object.keys(variables)).not.toContain('--side-max-width');
        expect(Object.keys(variables)).not.toContain('--side-min-width');
        expect(Object.keys(variables)).not.toContain('--footer-max-height');
        expect(Object.keys(variables)).not.toContain('--footer-min-height');
        expect(Object.keys(variables)).not.toContain('--right-split-min');
        expect(Object.keys(variables)).not.toContain('--right-split-max');
    });

    it('整张映射表都是非空字符串', () => {
        const variables = uiConfigCssVariables();

        expect(Object.keys(variables)).toHaveLength(13);
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
        expect(UI_CONFIG.editor.gutterMinWidth).toBeGreaterThan(0);
        expect(UI_CONFIG.formula.katexFontSize).toBeGreaterThan(0);
    });

    it('面板尺寸自洽:上下限夹得住默认值', () => {
        const panel = UI_CONFIG.panel;

        expect(panel.sideMinWidth).toBeLessThanOrEqual(panel.sideDefaultWidth);
        expect(panel.sideDefaultWidth).toBeLessThanOrEqual(panel.sideMaxWidth);
        expect(panel.footerMinHeight).toBeLessThanOrEqual(panel.footerDefaultHeight);
        expect(panel.footerDefaultHeight).toBeLessThanOrEqual(panel.footerMaxHeight);
        expect(panel.collapsedSideWidth).toBeLessThan(panel.sideMinWidth);
        expect(panel.collapsedFooterHeight).toBeLessThan(panel.footerMinHeight);
        expect(panel.splitMinRatio).toBeGreaterThan(0);
        expect(panel.splitMinRatio).toBeLessThanOrEqual(panel.splitDefaultRatio);
        expect(panel.splitDefaultRatio).toBeLessThanOrEqual(panel.splitMaxRatio);
        expect(panel.splitMaxRatio).toBeLessThan(1);
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

        expect(written.size).toBe(13);
        expect(written.get('--code-font-size')).toBe(`${UI_CONFIG.editor.fontSize}px`);
        expect(written.get('--side-default-width')).toBe(
            `${UI_CONFIG.panel.sideDefaultWidth}px`,
        );
    });
});

describe('base.css 的 :root 兜底(UI-P3.14)', () => {
    it('每个变量的兜底值都与 UI_CONFIG 映射出的值逐字一致', () => {
        const css = readFileSync(
            new URL('../../css/base.css', import.meta.url),
            'utf8',
        );
        const fallbacks = readRootCssVariables(css);

        // 兜底只负责脚本执行前的首帧;值不一致就会闪一下旧字号/旧面板宽度.
        // 这条断言也覆盖"新加变量忘了写兜底":漏掉时 toMatchObject 直接失败.
        expect(fallbacks).toMatchObject(uiConfigCssVariables());
    });

    it('派生变量只引用 :root 数字,不重复写一遍同样的数', () => {
        const css = readFileSync(
            new URL('../../css/base.css', import.meta.url),
            'utf8',
        );
        const appBlock = /#app\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';

        expect(appBlock).toMatch(/--left-panel-width:\s*var\(--side-default-width\)/);
        expect(appBlock).toMatch(/--right-panel-width:\s*var\(--side-default-width\)/);
        expect(appBlock).toMatch(/--footer-height:\s*var\(--footer-default-height\)/);
    });
});
