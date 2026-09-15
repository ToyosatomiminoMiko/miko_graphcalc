/**
 * 开关控件(右侧"视图"面板里所有复选框的统一件).
 *
 * 产出的 DOM 与原来的手写 HTML 逐字同构,直接复用 `css/controls.css` 的
 * `.switch` / `.slider`:
 *
 * ```html
 * <label class="switch">
 *   <input type="checkbox" id="ui-switch-1" aria-label="...">
 *   <span class="slider"></span>
 * </label>
 * ```
 *
 * 状态归属:控件自己持有勾选态(`input.checked` 就是状态),`get()` 读它,
 * `set()` 程序化写它,`onChange` 通知外部.外部(控制器)**不反向持有**一份
 * 布尔值再同步回来 -- 那正是"两个状态源"的老问题;控制器只在需要按配置
 * 打初值时 `set()` 一次.
 */
import { el, nextWidgetId } from './dom';

export interface SwitchOptions {
    /** 初值. */
    value: boolean;
    /**
     * 可访问名.
     *
     * 用 {@link createSwitchRow} / {@link createInlineToggle} 放进带可见
     * `<label for>` 的行里时**必须省略**:可见标签已经命名了控件,再给
     * `aria-label` 会让读屏把名字念两遍.
     */
    ariaLabel?: string;
}

/** 开关句柄:外部只认它,不再按 id 去 document 里找节点. */
export interface SwitchHandle {
    /** 根节点(`<label class="switch">`),插到行里用这个. */
    readonly element: HTMLLabelElement;
    /** 原生复选框:标签关联,`step` 之类的细粒度写入才用它. */
    readonly input: HTMLInputElement;
    get(): boolean;
    /** 程序化写值;不触发 `onChange`(那是用户操作的语义). */
    set(value: boolean): void;
    /** 注册用户切换回调;返回退订函数. */
    onChange(listener: (value: boolean) => void): () => void;
    /** 解绑 DOM 监听并清空订阅者. */
    dispose(): void;
}

export function createSwitch(options: SwitchOptions): SwitchHandle {
    const input = el('input');
    input.type = 'checkbox';
    input.id = nextWidgetId('switch');
    input.checked = options.value;
    if (options.ariaLabel !== undefined) {
        input.setAttribute('aria-label', options.ariaLabel);
    }

    const element = el(
        'label',
        { class: 'switch' },
        input,
        el('span', { class: 'slider' }),
    );

    const listeners = new Set<(value: boolean) => void>();
    const abort = new AbortController();
    input.addEventListener('change', () => {
        for (const listener of [...listeners]) listener(input.checked);
    }, { signal: abort.signal });

    return {
        element,
        input,
        get: () => input.checked,
        set: (value) => {
            input.checked = value;
        },
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
