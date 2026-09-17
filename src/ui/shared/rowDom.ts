/**
 * 行 DOM 的通用件:实体列表与求值列表共用的最小词表.
 *
 * 建元素本身不在这里了 -- 统一走 `ui/widgets/dom.ts` 的 {@link el},与视图面板
 * 的控件同一套原语(实体/求值 item 的调用点已直接用 `el`).这里只剩两栏真正
 * 共用的**行结构**:
 *
 * - {@link createObjectRow}:行外壳(`<article>` + `.row-main` + 行末动作容器),
 *   实体 item 与求值 item 用的是同一个;
 * - {@link createRowActions}:行末动作容器(显隐按钮 + 将来的"过程"等动作);
 * - {@link createVisibilityButton}:行末**显隐按钮**(业务动作:不渲染 +
 *   不参与计算),实体 item 与求值 item 用的是同一个;
 * - {@link carryDetailsOpen}:行被替换时带走 `<details>` 展开态,
 *   由 `EvaluationItem.preserveExpandedStateFrom` 调用(实体行将来有展开态
 *   也直接复用它).
 *
 * 两类按钮分工明确,不要混在一起:
 * - **开合**由 `<details>/<summary>` 原生行为承担,行里没有自建开合按钮;
 * - **显隐切换**是业务动作,由 {@link createVisibilityButton} 生成,与"过程"等
 *   其它动作一起放进 {@link createRowActions} 容器,挂在行(`<article>`)的
 *   **末位**,与主内容包装 `.row-main` 平级,**不在 `<summary>` 里**--点它不会
 *   连带开合细节,也不需要 stopPropagation.
 *
 * 求值行自己的骨架(摘要/细节/结果行怎么拼)不在这里,见
 * `evaluation/evaluationDom.ts`.
 */
import { createButton } from '@/ui/widgets/Button';
import { el } from '@/ui/widgets/dom';

/**
 * 行外壳:`<article class="object-row <rowClass>">`,内容分两层.
 *
 * ```text
 * <article class="object-row entity-row" role="listitem">
 *   <div class="row-main">...</div>          ← 除行末动作外的全部内容
 *   <div class="row-actions">                ← 行末,靠右
 *     <button class="row-process-btn">过程</button>
 *     <button class="row-visibility-btn">...</button>
 *   </div>
 * </article>
 * ```
 *
 * 为什么要有 `.row-main` 这层包装:动作区要**贴右**,而一行里除它以外的
 * 内容(实体行是"徽章 + 颜色 + 名称行 + 公式",求值行是"摘要 + 折叠区 +
 * 结果行")本身还要横向排列/换行.把内容收进一个 `flex: 1` 的包装层后,行的
 * 直接子节点只剩"主内容 + 动作"两个:
 * - 动作容器在 DOM 里就是**最后一个**直接子节点(不做 `order` 之类的视觉错位,
 *   读屏/键盘顺序与视觉一致);
 * - 主内容吃掉剩余宽度,动作区自然被推到右端;
 * - 动作容器与 `.row-main` 平级,因此仍在 `<summary>` 之外,点按钮只触发动作.
 *
 * 动作容器由 {@link createRowActions} 生成;`actions` 为 null(调用方不需要任何
 * 行末动作)时不挂容器,`.row-main` 独占整行.
 */
export function createObjectRow(
    rowClass: string,
    actions: HTMLElement | null,
): { readonly row: HTMLElement; readonly main: HTMLElement } {
    const row = el('article', { class: `object-row ${rowClass}` });
    row.setAttribute('role', 'listitem');
    const main = el('div', { class: 'row-main' });
    row.append(main);
    if (actions !== null) row.append(actions);
    return { row, main };
}

/**
 * 行末动作容器:把一行里除主内容外的全部动作(显隐,"过程"...)收成**一个**
 * 直接子节点.
 *
 * 为什么不是"再来一个按钮兄弟":`createObjectRow` 的骨架是"主内容 + 行末动作",
 * 直接子节点数量稳定成两个,按钮贴右靠的是 `.row-main` 的 `flex:1`,不需要为
 * 每多一个按钮就调一次行布局.空动作(null/false)直接跳过,便于在声明里写
 * `cond && button`.
 *
 * 容器内的顺序就是视觉顺序:显隐按钮**最后**放,保持"显隐按钮仍在行末"这条
 * 既有位置语义.
 */
export function createRowActions(
    ...actions: Array<HTMLElement | null | false | undefined>
): HTMLElement {
    const container = el('div', { class: 'row-actions' });
    for (const action of actions) {
        if (action) container.append(action);
    }
    return container;
}

/**
 * 显隐按钮:切换该对象"是否参与三维渲染与数值计算".
 *
 * 这不是折叠按钮(开合交给 `<summary>`),点它的语义是业务动作:
 * - 文案给**下一步动作**(可见时"隐藏",已隐藏时"显示"),状态本身由行上的
 *   `is-hidden` 与"已隐藏"文字承担;
 * - `aria-label` 带上对象名,读屏不必靠上下文猜操作的是哪一条;
 * - 由 {@link createRowActions} 放进行末动作容器(**最后一位**),与主内容包装
 *   `.row-main` 同级,不在 `<summary>` 里,因此点按钮只切换显隐,不会顺手开合细节.
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
