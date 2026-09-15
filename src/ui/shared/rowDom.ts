/**
 * 行 DOM 的通用件:实体列表与求值列表共用的最小词表.
 *
 * 建元素本身不在这里了 -- 统一走 `ui/widgets/dom.ts` 的 {@link el},与视图面板
 * 的控件同一套原语(实体/求值 item 的调用点已直接用 `el`).这里只剩两栏真正
 * 共用的**行结构**:
 *
 * - {@link createObjectRow}:行外壳(`<article>` + `.row-main` + 行末显隐按钮),
 *   实体 item 与求值 item 用的是同一个;
 * - {@link createVisibilityButton}:行末**显隐按钮**(业务动作:不渲染 +
 *   不参与计算),实体 item 与求值 item 用的是同一个;
 * - {@link carryDetailsOpen}:行被替换时带走 `<details>` 展开态,
 *   由 `EvaluationItem.preserveExpandedStateFrom` 调用(实体行将来有展开态
 *   也直接复用它).
 *
 * 两类按钮分工明确,不要混在一起:
 * - **开合**由 `<details>/<summary>` 原生行为承担,行里没有自建开合按钮;
 * - **显隐切换**是业务动作,由 {@link createVisibilityButton} 生成,由
 *   {@link createObjectRow} 挂在行(`<article>`)的**末位**,与主内容包装
 *   `.row-main` 平级,**不在 `<summary>` 里**--点它不会连带开合细节,
 *   也不需要 stopPropagation.
 *
 * 求值行自己的骨架(摘要/细节/结果行怎么拼)不在这里,见
 * `evaluation/evaluationDom.ts`.
 */
import { createButton } from '../widgets/Button';
import { el } from '../widgets/dom';

/**
 * 行外壳:`<article class="object-row <rowClass>">`,内容分两层.
 *
 * ```text
 * <article class="object-row entity-row" role="listitem">
 *   <div class="row-main">...</div>          ← 除显隐按钮外的全部内容
 *   <button class="row-visibility-btn">...</button>  ← 行末,靠右
 * </article>
 * ```
 *
 * 为什么要有 `.row-main` 这层包装:显隐按钮要**贴右**,而一行里除它以外的
 * 内容(实体行是"徽章 + 颜色 + 名称行 + 公式",求值行是"摘要 + 折叠区 +
 * 结果行")本身还要横向排列/换行.把内容收进一个 `flex: 1` 的包装层后,行的
 * 直接子节点只剩"主内容 + 按钮"两个:
 * - 按钮在 DOM 里就是**最后一个**直接子节点(不做 `order` 之类的视觉错位,
 *   读屏/键盘顺序与视觉一致);
 * - 主内容吃掉剩余宽度,按钮自然被推到右端;
 * - 按钮与 `.row-main` 平级,因此仍在 `<summary>` 之外,点它只切换显隐.
 *
 * `toggle` 为 null(调用方不需要显隐入口)时不挂按钮,`.row-main` 独占整行.
 */
export function createObjectRow(
    rowClass: string,
    toggle: HTMLElement | null,
): { readonly row: HTMLElement; readonly main: HTMLElement } {
    const row = el('article', { class: `object-row ${rowClass}` });
    row.setAttribute('role', 'listitem');
    const main = el('div', { class: 'row-main' });
    row.append(main);
    if (toggle !== null) row.append(toggle);
    return { row, main };
}

/**
 * 显隐按钮:切换该对象"是否参与三维渲染与数值计算".
 *
 * 这不是折叠按钮(开合交给 `<summary>`),点它的语义是业务动作:
 * - 文案给**下一步动作**(可见时"隐藏",已隐藏时"显示"),状态本身由行上的
 *   `is-hidden` 与"已隐藏"文字承担;
 * - `aria-label` 带上对象名,读屏不必靠上下文猜操作的是哪一条;
 * - 由 {@link createObjectRow} 挂在行(`<article>`)末位,与 `.row-main` 同级,
 *   不在 `<summary>` 里,因此点按钮只切换显隐,不会顺手开合细节.
 *
 * 每次重建行都会新建一个按钮(列表按内容键复用/替换整行),它随被丢弃的行
 * 一起消失,所以这里只返回元素,不返回句柄 -- 生命周期跟行绑定,没有需要
 * 单独 `dispose` 的持有者.
 */
export function createVisibilityButton(
    enabled: boolean,
    label: string,
    onToggle: () => void,
): HTMLButtonElement {
    const action = enabled ? '隐藏' : '显示';
    const button = createButton({
        class: 'row-visibility-btn',
        text: action,
        ariaLabel: `${action} ${label}`,
    });
    button.onClick(onToggle);
    return button.element;
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
