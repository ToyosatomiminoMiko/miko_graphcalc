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

/** 取出某个选择器的声明体(选择器写法固定,不做通用 CSS 解析). */
function ruleOf(css: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
}

/** 声明体里某个属性的值(取不到返回 null,便于断言"两边都有"). */
function valueOf(body: string, property: string): string | null {
    const match = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`).exec(body);
    return match ? match[1].trim() : null;
}

describe('编辑区样式归属', () => {
    const editorCss = read('../../../css/editor.css');
    const panelsCss = read('../../../css/panels.css');
    const windowCss = read('../../../css/window.css');
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

    it('高亮层与 textarea 的对齐样式逐项相同(窗口化不许碰的五条轴之一)', () => {
        const textarea = ruleOf(editorCss, '#dsl-editor');
        const highlightCode = ruleOf(editorCss, '#dsl-editor-highlight-code');

        // 这两条当年是靠手工比对调出来的:字体/字号/行高/制表位/内边距任意一项
        // 不一致,着色文字就会与光标错开,越往右下越明显.
        for (const property of ['font-family', 'font-size', 'line-height', 'tab-size', 'padding']) {
            const editor = valueOf(textarea, property);
            const highlight = valueOf(highlightCode, property);
            expect(editor, `#dsl-editor 缺少 ${property}`).not.toBeNull();
            expect(highlight, `#dsl-editor-highlight-code 缺少 ${property}`).not.toBeNull();
            expect(highlight, `${property} 两侧不一致`).toBe(editor);
        }
    });

    it('高亮层的显隐挂在"紧邻的下一兄弟"这条选择器上', () => {
        // 高亮层必须紧跟 textarea:谁在中间插一个节点,整层就不显示(而不是错位).
        expect(editorCss).toContain('#dsl-editor.is-highlighted + #dsl-editor-highlight');
    });

    it('高亮层是 inset:0 的裁剪框而不是滚动容器', () => {
        const rule = ruleOf(editorCss, '#dsl-editor-highlight');

        expect(rule).toContain('inset: 0');
        expect(rule).toContain('overflow: hidden');
        expect(rule).not.toMatch(/overflow:\s*(auto|scroll)/);
    });

    it('index.html 里高亮层紧跟 textarea(相邻兄弟选择器依赖这个顺序)', () => {
        // 谁在两者之间插一个节点,高亮就整层不显示(而不是错位,所以更容易被
        // 误判成"功能没了").窗口化只改外层的挂载点,这条顺序不许动.
        const afterTextarea = html.slice(html.indexOf('</textarea>') + '</textarea>'.length);
        const withoutComments = afterTextarea.replace(/<!--[\s\S]*?-->/g, '').trimStart();

        expect(withoutComments.startsWith('<div id="dsl-editor-highlight"')).toBe(true);
    });

    it('窗口的隐藏态不含 display: none(隐藏期间必须量得到尺寸)', () => {
        // 编辑器行号与高亮层在隐藏期间若量到 0 宽/高,恢复后对齐会整体错乱,
        // 而且错误发生在"另一次交互之后",极难联想到是隐藏方式导致的.
        const hiddenRule = ruleOf(windowCss, '.window.is-hidden');

        expect(hiddenRule).not.toBe('');
        expect(hiddenRule).toContain('opacity: 0');
        expect(hiddenRule).not.toMatch(/display:\s*none/);
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
