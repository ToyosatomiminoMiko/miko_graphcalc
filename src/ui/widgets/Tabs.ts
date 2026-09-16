/**
 * 标签页控件(`role="tablist"` + `role="tab"`).
 *
 * 与 `Segmented` 的区别是**语义**,不是外观:后者是"切换按钮组"
 * (`role="group"` + `aria-pressed`,每个按钮都能 Tab 到);标签页的键盘约定是
 * "整组一个 Tab 停靠点 + 方向键在组内移动 + `aria-selected` + `aria-controls`
 * + roving tabindex".强行复用会把读屏与键盘行为做成四不像,所以这里新写一份
 * (见 docs/equation-solving-process.md 第 3.1 节),样式仍归 CSS.
 *
 * 契约与其他控件一致:`element` / `get` / `onChange` / `dispose`.
 *
 * 每对 (tab, panel) 的 id 由 `panelId(value)` 决定:
 * - tab 按钮 id 固定为 `${panelId}-tab`;
 * - 构造时把这些 id 写进按钮的 `aria-controls` 与面板的 `aria-labelledby`.
 * **面板的显隐不归本控件管**:它由持有"当前页"这个业务状态的控制器写入
 * (右栏是 `RightPanelTabs`),避免同一件事有两个写入点.
 *
 * 方向键在本元素上监听(与分隔条同一种"组件自带方向键语义"的做法,见
 * `RightSplitController`),不是全局 `document` 监听--全局键盘出口仍然只有
 * `KeyboardController` 一处.
 */
import { el } from './dom';

export interface TabItem<T extends string> {
    readonly value: T;
    readonly label: string;
    /** 该标签对应的面板元素 id,用于 `aria-controls` / `aria-labelledby`. */
    readonly panelId: string;
}

export interface TabsOptions<T extends string> {
    /** 组名:一组标签必须能被读屏当成一个整体念出来. */
    readonly ariaLabel: string;
    /** 初值;应当出现在 `items` 里,否则开局没有任何标签是选中的. */
    readonly value: T;
    readonly items: readonly TabItem<T>[];
}

export interface TabsHandle<T extends string> {
    /** 根节点(`role="tablist"`),插到标题栏里用这个. */
    readonly element: HTMLDivElement;
    get(): T;
    /**
     * 以编程方式选中一个标签(与点击同一条写入路径,会触发 `onChange`).
     *
     * 入口点击"过程"要把右栏切到过程页,走的就是这里,而不是让调用方自己
     * 改按钮的 `aria-selected`/`tabIndex`--那样状态就有了第二个写入点.
     */
    select(value: T): void;
    /** 注册选中回调;返回退订函数.命中已选项时不回调. */
    onChange(listener: (value: T) => void): () => void;
    dispose(): void;
}

/** 水平标签页用左右方向键;上下键一并接受,方便把标签竖排时行为不变. */
const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown']);
const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp']);

export function createTabs<T extends string>(options: TabsOptions<T>): TabsHandle<T> {
    const abort = new AbortController();
    const listeners = new Set<(value: T) => void>();
    const buttons: Array<{ value: T; element: HTMLButtonElement }> = [];
    let current = options.value;

    const element = el('div', {
        class: 'tabs',
        attrs: { role: 'tablist', 'aria-label': options.ariaLabel },
    });

    /**
     * 唯一的高亮/可访问态写入点:由 `current` 推导.
     *
     * roving tabindex:只有选中的标签 `tabIndex = 0`(整组一个 Tab 停靠点),
     * 其余为 -1,方向键在组内移动--这正是"标签页"与"按钮组"的键盘差别.
     */
    const sync = (): void => {
        for (const button of buttons) {
            const selected = button.value === current;
            button.element.classList.toggle('active', selected);
            button.element.setAttribute('aria-selected', String(selected));
            button.element.tabIndex = selected ? 0 : -1;
        }
    };

    const select = (value: T, focus: boolean): void => {
        const changed = value !== current;
        current = value;
        sync();
        if (focus) {
            buttons.find((button) => button.value === value)?.element.focus();
        }
        if (!changed) return;
        for (const listener of [...listeners]) listener(value);
    };

    for (const item of options.items) {
        const button = el('button', { class: 'tab', text: item.label });
        button.type = 'button';
        // 契约:id 由面板 id 派生,`aria-controls` 指向面板,面板反向引用它.
        button.id = `${item.panelId}-tab`;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', item.panelId);
        button.addEventListener('click', () => select(item.value, false), {
            signal: abort.signal,
        });
        buttons.push({ value: item.value, element: button });
        element.append(button);

        // 面板反向引用标签:读屏进面板时能报出它属于哪个标签.
        // 用 querySelector 而不是 getElementById:测试用的最小 DOM 桩实现了
        // 选择器查询,不需要为这一个调用点再补一个 API.
        document.querySelector<HTMLElement>(`#${item.panelId}`)
            ?.setAttribute('aria-labelledby', button.id);
    }

    sync();

    element.addEventListener('keydown', (event: KeyboardEvent) => {
        const index = buttons.findIndex((button) => button.value === current);
        if (index < 0) return;
        let nextIndex: number | null = null;
        if (NEXT_KEYS.has(event.key)) {
            nextIndex = (index + 1) % buttons.length;
        } else if (PREV_KEYS.has(event.key)) {
            nextIndex = (index - 1 + buttons.length) % buttons.length;
        } else if (event.key === 'Home') {
            nextIndex = 0;
        } else if (event.key === 'End') {
            nextIndex = buttons.length - 1;
        }
        if (nextIndex === null) return;
        event.preventDefault();
        select(buttons[nextIndex].value, true);
    }, { signal: abort.signal });

    return {
        element,
        get: () => current,
        select: (value) => select(value, false),
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        dispose() {
            abort.abort();
            listeners.clear();
        },
    };
}
