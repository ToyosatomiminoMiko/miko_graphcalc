/**
 * 源码高亮层单测.
 *
 * 锁四条:输入后重绘高亮 HTML;滚动时把 textarea 的 scrollTop/scrollLeft
 * 写成高亮内容的 transform(纵横都要,**不**经过裁剪框自己的 scrollTop,
 * 否则靠近底部时会被夹住而错位);`refresh()` 覆盖程序化改值;缺结构时构造即报错.
 * 另外锁"开关类名"跟着生命周期走:dispose 后文字必须回到可见状态.
 *
 * 这里不断言浏览器排版(项目没有 jsdom/浏览器,见 src/testing/domStub.ts):
 * 对齐靠 CSS 常量与同源字体变量保证,像素级验证留给真机.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installDomStub, type DomStub, type StubElement } from '../../testing/domStub';
import { EditorHighlight, HIGHLIGHT_ENABLED_CLASS } from './EditorHighlight';

interface Harness {
    readonly stub: DomStub;
    readonly editor: StubElement;
    readonly scroller: StubElement;
    readonly code: StubElement;
    readonly highlight: EditorHighlight;
}

function setup(value = 'curve c1 = 1;'): Harness {
    const stub = installDomStub();
    const editor = stub.document.createElement('textarea');
    editor.value = value;
    const scroller = stub.document.createElement('div');
    const code = stub.document.createElement('pre');
    stub.document.body.append(editor, scroller, code);

    const highlight = new EditorHighlight(
        editor as unknown as HTMLTextAreaElement,
        {
            scroller: scroller as unknown as HTMLElement,
            code: code as unknown as HTMLElement,
        },
    );
    return { stub, editor, scroller, code, highlight };
}

beforeEach(() => {
    installDomStub();
});

describe('高亮渲染', () => {
    it('构造时渲染着色后的源码并打开开关', () => {
        const { editor, code } = setup();
        expect(code.innerHTML).toContain('<span class="dsl-keyword">curve</span>');
        expect(editor.classList.contains(HIGHLIGHT_ENABLED_CLASS)).toBe(true);
    });

    it('input 事件重绘(合并到下一帧执行)', () => {
        const { editor, code, stub } = setup('curve c1 = 1;');

        editor.value = '// 注释';
        editor.dispatch('input');
        // 重排推到下一帧:还没 flush 时高亮仍是旧内容
        expect(code.innerHTML).toContain('curve');
        expect(stub.pendingFrameCount()).toBe(1);

        stub.flushFrames();

        expect(code.innerHTML).toContain('<span class="dsl-comment">// 注释</span>');
    });

    it('同一帧内的多次 input 只重排一次', () => {
        const { editor, code, stub } = setup('curve c1 = 1;');

        editor.value = '// 一';
        editor.dispatch('input');
        editor.value = '// 二';
        editor.dispatch('input');
        editor.value = '// 三';
        editor.dispatch('input');

        // 三次输入只排一个帧:否则每次按键都会全量重分词 + 重排 innerHTML
        expect(stub.pendingFrameCount()).toBe(1);

        stub.flushFrames();

        expect(code.innerHTML).toContain('<span class="dsl-comment">// 三</span>');
    });
});

describe('滚动同步', () => {
    it('scroll 事件把纵横偏移写成高亮内容的 transform', () => {
        const { editor, code } = setup();

        editor.scrollTop = 40;
        editor.scrollLeft = 12;
        editor.dispatch('scroll');

        expect(code.style.transform).toBe('translate(-12px, -40px)');
    });

    it('偏移不经过裁剪框自己的 scrollTop,并把它按回原点', () => {
        const { editor, scroller } = setup();

        // 模拟滚动锚定/innerHTML 重排把裁剪框滚偏:不能与 transform 叠加成双倍偏移
        scroller.scrollTop = 7;
        scroller.scrollLeft = 3;
        editor.scrollTop = 40;
        editor.dispatch('scroll');

        expect(scroller.scrollTop).toBe(0);
        expect(scroller.scrollLeft).toBe(0);
    });

    it('ResizeObserver 触发时重新校准偏移', () => {
        const { stub, editor, code } = setup();

        // 拖宽面板后浏览器可能把 scrollTop 夹回去,且不一定补发 scroll 事件
        editor.scrollTop = 25;
        expect(stub.resizeObservers).toHaveLength(1);
        stub.resizeObservers[0].trigger();

        expect(code.style.transform).toBe('translate(0px, -25px)');
    });
});

describe('程序化改值的刷新入口', () => {
    it('不派发 input 时高亮不自动更新,refresh() 后跟上', () => {
        const { editor, code, highlight } = setup('curve c1 = 1;');

        editor.value = 'surface s1 = 1;';
        expect(code.innerHTML).toContain('curve');

        highlight.refresh();

        expect(code.innerHTML).toContain('surface');
        expect(code.innerHTML).not.toContain('curve');
    });

    it('dispose 后不再重绘,并摘掉开关类名', () => {
        const { editor, code, highlight } = setup('curve c1 = 1;');

        highlight.dispose();
        editor.value = 'surface s1 = 1;';
        editor.dispatch('input');
        highlight.refresh();

        expect(code.innerHTML).toContain('curve');
        expect(editor.classList.contains(HIGHLIGHT_ENABLED_CLASS)).toBe(false);
    });
});

describe('结构缺失', () => {
    it('高亮节点缺失时构造直接报错', () => {
        const stub = installDomStub();
        const editor = stub.document.createElement('textarea');

        expect(() => new EditorHighlight(
            editor as unknown as HTMLTextAreaElement,
            { scroller: null, code: null },
        )).toThrow(/dsl-editor-highlight/);
    });
});
