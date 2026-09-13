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

/** 元素的行内样式:只实现控制器用到的显示/光标/变换与 CSS 变量写入. */
export class StubStyle {
    display = '';
    cursor = '';
    transform = '';
    private readonly properties = new Map<string, string>();

    setProperty(name: string, value: string): void {
        this.properties.set(name, value);
    }

    getPropertyValue(name: string): string {
        return this.properties.get(name) ?? '';
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

/** `querySelector` 支持的选择器:`tag` / `.class` / `#id` / `[attr]` / `[attr=value]`. */
function matchesSelector(element: StubElement, selector: string): boolean {
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

/** `dataset` 的 camelCase 属性名 <-> `data-*` 属性名. */
function dataAttributeName(property: string): string {
    return `data-${property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

export class StubElement {
    className = '';
    id = '';
    htmlFor = '';
    title = '';
    tabIndex = -1;
    value = '';
    type = '';
    min = '';
    max = '';
    step = '';
    scrollTop = 0;
    checked = false;
    /** `<details>` 的开合状态;普通元素上无意义. */
    open = false;
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
            ctrlKey: false,
            metaKey: false,
            clientX: 0,
            clientY: 0,
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
    ctrlKey: boolean;
    metaKey: boolean;
    clientX: number;
    clientY: number;
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
    /** 执行过的 legacy 复制命令数,以及可改写的返回值. */
    readonly execCommand: { calls: string[]; result: boolean };
}

export interface StubWindow {
    isSecureContext: boolean;
    addEventListener(type: string, handler: unknown, options?: unknown): void;
    removeEventListener(type: string, handler: unknown): void;
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

    const document: StubDocument = {
        documentElement,
        body,
        createElement: (tag: string) => new StubElement(tag),
        createTextNode: (text: string) => new StubText(text),
        createDocumentFragment: () => new StubElement('#fragment'),
        querySelector: <T>(selector: string) => (selectAll<T>(selector)[0] ?? null),
        querySelectorAll: <T>(selector: string) => selectAll<T>(selector),
    };

    const resizeObservers: StubResizeObserver[] = [];
    const rootVariables = new Map<string, string>();
    const execCommand = { calls: [] as string[], result: true };

    // documentElement 上的变量写入便于断言 applyUiConfig 的默认目标.
    documentElement.style.setProperty = (name: string, value: string): void => {
        rootVariables.set(name, value);
    };

    const window: StubWindow = {
        isSecureContext: false,
        addEventListener: () => {},
        removeEventListener: () => {},
        setTimeout: (handler: () => void, delay?: number) =>
            setTimeout(handler, delay) as unknown as number,
        clearTimeout: (id: number) => clearTimeout(id),
    };

    const globals = globalThis as unknown as Record<string, unknown>;
    globals.document = document;
    globals.Element = StubElement;
    globals.window = window;
    globals.getComputedStyle = () => ({
        fontSize: '16px',
        fontFamily: 'monospace',
        cursor: 'ew-resize',
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
    (document as unknown as Record<string, unknown>).execCommand = (command: string) => {
        execCommand.calls.push(command);
        return execCommand.result;
    };

    return { document, window, resizeObservers, rootVariables, execCommand };
}
