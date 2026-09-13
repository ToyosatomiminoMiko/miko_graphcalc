/**
 * DSL 编辑器行号栏.
 *
 * 为什么"textarea 加行号"听起来简单却难实现:
 * 原生 textarea 的内部滚动区无法再渲染"每行一个数字",行号只能做在
 * 旁边的独立元素里,于是难点变成数字必须与文本**逐像素对齐**,三个坑:
 * 1. 软换行:textarea 默认把长行折成多个视觉行,行号(按 \n 计)就无法
 *    一一对应--所以这里关闭软换行(white-space: pre),让 源码行 == 视觉行;
 * 2. 行高对齐:gutter 与 textarea 必须同字体/字号/行高,且首行起始位置
 *    一致(见 panels.css 中 padding-top 的推导注释);
 * 3. 滚动同步:文本在 textarea 内部滚动,行号在外部,只能用
 *    translateY(-scrollTop) 跟随,并在 scroll / input / 容器尺寸变化
 *    (面板折叠,拖宽拖高)时重同步.
 *
 * 三件事由 CSS 与 HTML 结构约束住之后,这里的逻辑只剩三条:
 * 按 \n 计数重绘行号 + 按 scrollTop 反向平移 + 按字体/行数重算 gutter 宽度.
 *
 * 为什么宽度要动态算:字号与字族来自 `UI_CONFIG`,不再是写死的 13px/32px;
 * 不同字体的数字宽度不同,固定宽度会在 3 位行号或较大字号下把行号裁掉,
 * 所以每次重绘行号时顺带量一次.
 *
 * 为什么 gutter/行号由**构造参数**传入(而不是在编辑器父节点里查 id):
 * 那会把"两者必须是同一父元素下的特定 id"这条结构约束藏进实现里,
 * 装配层改 HTML 时只会看到运行期 throw(见 UI-P3.10).现在由 DslApp 显式
 * 取节点并传进来,缺结构时同样立刻报错,但依赖是可见的.
 *
 * 为什么对外要暴露 `refresh()`:`input` 事件只覆盖用户键入;若将来有代码
 * 程序化写 `editor.value`(载入示例/撤销到某版本),行号不会自己更新.
 */
/** gutter 里除数字本身之外的固定宽度:左 padding 8 + 行号右 padding 6 + 边框 1,与 panels.css 对应. */
const GUTTER_CHROME_PX = 15;

/** 槽宽下限,与 base.css 里 --code-gutter-width 的兜底值一致. */
const GUTTER_MIN_WIDTH_PX = 32;

/** 行号栏依赖的两个兄弟节点;由装配层取好传入(取不到时构造即报错). */
export interface EditorLineNumberElements {
    readonly gutter: HTMLElement | null;
    readonly numbers: HTMLElement | null;
}

export class EditorLineNumbers {
    private readonly gutter: HTMLElement;
    private readonly numbers: HTMLElement;
    private readonly resizeObserver: ResizeObserver;
    /** 度量数字宽度用的离屏 2D context;取不到时为 null,保持 CSS 兜底宽度 */
    private readonly measureContext: CanvasRenderingContext2D | null;
    private disposed = false;

    constructor(
        private readonly editor: HTMLTextAreaElement,
        elements: EditorLineNumberElements,
    ) {
        const { gutter, numbers } = elements;
        if (!gutter || !numbers) {
            throw new Error('EditorLineNumbers 缺少 #dsl-editor-gutter / #dsl-editor-lines 结构');
        }
        this.gutter = gutter;
        this.numbers = numbers;
        this.measureContext = document.createElement('canvas').getContext('2d');

        // 输入(含粘贴/撤销/IME 组字)只改行数,重绘行号;
        // 内部滚动只改偏移,平移即可.
        editor.addEventListener('input', this.update);
        editor.addEventListener('scroll', this.sync, { passive: true });

        // 面板折叠/展开,拖宽会改变编辑器尺寸:行号内容只取决于文本,
        // 尺寸变化不重算行数,只需校准一次平移(scrollTop 可能被重置).
        // 观察编辑器自己而不是父节点:编辑器随面板一起伸缩,父节点的额外尺寸
        // 与行号无关,少一层结构假设.
        this.resizeObserver = new ResizeObserver(() => this.sync());
        this.resizeObserver.observe(editor);

        this.update();
    }

    /** 外部程序化改写 `editor.value` 后调用:重算行数,槽宽并校准平移. */
    refresh(): void {
        if (this.disposed) return;
        this.update();
    }

    /** input / 初始化:按 \n 重算行数并重绘,同步槽宽,再校准一次平移. */
    private readonly update = (): void => {
        const lineCount = this.editor.value.split('\n').length;
        const buffer: string[] = [];
        for (let i = 1; i <= lineCount; i += 1) buffer.push(String(i));
        this.numbers.textContent = buffer.join('\n');
        this._syncGutterWidth(lineCount);
        this.sync();
    };

    /**
     * 按"最大行号位数 x 当前字体下的数字宽 + gutter 内边距/边框"重算槽宽.
     *
     * 字体取自编辑器自身的计算样式,不读 `UI_CONFIG`:这样 CSS 兜底值与
     * applyUiConfig 覆盖两条路径都能自动对齐,少一处需要手工同步的常量.
     */
    private _syncGutterWidth(lineCount: number): void {
        const context = this.measureContext;
        if (!context) return;

        const style = getComputedStyle(this.editor);
        context.font = `${style.fontSize} ${style.fontFamily}`;
        // 至少按 2 位数留宽,避免个位数行数时槽宽跳变.
        const digits = Math.max(2, String(lineCount).length);
        const digitWidth = context.measureText('0'.repeat(digits)).width;
        const width = Math.max(
            GUTTER_MIN_WIDTH_PX,
            Math.ceil(digitWidth + GUTTER_CHROME_PX),
        );
        this.gutter.style.setProperty('--code-gutter-width', `${width}px`);
    }

    /** scroll / 尺寸变化:textarea 内部滚了多少,行号就反向平移多少. */
    private readonly sync = (): void => {
        if (this.disposed) return;
        this.numbers.style.transform = `translateY(${-this.editor.scrollTop}px)`;
    };

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.editor.removeEventListener('input', this.update);
        this.editor.removeEventListener('scroll', this.sync);
        this.resizeObserver.disconnect();
    }
}
