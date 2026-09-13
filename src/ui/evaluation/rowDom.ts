/**
 * 求值条目的 DOM 外壳(与具体类型无关).
 *
 * 三类求值对象(分析/积分/求交)共用同一副骨架,差异由各类型 spec 的
 * `build` 决定往里面放什么:
 *
 * ```text
 * <article class="object-row evaluation-row" role="listitem">
 *   <button class="row-visibility-btn">隐藏/显示</button>  ← 显隐(不在 summary 里)
 *   <div class="object-main">
 *     <summary class="eval-summary">...badge + 变量名 + 一行公式...</summary>
 *     │  (无展开细节时 summary 直接放在 main 里)
 *     或
 *     <details class="eval-details" open=false>
 *       <summary class="eval-summary">...</summary>
 *       <div class="eval-detail-body">        ← 公式块:数学内容 + 结果行
 *         <span class="eval-detail-line">...</span>
 *       </div>
 *       <div class="eval-detail-meta-block"> ← 纯文本元信息块(公式块之外)
 *         <div class="eval-detail-meta">域: ... · 方法: ...</div>
 *       </div>
 *     </details>
 *   </div>
 * </article>
 * ```
 *
 * 行类型由 `EvaluationDetailLine` 判别:`latex` -> 公式行(可点击复制),
 * `text` -> 元信息行.哪些行走公式,哪些行走元信息完全由各类型的细节
 * 生成函数决定(`dsl/evaluationLatex.ts`).
 *
 * 两类按钮分工明确,不要混在一起:
 * - **开合**由 `<details>/<summary>` 原生行为承担,行里没有自建开合按钮;
 * - **显隐切换**是业务动作(不渲染 + 不参与计算),由 {@link createVisibilityButton}
 *   生成的按钮承担,并且挂在行(`<article>`)上,是 `.object-main` 的兄弟,
 *   **不在 `<summary>` 里**--点它不会连带开合细节,也不需要 stopPropagation.
 */
import { createFormulaElement } from '../FormulaView';
import type { EvaluationDetailLine } from '../../compiler/dsl/evaluationLatex';
import type {
    EvaluationResultSpec,
    EvaluationSummarySpec,
} from './rowTypes';

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
 * - 挂在行(`<article>`)上,与 `.object-main` 平级,不在 `<summary>` 里,
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
 * 展开细节里的两组行:公式块与纯文本元信息块.
 *
 * `createEvaluationRow` 按 `summary -> 公式块(内含结果行) -> 元信息块` 的
 * 顺序插进 `<details>`:
 * - `formulas`(`.eval-detail-body`):KaTeX 公式行(带 `data-tex`,可点击复制)
 *   与结果行 `.eval-result`,共用左侧高亮竖线与底色--它们都是数学内容;
 * - `metadata`(`.eval-detail-meta` 若干行):域/方法/分段/分层这类键值对,
 *   不套 `\text{}`,也不进公式块--它们是说明文字,不是数学内容.
 *
 * 为什么要折叠:求值条目的完整信息(P,∇f 逐分量,球坐标回显,积分等式)远比
 * 一行宽,折叠态只留摘要行,列表才扫得动;默认收起由 `<details open=false>`
 * 实现,开合只认点摘要行.
 */
export interface EvaluationDetailSections {
    formulas: HTMLElement | null;
    metadata: HTMLElement | null;
}

export function createDetailSections(
    lines: readonly EvaluationDetailLine[],
): EvaluationDetailSections {
    let formulas: HTMLElement | null = null;
    let metadata: HTMLElement | null = null;

    for (const line of lines) {
        if (line.kind === 'latex') {
            if (formulas === null) {
                formulas = createElement('div', 'eval-detail-body');
            }
            formulas.append(createFormulaElement(line.latex, 'eval-detail-line'));
        } else {
            if (metadata === null) {
                metadata = createElement('div', 'eval-detail-meta-block');
            }
            metadata.append(createElement('div', 'eval-detail-meta', line.text));
        }
    }

    return { formulas, metadata };
}

/**
 * 摘要行(折叠态可见):彩色类型标签 + 变量名 + 一行公式.
 *
 * 三项各司其职,不再放宽:
 * - `kind-badge`:彩色标签给出"这是哪一类求值对象"(梯度/散度/旋度/积分/求交),
 *   配色沿用左栏实体徽章的同一套视觉语言;
 * - `object-name`:DSL 里声明的变量名(如 `g`,`I`,`X`),同名多条时靠它区分;
 * - 公式:该条目的算子形式,`copyable = false`--摘要行是 `<details>` 的原生
 *   开合热区,点它只开合,不复制 TeX(复制只在展开细节行上生效).
 *
 * "公式排不出来就回退纯文本"(积分源对象被删除)这条规则收在这里:各类型
 * 只声明自己要放什么({@link EvaluationSummarySpec}),不必各自重复回退判断.
 */
export function createEvaluationSummary(
    spec: EvaluationSummarySpec,
    name: string,
): HTMLElement {
    const formula = spec.latex !== null
        ? createFormulaElement(spec.latex, 'eval-summary-formula', false)
        : createElement('code', 'object-expr', spec.text ?? '');

    const summary = document.createElement('summary');
    summary.className = 'eval-summary';
    summary.append(
        createElement('span', `kind-badge ${spec.badgeClass}`, spec.badgeLabel),
        createElement('strong', 'object-name', name),
        formula,
    );
    return summary;
}

/**
 * 结果/状态行:纯文本的 `<code class="eval-result ...">`.
 *
 * 数值是数学量时由各类型走细节里的公式行,这里只承担
 * `计算中...`/`已隐藏`/数值文本/错误文本;`className` 决定配色.
 */
export function createResultRow(spec: EvaluationResultSpec): HTMLElement {
    return createElement('code', spec.className, spec.text);
}

/**
 * 行外壳:把摘要/细节/结果行装配成 `<article class="evaluation-row">`.
 *
 * - 没有展开细节(`detail === null`,如被隐藏的条目):summary 直接放
 *   `.object-main`,结果行跟在后面;
 * - 有细节:建 `<details open=false>`,结果行**进公式块**并排在公式行之后
 *   (`result` 为 null 就不挂状态行,以免与细节里的等式重复);积分式排不
 *   出来时公式块为 null,此时为结果行单独建块,保证它不会掉出折叠区.
 *
 * 返回的就是传进来的 `result` 节点(可能已被搬进公式块);调用方自己持有
 * 引用,以便后续异步回填.开合完全交给 `<details>/<summary>` 原生行为;
 * `toggle` 是行首的显隐按钮(可为 null),它是 `.object-main` 的**兄弟**,
 * 不在 `<summary>` 内,所以点它只切换显隐,不开合细节.
 */
export function createEvaluationRow(
    summary: HTMLElement,
    detail: EvaluationDetailSections | null,
    result: HTMLElement | null,
    toggle: HTMLElement | null = null,
): HTMLElement {
    const row = createElement('article', 'object-row evaluation-row');
    row.setAttribute('role', 'listitem');
    if (toggle !== null) row.append(toggle);
    const main = createElement('div', 'object-main');

    if (detail === null) {
        main.append(summary);
        if (result !== null) main.append(result);
        row.append(main);
        return row;
    }

    // 结果行进公式块内部(末尾);积分式排不出来时公式块为 null,此时为结果
    // 单独建一个块,保证结果行不会掉出折叠区.
    if (result !== null) {
        if (detail.formulas === null) {
            detail.formulas = createElement('div', 'eval-detail-body');
        }
        detail.formulas.append(result);
    }

    const details = document.createElement('details');
    details.className = 'eval-details';
    // 默认折叠:全部条目在首次渲染时都是收起状态.
    details.open = false;
    details.append(summary);
    if (detail.formulas !== null) details.append(detail.formulas);
    if (detail.metadata !== null) details.append(detail.metadata);
    main.append(details);
    row.append(main);
    return row;
}

/**
 * 行被替换时把 `<details>` 的展开态带到新行上.
 *
 * 数值变化必然重建行(内容真的变了),但"用户把它展开了"这件事与内容无关,
 * 不该在拖动滑块时被每帧重置.
 */
export function carryDetailsOpen(from: HTMLElement, to: HTMLElement): void {
    const before = from.querySelector<HTMLDetailsElement>('details');
    if (before === null) return;
    const after = to.querySelector<HTMLDetailsElement>('details');
    if (after !== null) after.open = before.open;
}
