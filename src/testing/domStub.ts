/**
 * 测试用最小 DOM 桩(node 环境,不引入 jsdom).
 *
 * 为什么不用 jsdom:项目没有该依赖,且这里要锁的是**控制器自己的不变量**
 * (事件 -> 状态 -> DOM 写入),不是浏览器排版/事件冒泡的完整语义.桩只实现
 * `src/ui` 真正用到的 API,并刻意复刻真 DOM 里踩过的坑:
 * - 节点只有一个父节点(`append`/`replaceChildren` 会先把节点从旧父节点摘除),
 *   否则"搬运模板子节点搬空缓存"这类回归会被遮住;
 * - `textContent` 取值拼接子文本节点,设置时清空子节点;
 * - `<details>` 的 `open` 是普通属性,便于断开展开态保留.
 *
 * 覆盖的全局:`document` / `Element` / `getComputedStyle` / `ResizeObserver` /
 * `navigator` / `window`.每个 `installDomStub()` 会新建一棵空树并返回句柄,
 * 供断言(如 ResizeObserver 触发,document.body.style).
 */

export class StubClassList {
    constructor(private readonly owner: StubElement) {}

    /**
     * 每次从 `className` 现算,而不是维护一份内部集合:真 DOM 里
     * `className = 'a b'` 与 `classList.contains('a')` 是同一份数据,
     * 桩里若分成两处,直接赋值 className 后按类查询就会失灵.
     */
    private names(): Set<string> {
        return new Set(this.owner.className.split(/\s+/).filter(Boolean));
    }

    contains(name: string): boolean {
        return this.names().has(name);
    }

    toggle(name: string, force?: boolean): boolean {
        const next = this.names();
        const on = force ?? !next.has(name);
        if (on) next.add(name);
        else next.delete(name);
        this.owner.className = [...next].join(' ');
        return on;
    }

    add(name: string): void {
        this.toggle(name, true);
    }

    remove(name: string): void {
        this.toggle(name, false);
    }
}

/**
 * 元素的行内样式.
 *
 * 与真 DOM 的 `CSSStyleDeclaration` 一样,**驼峰属性与 `setProperty` 的连字符
 * 属性是同一份数据**:窗口化里 `focus()` 写 `style.zIndex`,几何写入走
 * `style.setProperty('left', ...)`,两者必须能互相看见,否则"拖动会不会清掉
 * z-index"这条回归在桩里断言不到(见 WindowManager.test.ts).
 *
 * 赋空字符串等于移除该条声明(真 DOM 里 `style.display = ''` 就是清掉行内值,
 * 回落到样式表).
 */
export class StubStyle {
    private readonly properties = new Map<string, string>();

    private read(name: string): string {
        return this.properties.get(name) ?? '';
    }

    private write(name: string, value: string): void {
        if (value === '') this.properties.delete(name);
        else this.properties.set(name, value);
    }

    get display(): string {
        return this.read('display');
    }

    set display(value: string) {
        this.write('display', value);
    }

    get cursor(): string {
        return this.read('cursor');
    }

    set cursor(value: string) {
        this.write('cursor', value);
    }

    get transform(): string {
        return this.read('transform');
    }

    set transform(value: string) {
        this.write('transform', value);
    }

    /** 窗口的 z-index 由 `focus()` 独占写入(不是几何的一部分). */
    get zIndex(): string {
        return this.read('z-index');
    }

    set zIndex(value: string) {
        this.write('z-index', value);
    }

    setProperty(name: string, value: string): void {
        this.write(name, value);
    }

    getPropertyValue(name: string): string {
        return this.read(name);
    }

    /** 真 DOM 语义:返回被移除的值(没有则空串). */
    removeProperty(name: string): string {
        const previous = this.read(name);
        this.properties.delete(name);
        return previous;
    }
}

/** 文本节点:真 DOM 的文本节点也参与树结构,克隆/搬运时同样要摘除旧父节点. */
export class StubText {
    parent: StubElement | null = null;

    constructor(readonly data: string) {}
}

/** 真 DOM 语义:节点只有一个父节点;插进新位置前先从旧父节点摘除. */
export function detachNode(node: StubElement | StubText): void {
    const parent = node.parent;
    if (parent === null) return;
    const index = parent.children.indexOf(node);
    if (index >= 0) parent.children.splice(index, 1);
    node.parent = null;
}

/**
 * 单个"简单选择器"的匹配:`tag` / `.class` / `#id` / `[attr]` / `[attr=value]`.
 */
function matchesSimple(element: StubElement, selector: string): boolean {
    const trimmed = selector.trim();
    if (trimmed === '') return false;
    if (trimmed.startsWith('#')) return element.id === trimmed.slice(1);
    if (trimmed.startsWith('.')) return element.classList.contains(trimmed.slice(1));
    if (trimmed.startsWith('[')) {
        const match = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(trimmed);
        if (!match) return false;
        const attribute = element.getAttribute(match[1]);
        if (attribute === null) return false;
        return match[2] === undefined || attribute === match[2];
    }
    const dot = trimmed.indexOf('.');
    if (dot >= 0) {
        return element.tagName === trimmed.slice(0, dot)
            && element.classList.contains(trimmed.slice(dot + 1));
    }
    return element.tagName === trimmed;
}

/**
 * 把复合选择器拆成简单选择器.
 *
 * 只在**方括号/引号之外**的 `.` / `#` / `[` 处切:`[data-example="a.miko"]` 里
 * 那个点属于属性值,切开会得到两个都匹配不上的碎片(这个坑在
 * `ExampleLoaderController.test.ts` 上真的踩到过).
 */
function splitCompound(selector: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depth = 0;
    let quote = '';

    for (const char of selector) {
        if (quote !== '') {
            current += char;
            if (char === quote) quote = '';
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            current += char;
            continue;
        }
        if (char === ']') {
            depth = Math.max(0, depth - 1);
            current += char;
            continue;
        }
        if (depth === 0 && (char === '.' || char === '#' || char === '[')) {
            if (current !== '') parts.push(current);
            current = char;
            if (char === '[') depth = 1;
            continue;
        }
        current += char;
    }
    if (current !== '') parts.push(current);
    return parts;
}

/**
 * `querySelector` 支持的选择器:`tag` / `.class` / `#id` / `[attr]` / `[attr=value]`,
 * 以及它们的**复合**形式(`.dock-btn[data-window="source"]`).
 *
 * 复合选择器逐段命中即可;后代/子代组合器与伪类仍然不支持(桩只服务控制器
 * 自己写下的选择器).
 */
function matchesSelector(element: StubElement, selector: string): boolean {
    const trimmed = selector.trim();
    if (trimmed === '') return false;
    return splitCompound(trimmed).every((part) => matchesSimple(element, part));
}

/** `dataset` 的 camelCase 属性名 <-> `data-*` 属性名. */
function dataAttributeName(property: string): string {
    return `data-${property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

export class StubElement {
    className = '';
    id = '';
    htmlFor = '';
    tabIndex = -1;
    value = '';
    type = '';
    min = '';
    max = '';
    step = '';
    scrollTop = 0;
    /** 高亮层要把 textarea 的横纵偏移一起抄过去,桩里两个方向都要有. */
    scrollLeft = 0;
    /**
     * 桩**不解析 HTML**:innerHTML 只保存字符串,子节点树不跟着变.
     *
     * 唯一的使用者是源码高亮层(EditorHighlight 把高亮 HTML 写进背景层),
     * 测试要断言的正是"写进去的 HTML 是什么",而不是浏览器的解析结果;
     * 需要节点树的地方仍走 createElement/append.
     */
    innerHTML = '';
    checked = false;
    /** 按钮的禁用态:参数行的重置按钮靠它在"已停在声明值"时置灰. */
    disabled = false;
    /** `<details>` 的开合状态;普通元素上无意义. */
    open = false;
    /**
     * 排版尺寸:桩不做布局,由测试自己按用例赋值(分隔条的比例换算要用).
     * `clientHeight` / `getBoundingClientRect` 都从这两个数派生,保证同一元素
     * 的"量高度"与"量矩形"读到的是一份数据.
     */
    offsetTop = 0;
    offsetWidth = 0;
    offsetHeight = 0;
    /** 指针捕获状态:分隔条拖动时会 set/release,桩按真 DOM 语义记下来. */
    readonly capturedPointers = new Set<number>();
    /** 父元素;append/prepend/replaceChildren 时维护,replaceWith 需要它. */
    parent: StubElement | null = null;
    readonly style = new StubStyle();
    readonly classList = new StubClassList(this);
    readonly children: Array<StubElement | StubText> = [];
    readonly listeners = new Map<string, Array<(event: StubEvent) => void>>();
    private readonly attributes = new Map<string, string>();
    /**
     * 真 DOM 的 `dataset` 与 `data-*` 属性是同一份数据;桩里用 Proxy 反射,
     * 否则 `setAttribute('data-tex')` 后 `element.dataset.tex` 会是 undefined,
     * 而 FormulaCopyController 正是这么读的.
     */
    readonly dataset: Record<string, string> = new Proxy({} as Record<string, string>, {
        get: (_target, property) => typeof property === 'string'
            ? this.attributes.get(dataAttributeName(property))
            : undefined,
        set: (_target, property, value: string) => {
            if (typeof property === 'string') {
                this.attributes.set(dataAttributeName(property), String(value));
            }
            return true;
        },
        has: (_target, property) => typeof property === 'string'
            && this.attributes.has(dataAttributeName(property)),
        deleteProperty: (_target, property) => {
            if (typeof property === 'string') {
                this.attributes.delete(dataAttributeName(property));
            }
            return true;
        },
        ownKeys: () => [...this.attributes.keys()].filter((name) => name.startsWith('data-')),
        getOwnPropertyDescriptor: (_target, property) => {
            if (typeof property !== 'string') return undefined;
            const value = this.attributes.get(dataAttributeName(property));
            return value === undefined
                ? undefined
                : { value, enumerable: true, configurable: true, writable: true };
        },
    });

    constructor(readonly tagName: string) {}

    get parentElement(): StubElement | null {
        return this.parent;
    }

    /** 桩的 textContent 是真 DOM 语义:取值时拼接全部子文本节点. */
    get textContent(): string {
        return this.children
            .map((child) => (child instanceof StubText ? child.data : child.textContent))
            .join('');
    }

    set textContent(value: string) {
        for (const child of [...this.children]) detachNode(child);
        if (value !== '') {
            const text = new StubText(value);
            text.parent = this;
            this.children.push(text);
        }
    }

    /**
     * 真 DOM 语义:节点只有一个父节点,插入前先从旧父节点摘除.
     */
    append(...nodes: Array<StubElement | StubText | null>): void {
        for (const node of nodes) {
            if (node === null) continue;
            // DocumentFragment 插入的是它的子节点,不是 fragment 自己.
            if (node instanceof StubElement && node.tagName === '#fragment') {
                const inner = [...node.children];
                for (const child of inner) detachNode(child);
                this.append(...inner);
                continue;
            }
            detachNode(node);
            node.parent = this;
            this.children.push(node);
        }
    }

    appendChild(node: StubElement | StubText): void {
        this.append(node);
    }

    prepend(...nodes: Array<StubElement | StubText>): void {
        for (const node of nodes) {
            detachNode(node);
            node.parent = this;
        }
        this.children.unshift(...nodes);
    }

    /** 真 DOM 的 replaceWith:用新节点顶替自己在父节点中的位置. */
    replaceWith(...nodes: Array<StubElement | StubText>): void {
        const parent = this.parent;
        if (!parent) return;
        const index = parent.children.indexOf(this);
        if (index < 0) return;
        for (const node of nodes) {
            detachNode(node);
            node.parent = parent;
        }
        parent.children.splice(index, 1, ...nodes);
        this.parent = null;
    }

    /** 真 DOM 的 childNodes 含文本节点;桩里直接暴露同一个 children 数组. */
    get childNodes(): Array<StubElement | StubText> {
        return this.children;
    }

    replaceChildren(...nodes: Array<StubElement | StubText>): void {
        for (const child of [...this.children]) detachNode(child);
        this.append(...nodes);
    }

    querySelector<T>(selector: string): T | null {
        return (this.querySelectorAll<T>(selector)[0] ?? null) as T | null;
    }

    querySelectorAll<T>(selector: string): T[] {
        const found: StubElement[] = [];
        const walk = (node: StubElement): void => {
            if (matchesSelector(node, selector)) found.push(node);
            for (const child of node.children) {
                if (child instanceof StubElement) walk(child);
            }
        };
        for (const child of this.children) {
            if (child instanceof StubElement) walk(child);
        }
        return found as unknown as T[];
    }

    /** 从自身向上找第一个匹配的祖先(与真 DOM 的 closest 同义). */
    closest<T>(selector: string): T | null {
        let node: StubElement | null = this;
        while (node !== null) {
            if (matchesSelector(node, selector)) return node as unknown as T;
            node = node.parent;
        }
        return null;
    }

    /**
     * 真 DOM 的 `contains`:other 是否在本节点子树里(含自身).
     * "点浮层外部关闭"这类判断要用它,桩必须实现--否则控制器只能改用
     * `closest` 之类的替代写法,而那是被测试基建牵着走的假实现.
     */
    contains(other: StubElement | StubText | null): boolean {
        let node: StubElement | StubText | null = other;
        while (node !== null) {
            if (node === this) return true;
            node = node.parent;
        }
        return false;
    }

    /**
     * 支持 `{ signal }`(真 DOM 语义的一个子集):signal 已 abort 时不再注册,
     * 注册后 abort 会摘掉监听.控制器用 AbortController 成对管理监听,
     * 桩若不实现这条,"dispose 后再 bind 会叠加旧监听"的回归会被遮住.
     */
    addEventListener(
        type: string,
        handler: (event: StubEvent) => void,
        options?: { signal?: AbortSignal },
    ): void {
        const signal = options?.signal;
        if (signal?.aborted) return;
        const list = this.listeners.get(type) ?? [];
        list.push(handler);
        this.listeners.set(type, list);
        signal?.addEventListener('abort', () => {
            const current = this.listeners.get(type);
            const index = current?.indexOf(handler) ?? -1;
            if (index >= 0) current?.splice(index, 1);
        });
    }

    removeEventListener(type: string, handler: (event: StubEvent) => void): void {
        const list = this.listeners.get(type);
        if (!list) return;
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
    }

    /** 只触发本元素上的监听(不冒泡),用来验证"某元素自己不响应某事件". */
    dispatch(type: string, event: Partial<StubEvent> = {}): void {
        const full: StubEvent = {
            type,
            target: this,
            key: '',
            timeStamp: 0,
            ctrlKey: false,
            metaKey: false,
            clientX: 0,
            clientY: 0,
            pointerId: 0,
            preventDefault: () => {},
            ...event,
        };
        for (const handler of [...(this.listeners.get(type) ?? [])]) handler(full);
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }

    removeAttribute(name: string): void {
        this.attributes.delete(name);
    }

    /**
     * 布尔属性语义:存在即为真;`force` 给了就按其值设置.
     *
     * 窗口的 `inert` 用 `toggleAttribute` 写(`applyState` 的唯一写入点),
     * 桩不实现这一条,`WindowManager.test.ts` 连第一次 `applyState` 都过不去.
     */
    toggleAttribute(name: string, force?: boolean): boolean {
        const on = force ?? !this.attributes.has(name);
        if (on) this.attributes.set(name, '');
        else this.attributes.delete(name);
        return on;
    }

    /**
     * `title` 与 `title="..."` 是同一份数据(真 DOM 的反射属性).
     *
     * 桩里两者必须反射到同一处:`el()` 的 `attrs` 走 `setAttribute`,
     * `createButton` 走 `element.title = ...`,真实 DOM 里两条路径等价,桩里
     * 分成两个字段就会让"按钮的 title 到底写进去没有"变成假阴性.
     */
    get title(): string {
        return this.attributes.get('title') ?? '';
    }

    set title(value: string) {
        this.attributes.set('title', value);
    }

    /** `hidden` 与 `[hidden]` 是同一份数据(真 DOM 的布尔反射属性). */
    get hidden(): boolean {
        return this.attributes.has('hidden');
    }

    set hidden(value: boolean) {
        this.toggleAttribute('hidden', value);
    }

    /** `inert` 同上:窗口隐藏态靠它挡 Tab 序与点击. */
    get inert(): boolean {
        return this.attributes.has('inert');
    }

    set inert(value: boolean) {
        this.toggleAttribute('inert', value);
    }

    /** 与 offsetHeight 同源:桩里不做边框/内边距区分. */
    get clientHeight(): number {
        return this.offsetHeight;
    }

    get clientWidth(): number {
        return this.offsetWidth;
    }

    /**
     * 由 offset* 派生的矩形:测试设定 offsetTop/offsetHeight 后,
     * "量高度"与"量矩形"两条路径读到的必然是同一份数据.
     */
    getBoundingClientRect(): {
        top: number;
        left: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
    } {
        const width = this.offsetWidth;
        const height = this.offsetHeight;
        return {
            top: this.offsetTop,
            left: 0,
            right: width,
            bottom: this.offsetTop + height,
            width,
            height,
        };
    }

    /** 指针捕获:真 DOM 里 pointerup 只在捕获元素上触发,桩按同一语义记录. */
    setPointerCapture(pointerId: number): void {
        this.capturedPointers.add(pointerId);
    }

    hasPointerCapture(pointerId: number): boolean {
        return this.capturedPointers.has(pointerId);
    }

    releasePointerCapture(pointerId: number): void {
        this.capturedPointers.delete(pointerId);
    }

    /** 离屏度量用的 2D 上下文桩:按字符数给一个稳定的宽度. */
    getContext(_kind: string): { font: string; measureText(text: string): { width: number } } {
        return {
            font: '',
            measureText: (text: string) => ({ width: text.length * 8 }),
        };
    }

    /** 旧版剪贴板回退路径用到的临时 textarea API. */
    select(): void {}

    focus(): void {}

    /** FormulaView 的模板缓存靠 cloneNode 复制模板,桩里做一次深拷贝. */
    cloneNode(deep?: boolean): StubElement {
        const copy = new StubElement(this.tagName);
        copy.className = this.className;
        copy.id = this.id;
        copy.htmlFor = this.htmlFor;
        copy.title = this.title;
        copy.tabIndex = this.tabIndex;
        copy.value = this.value;
        copy.type = this.type;
        copy.open = this.open;
        copy.disabled = this.disabled;
        Object.assign(copy.dataset, this.dataset);
        for (const [name, value] of this.attributes) copy.setAttribute(name, value);
        if (deep) {
            for (const child of this.children) {
                if (child instanceof StubElement) {
                    const childCopy = child.cloneNode(true);
                    childCopy.parent = copy;
                    copy.children.push(childCopy);
                } else {
                    // 真 DOM 克隆会生成新的文本节点,而不是复用同一个.
                    const textCopy = new StubText(child.data);
                    textCopy.parent = copy;
                    copy.children.push(textCopy);
                }
            }
        }
        // 真 DOM 里 textContent 与子节点是同一份数据;桩里若两者都写会翻倍,
        // 所以只在没有子节点时补文本.
        if (copy.children.length === 0) copy.textContent = this.textContent;
        return copy;
    }

    remove(): void {
        detachNode(this);
    }
}

export interface StubEvent {
    type: string;
    target: unknown;
    key: string;
    /** 事件时间戳(ms):窗口的"双击标题栏"判定要用两次按下的间隔. */
    timeStamp: number;
    ctrlKey: boolean;
    metaKey: boolean;
    clientX: number;
    clientY: number;
    /** 指针事件用:分隔条拖动靠它做 setPointerCapture/release. */
    pointerId: number;
    preventDefault(): void;
}

export class StubResizeObserver {
    private readonly targets: unknown[] = [];

    constructor(private readonly callback: () => void) {}

    observe(target: unknown): void {
        this.targets.push(target);
    }

    unobserve(target: unknown): void {
        const index = this.targets.indexOf(target);
        if (index >= 0) this.targets.splice(index, 1);
    }

    disconnect(): void {
        this.targets.length = 0;
    }

    /** 测试用:手动触发一次尺寸变化回调. */
    trigger(): void {
        this.callback();
    }
}

export interface DomStub {
    readonly document: StubDocument;
    readonly window: StubWindow;
    /** 本次安装后创建的 ResizeObserver(按创建顺序),测试可 trigger(). */
    readonly resizeObservers: StubResizeObserver[];
    /** 写入根元素的 CSS 变量(applyUiConfig/PanelController). */
    readonly rootVariables: Map<string, string>;
    /**
     * 执行过的 `document.execCommand`:命令名序列,每次调用的完整参数,
     * 以及可改写的返回值(测试用它模拟命令被拒绝).
     */
    readonly execCommand: { calls: string[]; args: unknown[][]; result: boolean };
    /**
     * 排队中的 `requestAnimationFrame` 回调数(测试用).
     *
     * rAF 在 Node 里不存在,但"把重绘合并到一帧"这类行为必须能断言 -- 只看
     * 排队数就能分辨"每次 input 都重排"与"同一帧只重排一次".
     */
    readonly pendingFrameCount: () => number;
    /** 执行当前排队的全部 rAF 回调(测试用;回调里新排的帧不在本次内). */
    flushFrames(): void;
}

export interface StubWindow {
    isSecureContext: boolean;
    addEventListener(
        type: string,
        handler: (event: StubEvent) => void,
        options?: { signal?: AbortSignal },
    ): void;
    removeEventListener(type: string, handler: (event: StubEvent) => void): void;
    /** 测试用:触发 window 上的监听(分隔条的拖动/收尾绑在这里). */
    dispatch(type: string, event?: Partial<StubEvent>): void;
    setTimeout(handler: () => void, delay?: number): number;
    clearTimeout(id: number): void;
}

export interface StubDocument {
    readonly documentElement: StubElement;
    readonly body: StubElement;
    createElement(tag: string): StubElement;
    createTextNode(text: string): StubText;
    createDocumentFragment(): StubElement;
    querySelector<T>(selector: string): T | null;
    querySelectorAll<T>(selector: string): T[];
    /**
     * 按 id 取节点.
     *
     * 窗口化按 `UI_CONFIG.window.windows[].hostId` 取正文宿主,用的就是它;
     * 桩里走与 `querySelector('#id')` 同一条遍历,语义一致.
     */
    getElementById<T>(id: string): T | null;
    /** document 级键盘监听(KeyboardController 的全局快捷键绑在这里). */
    addEventListener(type: string, handler: (event: StubEvent) => void): void;
    removeEventListener(type: string, handler: (event: StubEvent) => void): void;
    /** 测试用:触发 document 上的监听;真 DOM 的事件目标是当前聚焦元素. */
    dispatch(type: string, event?: Partial<StubEvent>): void;
}

/**
 * 安装一套全局 DOM 桩(每个用例调一次,得到一棵干净的空树).
 *
 * 默认把剪贴板路径设成非安全上下文,让 FormulaCopyController 走 legacy 回退,
 * 从而可在 node 里断言"复制成功/失败提示";需要异步剪贴板路径的用例可以自己
 * 覆盖 `window.isSecureContext` 与 `navigator.clipboard`.
 */
export function installDomStub(): DomStub {
    const documentElement = new StubElement('html');
    const body = new StubElement('body');
    documentElement.append(body);

    const selectAll = <T>(selector: string): T[] => {
        const found: StubElement[] = [];
        const walk = (node: StubElement): void => {
            if (matchesSelector(node, selector)) found.push(node);
            for (const child of node.children) {
                if (child instanceof StubElement) walk(child);
            }
        };
        walk(documentElement);
        return found as unknown as T[];
    };

    const documentListeners = new Map<string, Array<(event: StubEvent) => void>>();

    const document: StubDocument = {
        documentElement,
        body,
        createElement: (tag: string) => new StubElement(tag),
        createTextNode: (text: string) => new StubText(text),
        createDocumentFragment: () => new StubElement('#fragment'),
        querySelector: <T>(selector: string) => (selectAll<T>(selector)[0] ?? null),
        querySelectorAll: <T>(selector: string) => selectAll<T>(selector),
        getElementById: <T>(id: string) => (selectAll<T>(`#${id}`)[0] ?? null),
        addEventListener: (type, handler) => {
            const list = documentListeners.get(type) ?? [];
            list.push(handler);
            documentListeners.set(type, list);
        },
        removeEventListener: (type, handler) => {
            const list = documentListeners.get(type);
            const index = list?.indexOf(handler) ?? -1;
            if (index >= 0) list?.splice(index, 1);
        },
        dispatch: (type, event = {}) => {
            const full: StubEvent = {
                type,
                target: body,
                key: '',
                timeStamp: 0,
                ctrlKey: false,
                metaKey: false,
                clientX: 0,
                clientY: 0,
                pointerId: 0,
                preventDefault: () => {},
                ...event,
            };
            for (const handler of [...(documentListeners.get(type) ?? [])]) handler(full);
        },
    };

    const resizeObservers: StubResizeObserver[] = [];
    const rootVariables = new Map<string, string>();
    const execCommand = { calls: [] as string[], args: [] as unknown[][], result: true };

    // documentElement 上的变量写入便于断言 applyUiConfig 的默认目标.
    documentElement.style.setProperty = (name: string, value: string): void => {
        rootVariables.set(name, value);
    };

    const windowListeners = new Map<string, Array<(event: StubEvent) => void>>();
    const window: StubWindow = {
        isSecureContext: false,
        addEventListener: (type, handler, options) => {
            const signal = options?.signal;
            if (signal?.aborted) return;
            const list = windowListeners.get(type) ?? [];
            list.push(handler);
            windowListeners.set(type, list);
            signal?.addEventListener('abort', () => {
                const current = windowListeners.get(type);
                const index = current?.indexOf(handler) ?? -1;
                if (index >= 0) current?.splice(index, 1);
            });
        },
        removeEventListener: (type, handler) => {
            const list = windowListeners.get(type);
            const index = list?.indexOf(handler) ?? -1;
            if (index >= 0) list?.splice(index, 1);
        },
        dispatch: (type, event = {}) => {
            const full: StubEvent = {
                type,
                target: window,
                key: '',
                timeStamp: 0,
                ctrlKey: false,
                metaKey: false,
                clientX: 0,
                clientY: 0,
                pointerId: 0,
                preventDefault: () => {},
                ...event,
            };
            for (const handler of [...(windowListeners.get(type) ?? [])]) handler(full);
        },
        setTimeout: (handler: () => void, delay?: number) =>
            setTimeout(handler, delay) as unknown as number,
        clearTimeout: (id: number) => clearTimeout(id),
    };

    // Node 没有 requestAnimationFrame;DslApp 的渲染循环与 EditorHighlight 的
    // 重绘合并都依赖它,所以桩里必须有一份可控实现:注册即排队,由测试显式
    // flush,这样"合帧"是可断言的而不是靠时序猜.
    const frames = new Map<number, () => void>();
    let nextFrameId = 1;
    const requestFrame = (callback: () => void): number => {
        const id = nextFrameId;
        nextFrameId += 1;
        frames.set(id, callback);
        return id;
    };

    const globals = globalThis as unknown as Record<string, unknown>;
    globals.document = document;
    globals.Element = StubElement;
    globals.window = window;
    globals.requestAnimationFrame = requestFrame;
    globals.cancelAnimationFrame = (id: number): void => {
        frames.delete(id);
    };
    /**
     * 计算样式桩:只认**写在元素上的行内样式**.
     *
     * `fontSize`/`fontFamily` 给固定值(行号栏量槽宽用,不关心具体字号);
     * `cursor` 优先取元素自己的行内值 -- 真实标记里分隔条靠 CSS 类给出
     * `cursor: ns-resize` / `ew-resize`(见 css/layout.css),桩不解析样式表,
     * 所以需要断言光标的测试要像真标记那样把光标写在元素上(见
     * `RightSplitController.test.ts` 的 fixture).没有行内值时退回 `ew-resize`,
     * 与"面板宽度分隔条"这一默认场景一致.
     */
    globals.getComputedStyle = (element?: { style?: { cursor?: string } }) => ({
        fontSize: '16px',
        fontFamily: 'monospace',
        cursor: element?.style?.cursor || 'ew-resize',
    });
    globals.ResizeObserver = class extends StubResizeObserver {
        constructor(callback: () => void) {
            super(callback);
            resizeObservers.push(this);
        }
    };
    // Node 22 起 navigator 是可配置访问器;defineProperty 覆盖成"没有异步剪贴板".
    Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: undefined },
        configurable: true,
        writable: true,
    });
    (document as unknown as Record<string, unknown>).execCommand = (
        command: string,
        ...rest: unknown[]
    ) => {
        execCommand.calls.push(command);
        execCommand.args.push([command, ...rest]);
        return execCommand.result;
    };

    return {
        document,
        window,
        resizeObservers,
        rootVariables,
        execCommand,
        pendingFrameCount: () => frames.size,
        flushFrames: () => {
            // 先取出再执行:回调里新排的帧留到下一次 flush,与浏览器"一帧一次"一致.
            const due = [...frames.entries()];
            frames.clear();
            for (const [, callback] of due) callback();
        },
    };
}
