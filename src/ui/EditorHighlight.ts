/**
 * 源码高亮层:把 `highlightDsl` 的产物显示在 textarea 背后.
 *
 * 为什么是"叠层"而不是换个编辑器组件:项目只有 katex/three 两个运行时依赖,
 * 换 CodeMirror/Monaco 会把 `textarea` 连同行号栏,键盘绑定,示例载入一起
 * 换掉(见 EditorLineNumbers).叠层方案不动输入行为:光标,选区,撤销栈,
 * IME 全部还是浏览器原生 textarea 的,高亮只是一层 pointer-events: none
 * 的背景,着色错了也不影响编译.
 *
 * 三个必须对齐的点(与 panels.css 的注释配套):
 * 1. 字体/字号/行高/制表位与 textarea 完全相同,否则字宽字高不一致;
 * 2. 内边距相同(10px 12px),首字符起点才一致;
 * 3. 滚动同步:高亮层自己就是滚动容器,直接把 textarea 的 scrollTop/scrollLeft
 *    抄过来即可.行号栏走的是 transform,那是因为它只需要纵向跟随;
 *    这里纵横都要,交给滚动容器比自己推导 padding 偏移可靠.
 *
 * 为什么用类名开开关(`is-highlighted`):CSS 里"文字透明"与"高亮层显示"
 * 由同一个类控制.脚本没跑或结构缺失时构造就抛错,类名不会加上,textarea
 * 仍是普通不透明输入框--不会出现"字看不见,也没高亮"的黑洞.
 */
import { highlightDsl } from './dslHighlight';

/** 打开高亮层的类名:同时负责 textarea 文字透明与高亮层显示(见 panels.css). */
export const HIGHLIGHT_ENABLED_CLASS = 'is-highlighted';

/**
 * 高亮层依赖的两个节点,由装配层取好传入(取不到时构造即报错,与
 * EditorLineNumbers 同一约定:结构约束可见,而不是藏在"父节点里按 id 查").
 */
export interface EditorHighlightElements {
    /** 滚动容器(`#dsl-editor-highlight`),尺寸与 textarea 完全重合. */
    readonly scroller: HTMLElement | null;
    /** 承载高亮 HTML 的 `<pre>`(`#dsl-editor-highlight-code`). */
    readonly code: HTMLElement | null;
}

export class EditorHighlight {
    private readonly scroller: HTMLElement;
    private readonly code: HTMLElement;
    private readonly resizeObserver: ResizeObserver;
    private disposed = false;

    constructor(
        private readonly editor: HTMLTextAreaElement,
        elements: EditorHighlightElements,
    ) {
        const { scroller, code } = elements;
        if (!scroller || !code) {
            throw new Error(
                'EditorHighlight 缺少 #dsl-editor-highlight / #dsl-editor-highlight-code 结构',
            );
        }
        this.scroller = scroller;
        this.code = code;

        // 输入:重新分词并重绘;滚动:只同步偏移.
        // 组字(IME)期间不做特殊处理:这一层从不写 `editor.value` 或选区,
        // 重绘背景不会打断浏览器自己的组字过程,只是把组字中的文字一并着色.
        editor.addEventListener('input', this.update);
        editor.addEventListener('scroll', this.sync, { passive: true });

        // 面板折叠/拖宽会改变编辑器尺寸,滚动位置可能被浏览器夹回去,
        // 而且不一定补发 scroll 事件:尺寸变化时补一次同步(与行号栏同因).
        this.resizeObserver = new ResizeObserver(() => this.sync());
        this.resizeObserver.observe(editor);

        // 首次渲染成功后再开开关,保证"能看到的高亮"与"透明的文字"同时生效.
        this.update();
        editor.classList.add(HIGHLIGHT_ENABLED_CLASS);
    }

    /** 外部程序化改写 `editor.value`(载入示例/撤销)后调用. */
    refresh(): void {
        if (this.disposed) return;
        this.update();
    }

    private readonly update = (): void => {
        if (this.disposed) return;
        this.code.innerHTML = highlightDsl(this.editor.value);
        this.sync();
    };

    private readonly sync = (): void => {
        if (this.disposed) return;
        this.scroller.scrollTop = this.editor.scrollTop;
        this.scroller.scrollLeft = this.editor.scrollLeft;
    };

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.editor.removeEventListener('input', this.update);
        this.editor.removeEventListener('scroll', this.sync);
        this.resizeObserver.disconnect();
        this.editor.classList.remove(HIGHLIGHT_ENABLED_CLASS);
    }
}
