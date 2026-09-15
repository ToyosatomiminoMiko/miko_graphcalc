/**
 * 按钮控件(`<button type="button">`).
 *
 * 页面上的按钮现在有三类:参数行的重置(↺),对象行的显隐(隐藏/显示),以及
 * 将来还会有的动作按钮.它们共同的部分是:永远是 `type="button"`(不该在
 * 任何地方触发表单提交),有独立的可访问名,可置灰,文案会变 -- 这些收在这里.
 *
 * 与 `Switch` / `Segmented` 一致:选项只描述**外观**,点击回调在拿到句柄后
 * 用 `onClick(listener)` 注册.这样"建控件"与"接线"分开,回调也能引用尚未
 * 定义的闭包(如参数行里互相依赖的写值函数).
 *
 * 类名由调用方给(`param-reset-btn` / `row-visibility-btn`),样式仍归 CSS.
 */
import { el } from './dom';

export interface ButtonOptions {
    text: string;
    /** 样式类名;沿用现有 CSS(`.param-reset-btn` / `.row-visibility-btn` ...). */
    class?: string;
    ariaLabel?: string;
    title?: string;
    disabled?: boolean;
}

export interface ButtonHandle {
    readonly element: HTMLButtonElement;
    /** 注册点击回调;返回退订函数. */
    onClick(listener: () => void): () => void;
    setText(text: string): void;
    setDisabled(disabled: boolean): void;
    dispose(): void;
}

export function createButton(options: ButtonOptions): ButtonHandle {
    const element = el('button', { class: options.class, text: options.text });
    // 页面上没有表单,但显式声明 type 才不会在将来被塞进 <form> 时变成提交按钮
    element.type = 'button';
    if (options.ariaLabel !== undefined) {
        element.setAttribute('aria-label', options.ariaLabel);
    }
    if (options.title !== undefined) element.title = options.title;
    element.disabled = options.disabled ?? false;

    const listeners = new Set<() => void>();
    const abort = new AbortController();
    element.addEventListener('click', () => {
        for (const listener of [...listeners]) listener();
    }, { signal: abort.signal });

    return {
        element,
        onClick(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        setText: (text) => {
            element.textContent = text;
        },
        setDisabled: (disabled) => {
            element.disabled = disabled;
        },
        dispose() {
            abort.abort();
            listeners.clear();
        },
    };
}
