/**
 * 源码高亮层:把 `highlightDsl` 的产物显示在 textarea 背后.
 *
 * 为什么是"叠层"而不是换个编辑器组件:项目只有 katex/three 两个运行时依赖,
 * 换 CodeMirror/Monaco 会把 `textarea` 连同行号栏,键盘绑定,示例载入一起
 * 换掉(见 EditorLineNumbers).叠层方案不动输入行为:光标,选区,撤销栈,
 * IME 全部还是浏览器原生 textarea 的,高亮只是一层 pointer-events: none
 * 的背景,着色错了也不影响编译.
 *
 * 三个必须对齐的点(与 editor.css 的注释配套):
 * 1. 字体/字号/行高/制表位与 textarea 完全相同,否则字宽字高不一致;
 * 2. 内边距相同(10px 12px),首字符起点才一致;
 * 3. 滚动同步:把 textarea 的 scrollTop/scrollLeft 原样写成高亮内容的
 *    transform(见 sync),**不能**改成"抄给高亮容器自己的 scrollTop".
 *    原因是两边的 client 尺寸天生不等:textarea 的滚动条要占位(经典滚动条
 *    约 15px),而高亮层是 overflow: hidden 不占,于是两者的最大
 *    scrollTop/scrollLeft 恰好差一个滚动条厚度.偏移越靠近底部/右端,抄过去
 *    的值越会被浏览器夹住(clamp),高亮层最多滞后 ~15px(约 0.8 行),光标和
 *    选区就会与着色后的文字错开(实测:未夹住时偏差 0.0px,夹住后 15.1px).
 *    transform 只经过一个元素,没有第二个滚动容器的上限,永远不会被夹住.
 *    行号栏用的是同一套方案(见 EditorLineNumbers).
 *
 * 为什么用类名开开关(`is-highlighted`):CSS 里"文字透明"与"高亮层显示"
 * 由同一个类控制.脚本没跑或结构缺失时构造就抛错,类名不会加上,textarea
 * 仍是普通不透明输入框--不会出现"字看不见,也没高亮"的黑洞.
 */
import { highlightDsl } from './dslHighlight';

/** 打开高亮层的类名:同时负责 textarea 文字透明与高亮层显示(见 editor.css). */
export const HIGHLIGHT_ENABLED_CLASS = 'is-highlighted';

/**
 * 高亮层依赖的两个节点,由装配层取好传入(取不到时构造即报错,与
 * EditorLineNumbers 同一约定:结构约束可见,而不是藏在"父节点里按 id 查").
 */
export interface EditorHighlightElements {
    /**
     * 裁剪框(`#dsl-editor-highlight`),尺寸与 textarea 完全重合.
     *
     * 它只负责 `overflow: hidden` 裁剪,不承担滚动:偏移写在内容元素的
     * transform 上(见 sync).结构上仍然必需,所以取不到就构造报错.
     */
    readonly scroller: HTMLElement | null;
    /** 承载高亮 HTML 的 `<pre>`(`#dsl-editor-highlight-code`),transform 的载体. */
    readonly code: HTMLElement | null;
}

export class EditorHighlight {
    private readonly scroller: HTMLElement;
    private readonly code: HTMLElement;
    private readonly resizeObserver: ResizeObserver;
    /** 待执行的重绘帧(见 `onInput`);null 表示没有排队中的重绘. */
    private pendingUpdate: number | null = null;
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

        // 输入:重新分词并重绘(合并到帧,见 onInput);滚动:只同步偏移.
        // 组字(IME)期间不做特殊处理:这一层从不写 `editor.value` 或选区,
        // 重绘背景不会打断浏览器自己的组字过程,只是把组字中的文字一并着色.
        editor.addEventListener('input', this.onInput);
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

    /**
     * input 事件入口:把整份源码的重分词 + `innerHTML` 重排推到下一帧.
     *
     * 为什么必须合并:重绘代价与**全文长度**成正比(见 `highlightDsl`),而对
     * 2.4kHz 键盘重复率来说"每次 input 都重排"意味着同一帧内可能排队好几次
     * 全量重排.合并到一帧一次,肉眼等效(浏览器本来也只按帧呈现),省掉的是
     * 同一帧里的重复分词与重复解析 HTML.
     *
     * 与 `sync()` 的分工不变:滚动/尺寸变化仍然即时同步(它只写一个 transform,
     * 延后反而会看到高亮与文字错位).
     */
    private readonly update = (): void => {
        if (this.disposed) return;
        this.code.innerHTML = highlightDsl(this.editor.value);
        this.sync();
    };

    /** 合并后的 input 处理:同一帧内的多次输入只重排一次. */
    private readonly onInput = (): void => {
        if (this.disposed || this.pendingUpdate !== null) return;
        this.pendingUpdate = requestAnimationFrame(() => {
            this.pendingUpdate = null;
            this.update();
        });
    };

    /**
     * scroll / 尺寸变化:把 textarea 的横纵偏移写成高亮内容的 transform.
     *
     * 为什么不用高亮层自己的 scrollTop:见文件头第 3 条--两个滚动容器的
     * client 尺寸差一个滚动条厚度,靠近底部/右端时偏移会被夹住,表现为
     * "越往下,着色后的文字越跟不上光标".
     */
    private readonly sync = (): void => {
        if (this.disposed) return;
        this.code.style.transform =
            `translate(${-this.editor.scrollLeft}px, ${-this.editor.scrollTop}px)`;
        // 裁剪框仍是可被程序化滚动的盒子(滚动锚定,innerHTML 重排都可能动它),
        // 一旦被滚走,就会与上面的 transform 叠加成双倍偏移,所以每次按回原点.
        this.scroller.scrollTop = 0;
        this.scroller.scrollLeft = 0;
    };

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.editor.removeEventListener('input', this.onInput);
        this.editor.removeEventListener('scroll', this.sync);
        this.resizeObserver.disconnect();
        if (this.pendingUpdate !== null) {
            cancelAnimationFrame(this.pendingUpdate);
            this.pendingUpdate = null;
        }
        this.editor.classList.remove(HIGHLIGHT_ENABLED_CLASS);
    }
}
