/**
 * 行与行内小件:把"文字 + 控件"的三种常见排布收成函数.
 *
 * 右面板的 `.point-row` / `.axis-row` / `.surface-row` 在 CSS 里是同一套规则
 * (`display:flex; align-items:center; gap:8px`),类名分开只是历史;这里按
 * 原类名参数化,视觉与原来完全一致,将来若要合并成 `.control-row`,只改调用
 * 点传的字符串即可.
 *
 * 可见文字一律做成 `<label for>` 而不是 `<span>`:
 * - `.xxx-row` 的字号/颜色是**继承**的,`<label>` 与 `<span>` 渲染无差别;
 * - 但 `<label for>` 把可访问名给了控件,点文字也能切换开关 -- 老写法里
 *   `#pointVisible` / `#axisLabelX` 这些控件一个可访问名都没有(UI-P3.1 的
 *   同类问题).
 *
 * 用这些件时,**控件不要再给 `aria-label`**:可见标签已经命名了它.
 */
import { el, type Child } from './dom';
import type { NumberFieldHandle } from './NumberField';
import type { SwitchHandle } from './Switch';

/**
 * 建一个与控件关联的可见标签.
 *
 * 关联走 `htmlFor` 属性(真 DOM 会把它反射成 `for` 属性),与
 * `ParamPanelController` 里的写法一致.
 */
export function createFieldLabel(text: string, forId: string): HTMLLabelElement {
    const label = el('label', { text });
    label.htmlFor = forId;
    return label;
}

/** 行容器:`<div class="point-row">...</div>`. */
export function createRow(className: string, ...children: Child[]): HTMLDivElement {
    return el('div', { class: className }, ...children);
}

/**
 * 一行"文字 + 开关":`<div class="point-row"><label for>文字</label>开关</div>`.
 *
 * 与原 HTML 的唯一差别是文字元素由 `<span>` 变成 `<label for>`(见文件头).
 */
export function createSwitchRow(
    className: string,
    text: string,
    toggle: SwitchHandle,
): HTMLDivElement {
    return createRow(className, createFieldLabel(text, toggle.input.id), toggle.element);
}

/**
 * 一行"文字 + 数字":数字框沿用 CSS 的 `margin-left:auto` 贴右.
 *
 * 返回标签节点是因为"点"那一行的文字要随模式改(大小 / 缩放),
 * 调用方拿到它即可改文案,不必再按 id 去查.
 */
export function createNumberRow(
    className: string,
    text: string,
    field: NumberFieldHandle,
): { row: HTMLDivElement; label: HTMLLabelElement } {
    const label = createFieldLabel(text, field.input.id);
    const row = createRow(className, label, field.element);
    return { row, label };
}

/** 行内小开关组(`.axis-switch-group`):用于"标签 X/Y/Z"与"网格 XZ/XY/YZ". */
export function createInlineToggle(text: string, toggle: SwitchHandle): HTMLDivElement {
    return el(
        'div',
        { class: 'axis-switch-group' },
        createFieldLabel(text, toggle.input.id),
        toggle.element,
    );
}
