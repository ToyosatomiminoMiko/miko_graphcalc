/**
 * 行 DOM 的通用件:实体列表与求值列表共用的最小词表.
 *
 * 只有三件真正与"哪一栏"无关的东西放这里:
 * - {@link createElement}:轻量建元素,避免每处三行样板;
 * - {@link createVisibilityButton}:行首**显隐按钮**(业务动作:不渲染 +
 *   不参与计算),实体 item 与求值 item 用的是同一个;
 * - {@link carryDetailsOpen}:行被替换时带走 `<details>` 展开态,
 *   由 `EvaluationItem.preserveExpandedStateFrom` 调用(实体行将来有展开态
 *   也直接复用它).
 *
 * 两类按钮分工明确,不要混在一起:
 * - **开合**由 `<details>/<summary>` 原生行为承担,行里没有自建开合按钮;
 * - **显隐切换**是业务动作,由 {@link createVisibilityButton} 生成,挂在行
 *   (`<article>`)上,是行内容块(实体行的名称行/公式,求值行的摘要/折叠区)的
 *   **同级兄弟**,**不在 `<summary>` 里**--点它不会连带开合细节,
 *   也不需要 stopPropagation.
 *
 * 求值行自己的骨架(摘要/细节/结果行怎么拼)不在这里,见
 * `evaluation/evaluationDom.ts`.
 */

/** 轻量建元素:属性只有 class 与文本,避免每处三行样板. */
export function createElement(
    tag: string,
    className?: string,
    text?: string,
): HTMLElement {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

/**
 * 行首显隐按钮:切换该对象"是否参与三维渲染与数值计算".
 *
 * 这不是折叠按钮(开合交给 `<summary>`),点它的语义是业务动作:
 * - 文案给**下一步动作**(可见时"隐藏",已隐藏时"显示"),状态本身由行上的
 *   `is-hidden` 与"已隐藏"文字承担;
 * - `aria-label` 带上对象名,读屏不必靠上下文猜操作的是哪一条;
 * - 挂在行(`<article>`)上,与行内容块同级,不在 `<summary>` 里,
 *   因此点按钮只切换显隐,不会顺手开合细节.
 */
export function createVisibilityButton(
    enabled: boolean,
    label: string,
    onToggle: () => void,
): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'row-visibility-btn';
    button.textContent = enabled ? '隐藏' : '显示';
    button.setAttribute('aria-label', `${enabled ? '隐藏' : '显示'} ${label}`);
    button.addEventListener('click', onToggle);
    return button;
}

/**
 * 行被替换时把 `<details>` 的展开态带到新行上.
 *
 * 内容变化必然重建行,但"用户把它展开了"这件事与内容无关,不该在拖动滑块时
 * 被每帧重置.
 */
export function carryDetailsOpen(from: HTMLElement, to: HTMLElement): void {
    const before = from.querySelector<HTMLDetailsElement>('details');
    if (before === null) return;
    const after = to.querySelector<HTMLDetailsElement>('details');
    if (after !== null) after.open = before.open;
}
