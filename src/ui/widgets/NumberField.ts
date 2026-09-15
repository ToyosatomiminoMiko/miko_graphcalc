/**
 * 数字输入控件(右侧"视图"面板里所有 `<input type="number">` 的统一件).
 *
 * 覆盖四处:点的"大小/缩放",坐标轴"线宽","大刻度线宽","小刻度线宽".
 *
 * 控件只负责"读文本 / 写文本 / 通知",**不替调用方决定非法输入怎么办** --
 * 那正是老代码三份实现分歧的地方:
 * - `AxisLineWidthController` / `GridTicksController` / `PointStyleController`:
 *   `input` 阶段解析不出数就立刻把文本回填成上一个合法值(用户打不出中途态);
 * - `ParamPanelController`:反过来,`input` 阶段保留用户文本,只在 `change`
 *   归一化后写回(否则空串与 `0.` 都会被 `Number()` 吞成 0,见 UI-P2.1).
 *
 * 两种策略都实现得了,由调用方在 `onInput` 里选择:解析失败时回调收到
 * `null`,想即时回退就调 `write(上一个合法值)`,想保留文本就什么都不做.
 *
 * `parse` / `format` 也交给调用方:点的数字显示要走 `toFixed(4)` 的口径,
 * 参数行要做区间夹取/圆周回绕,控件不预设任何一种.
 */
import { el, nextWidgetId } from './dom';

export interface NumberFieldOptions {
    value: number;
    min?: number;
    max?: number;
    step?: number;
    /**
     * 可访问名.放进带可见 `<label for>` 的行里时省略(见 `SwitchOptions`).
     */
    ariaLabel?: string;
    /** 值 -> 文本;默认 `String()`.写回时用. */
    format?(value: number): string;
    /** 文本 -> 值;默认 trim 后 `Number.isFinite` 校验.返回 null 表示不可解析. */
    parse?(text: string): number | null;
}

/** 数字框句柄:行里插入 `element`(就是那个 `<input>`). */
export interface NumberFieldHandle {
    readonly element: HTMLInputElement;
    readonly input: HTMLInputElement;
    /** 当前文本解析出的值;空串/中途态(`-` / `1e` / `0.`)为 null. */
    read(): number | null;
    /** 当前原始文本;需要比对"文本是否被改过"时(如参数行重置按钮)用它. */
    readText(): string;
    /** 按 `format` 写回文本并更新值. */
    write(value: number): void;
    /** 原样写文本(不做 `format`). */
    writeText(text: string): void;
    /** `input` 阶段(每次按键);参数已按 `parse` 解析,失败为 null. */
    onInput(listener: (value: number | null) => void): () => void;
    /** 原生 `change`(失焦/回车);参数同上,控件在该阶段也不改写文本. */
    onCommit(listener: (value: number | null) => void): () => void;
    dispose(): void;
}

/** 默认解析:`Number('') === 0`,所以空串必须显式判掉. */
function defaultParse(text: string): number | null {
    const trimmed = text.trim();
    if (trimmed === '') return null;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : null;
}

export function createNumberField(options: NumberFieldOptions): NumberFieldHandle {
    const format = options.format ?? ((value: number) => String(value));
    const parse = options.parse ?? defaultParse;

    const input = el('input');
    input.type = 'number';
    input.id = nextWidgetId('number');
    if (options.min !== undefined) input.min = String(options.min);
    if (options.max !== undefined) input.max = String(options.max);
    if (options.step !== undefined) input.step = String(options.step);
    if (options.ariaLabel !== undefined) {
        input.setAttribute('aria-label', options.ariaLabel);
    }
    input.value = format(options.value);

    const inputListeners = new Set<(value: number | null) => void>();
    const commitListeners = new Set<(value: number | null) => void>();
    const abort = new AbortController();

    const notify = (
        listeners: Set<(value: number | null) => void>,
        value: number | null,
    ): void => {
        for (const listener of [...listeners]) listener(value);
    };

    input.addEventListener('input', () => {
        notify(inputListeners, parse(input.value));
    }, { signal: abort.signal });
    input.addEventListener('change', () => {
        notify(commitListeners, parse(input.value));
    }, { signal: abort.signal });

    return {
        element: input,
        input,
        read: () => parse(input.value),
        readText: () => input.value,
        write: (value) => {
            input.value = format(value);
        },
        writeText: (text) => {
            input.value = text;
        },
        onInput(listener) {
            inputListeners.add(listener);
            return () => inputListeners.delete(listener);
        },
        onCommit(listener) {
            commitListeners.add(listener);
            return () => commitListeners.delete(listener);
        },
        dispose() {
            abort.abort();
            inputListeners.clear();
            commitListeners.clear();
        },
    };
}
