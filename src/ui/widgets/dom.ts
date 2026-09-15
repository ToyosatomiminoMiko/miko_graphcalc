/**
 * 声明式建 DOM 的最小原语.
 *
 * 这一层只干一件事:把"标签 + 类名 + 属性 + 子节点"写成一次函数调用,
 * 让上层可以用嵌套的表达式声明一棵树,而不是 `createElement` / `className` /
 * `append` 三行样板排成一片.
 *
 * 刻意不做的事:
 * - **不引入 JSX**:那需要改 `tsconfig`(`jsx`)与 `vite` 的编译链,与本项目
 *   "不引前端框架/构建插件"的取舍冲突;
 * - **不做虚拟 DOM / diff**:这里的树只在装配期建一次,之后由各控件自己
 *   `set()` 就地更新.没有"每帧重建再比对"的需求,就不该有那套运行时.
 *
 * 产出的 DOM 必须与手写 HTML 完全同构,类名沿用现有 CSS(见
 * `css/controls.css`),所以样式一个字符都不用改.
 */

/** 子节点:假值一律跳过,便于在声明里写 `cond && el(...)`. */
export type Child = Node | string | null | false | undefined;

export interface ElementOptions {
    /** 类名,直接写进 `className`(沿用现有 CSS 的类名). */
    class?: string;
    /** 文本内容;与子节点互斥,给了文本就不再展开子节点. */
    text?: string;
    /** 其余属性,统一走 `setAttribute`(`for`/`type`/`aria-*`/`data-*`). */
    attrs?: Record<string, string>;
}

/**
 * 建一个元素.
 *
 * 只接受字符串子节点与真节点:字符串用 `createTextNode` 落地,不用
 * `innerHTML`,避免把源码/公式这类外部文本当 HTML 解析.
 *
 * 两个重载:已知标签(`el('span')`)返回具体的 `HTMLSpanElement`,便于取
 * `input.value` / `label.htmlFor` 这类具体成员;运行时才知道的字符串标签
 * (`el(tag)`,来自上层参数)退回 `HTMLElement`.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: ElementOptions,
    ...children: Child[]
): HTMLElementTagNameMap[K];
export function el(
    tag: string,
    options?: ElementOptions,
    ...children: Child[]
): HTMLElement;
export function el(
    tag: string,
    options: ElementOptions = {},
    ...children: Child[]
): HTMLElement {
    const element = document.createElement(tag);
    if (options.class !== undefined) element.className = options.class;
    if (options.text !== undefined) element.textContent = options.text;
    for (const [name, value] of Object.entries(options.attrs ?? {})) {
        element.setAttribute(name, value);
    }
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        element.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return element;
}

/** 控件实例序号:给 `<label for>` / `aria-*` 配对用的 id,只要求页内唯一. */
let widgetSeq = 0;

/**
 * 生成本次会话内唯一的控件 id.
 *
 * 老写法把 id 当全局注册表用(`getElementById('pointValue')`),撞名或漏写
 * 都只在运行时静默出错.现在 id 只服务"标签关联"这一件事,由控件自己发,
 * 外部一律拿 handle 引用节点,不再按 id 查.
 */
export function nextWidgetId(kind: string): string {
    widgetSeq += 1;
    return `ui-${kind}-${widgetSeq}`;
}
