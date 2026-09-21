import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildAppViews } from '@/app/appViews';
import { installDomStub, type StubElement } from '@/testing/domStub';

/**
 * 编辑区样式的**文件归属**契约.
 *
 * 编辑器样式分成两半(P4/D8 之后):
 * - **结构/对齐**(外框,行号槽,textarea 与高亮层的重叠)随库走
 *   (`@miko/ui/styles/editor.css`,选择器是 `.code-editor*` 类名);
 * - **DSL 词法配色**留应用(`css/editor.css`),因为产出 `.dsl-*` 类名的是应用的
 *   分词器.
 * 这个划分是"改编辑器只开对应的那一个文件"的前提,靠注释守不住:一旦有人把
 * 结构规则挪回应用,或者排版样式散进 panels.css,这里会直接失败.
 *
 * P4/D8 之后两处路径变了:窗口样式搬进库(`@miko/ui/styles/desktop.css`,所以
 * 这里按**包路径**导入而不是相对文件路径),样式入口从 index.html 的 <link>
 * 变成 `src/main.ts` 的 import 顺序.
 */
function read(relative: string): string {
    return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

/**
 * 库的桌面样式表.
 *
 * 用**包路径**解析而不是相对文件路径:这样"库搬走之后还在不在"由 exports
 * 映射决定,测试跟着包走(require.resolve 读的就是 exports).
 */
const require = createRequire(import.meta.url);
const readLib = (specifier: string): string => readFileSync(require.resolve(specifier), 'utf8');

const desktopCss = readLib('@miko/ui/styles/desktop.css');
/** 编辑器外壳的结构与对齐样式:随库走(P4/D8). */
const libEditorCss = readLib('@miko/ui/styles/editor.css');

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
    const editorCss = read('../../css/editor.css');
    const panelsCss = read('../../css/panels.css');

    it('编辑器的结构选择器都在库的 editor.css 里(类名,不是 id)', () => {
        for (const selector of [
            '.code-editor {',
            '.code-editor-input',
            '.code-editor-highlight',
            '.code-editor-highlight-code',
            '.code-editor-gutter',
            '.code-editor-lines',
            '.code-editor-textarea',
        ]) {
            expect(libEditorCss, `库的 editor.css 缺少 ${selector}`).toContain(selector);
        }
        // 应用侧只剩面板包裹层:编辑器外壳不再由应用排版.
        expect(editorCss).toContain('#editor-panel');
        expect(editorCss).not.toContain('.code-editor {');
    });

    it('DSL 词法配色留在应用侧(类名由应用的分词器产出)', () => {
        expect(editorCss).toContain('.dsl-comment');
        expect(panelsCss).not.toContain('.dsl-comment');
        // 库不认识 DSL:它的编辑器样式里不该出现词法类名.
        expect(libEditorCss).not.toContain('.dsl-comment');
    });

    it('panels.css 不再残留编辑器规则', () => {
        // `#dsl-editor` 后不能紧跟标识符字符,避免把 `#dsl-editorial` 之类的
        // 巧合算成命中;`#editor-panel` 同样不该出现.
        expect(panelsCss).not.toMatch(/\.dsl-[a-z]+/);
        expect(panelsCss).not.toContain('#editor-panel');
        expect(panelsCss).not.toContain('.code-editor');
    });

    it('样式入口按 token -> 桌面 -> 面板 -> 编辑器 -> 控件的顺序加载', () => {
        // 顺序即层叠顺序.把它写成断言而不是注释:样式入口换地方(HTML link ->
        // main.ts import)时不会有人记得同步注释,但会记得让测试过.
        const main = read('../main.ts');
        const order = [
            '@miko/ui/styles/tokens.css',
            '../css/base.css',
            '@miko/ui/styles/desktop.css',
            '../css/panels.css',
            '../css/editor.css',
            '@miko/ui/styles/editor.css',
            '@miko/ui/styles/widgets.css',
            '../css/diagnostics.css',
            '../css/process.css',
        ];
        const positions = order.map((specifier) => main.indexOf(`'${specifier}'`));

        for (const [index, position] of positions.entries()) {
            expect(position, `main.ts 里缺少 ${order[index]}`).toBeGreaterThanOrEqual(0);
            if (index > 0) expect(position).toBeGreaterThan(positions[index - 1]);
        }
    });

    it('高亮层与 textarea 的对齐样式逐项相同(窗口化不许碰的五条轴之一)', () => {
        const textarea = ruleOf(libEditorCss, '.code-editor-textarea');
        const highlightCode = ruleOf(libEditorCss, '.code-editor-highlight-code');

        // 这两条当年是靠手工比对调出来的:字体/字号/行高/制表位/内边距任意一项
        // 不一致,着色文字就会与光标错开,越往右下越明显.
        for (const property of ['font-family', 'font-size', 'line-height', 'tab-size', 'padding']) {
            const editor = valueOf(textarea, property);
            const highlight = valueOf(highlightCode, property);
            expect(editor, `.code-editor-textarea 缺少 ${property}`).not.toBeNull();
            expect(highlight, `.code-editor-highlight-code 缺少 ${property}`).not.toBeNull();
            expect(highlight, `${property} 两侧不一致`).toBe(editor);
        }
    });

    it('高亮层的显隐挂在"紧邻的下一兄弟"这条选择器上', () => {
        // 高亮层必须紧跟 textarea:谁在中间插一个节点,整层就不显示(而不是错位).
        expect(libEditorCss).toContain(
            '.code-editor-textarea.is-highlighted + .code-editor-highlight',
        );
    });

    it('高亮层是 inset:0 的裁剪框而不是滚动容器', () => {
        // 滚动偏移写在高亮内容的 transform 上(见 EditorHighlight.sync);
        // 一旦这里变成 auto/scroll,高亮层就会与 textarea 各有一个最大滚动偏移
        // (两者 client 尺寸差一个滚动条厚度),靠近底部时高亮会被夹住而错位.
        const rule = ruleOf(libEditorCss, '.code-editor-highlight');

        expect(rule).toContain('inset: 0');
        expect(rule).toContain('overflow: hidden');
        expect(rule).not.toMatch(/overflow:\s*(auto|scroll)/);
    });

    it('高亮层紧跟 textarea(相邻兄弟选择器依赖这个顺序)', () => {
        // 谁在两者之间插一个节点,高亮就整层不显示(而不是错位,所以更容易被
        // 误判成"功能没了").结构现在由 `src/app/appViews.ts` 建(D1),所以直接
        // 建一棵桩树断言相邻关系,不再对着 index.html 做文本匹配.
        const stub = installDomStub();
        const root = stub.document.createElement('div');
        const views = buildAppViews(root as unknown as HTMLElement);
        const input = views.editor.parentElement as unknown as StubElement;

        expect(input.children[0]).toBe(views.editor as unknown as StubElement);
        expect(input.children[1]).toBe(views.editorHighlight as unknown as StubElement);
    });

    it('窗口的隐藏态不含 display: none(隐藏期间必须量得到尺寸)', () => {
        // 编辑器行号与高亮层在隐藏期间若量到 0 宽/高,恢复后对齐会整体错乱,
        // 而且错误发生在"另一次交互之后",极难联想到是隐藏方式导致的.
        const hiddenRule = ruleOf(desktopCss, '.window.is-hidden');

        expect(hiddenRule).not.toBe('');
        expect(hiddenRule).toContain('opacity: 0');
        expect(hiddenRule).not.toMatch(/display:\s*none/);
    });
});
