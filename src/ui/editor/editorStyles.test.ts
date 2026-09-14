import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 编辑区样式的**文件归属**契约.
 *
 * 源码编辑区的几何(外框/行号槽/textarea 与高亮层的重叠)与词法配色集中在
 * `css/editor.css`,其余面板样式留在 `css/panels.css`.这个划分是"改编辑器只开
 * 一个文件"的前提,靠注释守不住:一旦有人把 `#dsl-editor*` 规则挪回 panels.css,
 * 或者新增样式忘了在 index.html 挂载 editor.css,这里会直接失败
 * (与 applyUiConfig.test.ts 解析 base.css 的思路一致).
 */
function read(relative: string): string {
    return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('编辑区样式归属', () => {
    const editorCss = read('../../../css/editor.css');
    const panelsCss = read('../../../css/panels.css');
    const html = read('../../../index.html');

    it('编辑器的结构选择器都在 editor.css', () => {
        for (const selector of [
            '#editor-panel',
            '#dsl-editor-box',
            '#dsl-editor-input',
            '#dsl-editor-highlight',
            '#dsl-editor-highlight-code',
            '#dsl-editor-gutter',
            '#dsl-editor-lines',
            '#dsl-editor',
        ]) {
            expect(editorCss, `editor.css 缺少 ${selector}`).toContain(selector);
        }
    });

    it('词法配色随编辑器一起搬走', () => {
        expect(editorCss).toContain('.dsl-comment');
        expect(panelsCss).not.toContain('.dsl-comment');
    });

    it('panels.css 不再残留编辑器规则', () => {
        // `#dsl-editor` 后不能紧跟标识符字符,避免把 `#dsl-editorial` 之类的
        // 巧合算成命中;`#editor-panel` 同样不该出现.
        expect(panelsCss).not.toMatch(/#dsl-editor(?![\w-])/);
        expect(panelsCss).not.toContain('#editor-panel');
    });

    it('index.html 在 base.css 之后挂载 editor.css', () => {
        const base = html.indexOf('css/base.css');
        const editor = html.indexOf('css/editor.css');

        expect(base).toBeGreaterThanOrEqual(0);
        expect(editor).toBeGreaterThan(base);
    });

    it('高亮层是裁剪框而不是滚动容器', () => {
        // 滚动偏移写在高亮内容的 transform 上(见 EditorHighlight.sync);
        // 一旦这里变成 auto/scroll,高亮层就会与 textarea 各有一个最大滚动偏移
        // (两者 client 尺寸差一个滚动条厚度),靠近底部时高亮会被夹住而错位.
        const rule = /#dsl-editor-highlight\s*\{[^}]*\}/.exec(editorCss)?.[0] ?? '';

        expect(rule).toContain('overflow: hidden');
        expect(rule).not.toMatch(/overflow:\s*(auto|scroll)/);
    });
});
