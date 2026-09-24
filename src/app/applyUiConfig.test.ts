import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { UI_CONFIG } from '@/config/uiConfig';
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
        expect(variables['--params-panel-min-height']).toBe(
            `${UI_CONFIG.panel.paramsMinHeight}px`,
        );
        expect(variables['--view-controls-min-height']).toBe(
            `${UI_CONFIG.panel.viewControlsMinHeight}px`,
        );
        // 窗口外壳的两个样式常量(CSS 自己要读;窗口几何本身不进 CSS).
        expect(variables['--window-header-height']).toBe(
            `${UI_CONFIG.window.headerHeight}px`,
        );
        expect(variables['--dock-reserve']).toBe(
            `${UI_CONFIG.window.dockReserve}px`,
        );
    });

    it('窗口几何与视图控件参数都不进 CSS:它们只被 TS 当数字用', () => {
        const variables = uiConfigCssVariables();

        // 窗口几何的真相源是 UI_CONFIG.window + WindowGeometry,由 WindowManager
        // 写成行内样式;CSS 里没有 --window-* 的几何副本(只有标题栏高度与
        // Dock 预留这两个样式常量).
        for (const name of Object.keys(variables)) {
            expect(name).not.toMatch(/--window-\d/);
        }
        expect(Object.keys(variables)).not.toContain('--window-width');
        expect(Object.keys(variables)).not.toContain('--window-left');
        // UI_CONFIG.view 整段同理(控件的 min/step 与 ViewCube 选项清单);
        // "没有多出变量"由下面那条计数断言兜底.
        expect(Object.keys(variables).filter((name) => name.includes('segmented')))
            .toEqual([]);
    });

    it('整张映射表都是非空字符串(条数固定:新增变量必须同步 base.css 兜底)', () => {
        const variables = uiConfigCssVariables();

        expect(Object.keys(variables)).toHaveLength(10);
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

    it('面板内容下限为正数(窗口几何已经归 UI_CONFIG.window)', () => {
        expect(UI_CONFIG.panel.paramsMinHeight).toBeGreaterThan(0);
        expect(UI_CONFIG.panel.viewControlsMinHeight).toBeGreaterThan(0);
    });

    it('视图控件参数自洽:步长为正,下限非负且小刻度不比大刻度粗', () => {
        const view = UI_CONFIG.view;

        expect(view.point.min).toBeGreaterThanOrEqual(0);
        expect(view.point.sizeStep).toBeGreaterThan(0);
        expect(view.point.scaleStep).toBeGreaterThan(0);

        expect(view.axis.lineWidthMin).toBeGreaterThan(0);
        expect(view.axis.lineWidthStep).toBeGreaterThan(0);
        expect(view.axis.gridMajorMin).toBeGreaterThan(0);
        expect(view.axis.gridMajorStep).toBeGreaterThan(0);
        expect(view.axis.gridMinorMin).toBeGreaterThan(0);
        expect(view.axis.gridMinorStep).toBeGreaterThan(0);
        expect(view.axis.gridMinorMin).toBeLessThanOrEqual(view.axis.gridMajorMin);
        expect(view.axis.gridMinorStep).toBeLessThanOrEqual(view.axis.gridMajorStep);

        // ViewCube 的选项要唯一,否则同名按钮会有两个高亮/两个都点不动
        const values: string[] = view.viewCube.map((item) => item.value);
        expect(new Set(values).size).toBe(values.length);
        for (const item of view.viewCube) {
            expect(item.label.length).toBeGreaterThan(0);
        }
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

        expect(written.size).toBe(10);
        expect(written.get('--code-font-size')).toBe(`${UI_CONFIG.editor.fontSize}px`);
        expect(written.get('--dock-reserve')).toBe(`${UI_CONFIG.window.dockReserve}px`);
    });
});

describe('token 层的默认值(P4/D8 之后在库里)', () => {
    it('每个默认值都与 UI_CONFIG 映射出的值逐字一致', () => {
        // 默认值层随库走(miko_ui/styles/tokens.css):它就是"脚本执行前的首帧".
        // 值不一致就会闪一下旧字号/旧面板宽度,所以两边必须逐字相同.
        // 这条断言也覆盖"新加变量忘了写默认值":漏掉时 toMatchObject 直接失败.
        const css = readFileSync(
            createRequire(import.meta.url).resolve('miko_ui/styles/tokens.css'),
            'utf8',
        );
        const fallbacks = readRootCssVariables(css);

        expect(fallbacks).toMatchObject(uiConfigCssVariables());
    });

    it('#app 上不再有面板几何的派生变量(几何归窗口系统)', () => {
        const css = readFileSync(
            new URL('../../css/base.css', import.meta.url),
            'utf8',
        );
        const appBlock = /#app\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';

        expect(appBlock).not.toContain('--left-panel-width');
        expect(appBlock).not.toContain('--right-panel-width');
        expect(appBlock).not.toContain('--footer-height');
    });
});
