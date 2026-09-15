/**
 * 滑块控件(`<input type="range">`).
 *
 * 目前的使用者是参数面板(参数行的"大热区");它与数字框是同一状态的两个
 * 显示入口:滑块是粗调,数字框是精调,写值收口在调用方(见
 * `ParamPanelController.writeValue`),控件本身只报"用户拖到多少".
 *
 * 产出的结构与原手写 HTML 一致(`<input type="range" min max step>`),
 * 样式由调用方所在的容器类(`.param-row`)提供,控件不引入新类名.
 */
import { el, nextWidgetId } from './dom';

export interface SliderOptions {
    value: number;
    min: number;
    max: number;
    step: number;
    /**
     * 可访问名.参数行里不用它:可见 `<label for>` 已经命名了滑块,
     * 再给 `aria-label` 会念两遍(见 `SwitchOptions.ariaLabel` 的同类说明).
     */
    ariaLabel?: string;
}

export interface SliderHandle {
    readonly element: HTMLInputElement;
    readonly input: HTMLInputElement;
    get(): number;
    /** 程序化写值;不触发 `onInput`(那是用户拖动的语义). */
    set(value: number): void;
    /** 注册拖动回调;返回退订函数. */
    onInput(listener: (value: number) => void): () => void;
    dispose(): void;
}

export function createSlider(options: SliderOptions): SliderHandle {
    const input = el('input');
    input.type = 'range';
    input.id = nextWidgetId('slider');
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step);
    input.value = String(options.value);
    if (options.ariaLabel !== undefined) {
        input.setAttribute('aria-label', options.ariaLabel);
    }

    const listeners = new Set<(value: number) => void>();
    const abort = new AbortController();
    input.addEventListener('input', () => {
        const value = Number(input.value);
        for (const listener of [...listeners]) listener(value);
    }, { signal: abort.signal });

    return {
        element: input,
        input,
        get: () => Number(input.value),
        set: (value) => {
            input.value = String(value);
        },
        onInput(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        dispose() {
            abort.abort();
            listeners.clear();
        },
    };
}
