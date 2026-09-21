/**
 * 求值条目的 DOM 外壳(与具体类型无关).
 *
 * 三类求值对象(分析/积分/求交)共用同一副骨架,差异由各 item 子类的构造函数
 * 决定往里面放什么:
 *
 * ```text
 * <article class="object-row evaluation-row" role="listitem">
 *   <div class="row-main">                              ← 除按钮外的全部内容
 *     <details class="eval-details" open=false>          ← 无展开细节时 summary 直接在行上
 *       <summary class="eval-summary">...badge + 变量名 + 一行公式...</summary>
 *       <div class="eval-detail-body">        ← 公式块:数学内容 + 结果行
 *         <span class="eval-detail-line">...</span>
 *       </div>
 *       <div class="eval-detail-meta-block"> ← 纯文本元信息块(公式块之外)
 *         <div class="eval-detail-meta">域: ... · 方法: ...</div>
 *       </div>
 *     </details>
 *   </div>
 *   <button class="row-visibility-btn">隐藏/显示</button>  ← 行末,靠右,与 summary 无嵌套关系
 * </article>
 * ```
 *
 * `<details>` 保留是刻意的:`<summary>` 必须与它同处一个 `<details>` 才能有
 * 原生开合,细节块搬出去就没有折叠了.
 *
 * `.row-main` 这层包装由 {@link createObjectRow} 生成:它把"摘要 + 折叠区 +
 * 结果行"收成一个 `flex: 1` 的内容块,于是行的直接子节点只剩"主内容 + 显隐
 * 按钮"两个,按钮才能既贴右,又与全部内容平级.除按钮外的节点宽度都由
 * `.row-main` 给出(见 panels.css 的 `.evaluation-row > .row-main`).
 *
 * 行类型由 `EvaluationDetailLine` 判别:`latex` -> 公式行(可点击复制),
 * `text` -> 元信息行.哪些行走公式,哪些行走元信息完全由各类型的细节
 * 生成函数决定(`dsl/evaluationLatex.ts`).
 *
 * 本文件是求值 item 子类共用的组装件:谁长什么样由各子类的构造函数决定
 * (`analysisItem.ts` / `integralItem.ts` / `intersectionItem.ts`);建元素走
 * `packages/miko_ui/src/widgets/dom.ts` 的 `el`,显隐按钮与行外壳这类两栏通用件在
 * `packages/miko_ui/src/shared/rowDom.ts`.
 */
import { createObjectRow } from '@miko/ui';
import { createButton } from '@miko/ui';
import { el } from '@miko/ui';
import { createFormulaElement } from '@miko/ui';
import type { EvaluationDetailLine } from '@/contract/evaluation';

/**
 * 折叠态摘要:彩色类型标签 + 变量名 + 一行公式.
 *
 * 公式排不出来时 `latex` 为 null,由 `text` 回退成纯文本(积分源对象被
 * 删除时就是这条路径),避免给半个公式.
 */
export interface EvaluationSummarySpec {
    /** 完整 class,如 `kind-analysis kind-analysis-gradient`. */
    badgeClass: string;
    badgeLabel: string;
    /** KaTeX 公式;null 时用 `text`. */
    latex: string | null;
    /** `latex === null` 时的纯文本回退. */
    text?: string;
}

/** 结果/状态行初态:`className` 决定 `计算中...`/`已隐藏`/`错误` 的配色. */
export interface EvaluationResultSpec {
    className: string;
    text: string;
}

/**
 * 展开细节里的两组行:公式块与纯文本元信息块.
 *
 * 各 item 子类按 `summary -> 公式块(内含结果行) -> 元信息块` 的顺序插进
 * `<details>`:
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
                formulas = el('div', { class: 'eval-detail-body' });
            }
            formulas.append(createFormulaElement(line.latex, 'eval-detail-line'));
        } else {
            if (metadata === null) {
                metadata = el('div', { class: 'eval-detail-meta-block' });
            }
            metadata.append(el('div', { class: 'eval-detail-meta', text: line.text }));
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
 * "公式排不出来就回退纯文本"(积分源对象被删除)这条规则收在这里:各 item
 * 子类只声明自己要放什么({@link EvaluationSummarySpec}),不必各自重复回退判断.
 */
export function createEvaluationSummary(
    spec: EvaluationSummarySpec,
    name: string,
): HTMLElement {
    const formula = spec.latex !== null
        ? createFormulaElement(spec.latex, 'eval-summary-formula', false)
        : el('code', { class: 'object-expr', text: spec.text ?? '' });

    const summary = document.createElement('summary');
    summary.className = 'eval-summary';
    summary.append(
        el('span', { class: `kind-badge ${spec.badgeClass}`, text: spec.badgeLabel }),
        el('strong', { class: 'object-name', text: name }),
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
    return el('code', { class: spec.className, text: spec.text });
}

/**
 * 行末"过程"入口的规格.
 *
 * `disabledReason` 为 null 表示可打开;否则按钮置灰并把它作为理由给出.
 */
export interface ProcessEntrySpec {
    readonly name: string;
    /** 置灰理由;null 表示可用. */
    readonly disabledReason: string | null;
    readonly onOpen: () => void;
}

/**
 * 行末"过程"入口按钮:三级披露里 L2 的入口.
 *
 * - 可用:点击后由应用层切到右栏过程页并载入该条目的过程;
 * - 不可用(`disabledReason !== null`,目前是"已隐藏,不参与计算"与"内核拒绝
 *   所以没有步骤"两种):**仍然渲染**但置灰,并把理由写进 `title`/`aria-label`.
 *   "为什么点不了"必须有明文,与列表里"已隐藏,不参与计算"的文案口径一致
 *   (见设计文档 4.5).
 *
 * 入口的**有无**由各 item 按披露判据决定,且与条目是否隐藏无关:隐藏只把本来
 * 存在的入口置灰,绝不凭空多出一颗点不动的按钮(见 `EvaluationItem` 的
 * `processEntryOffered`).
 *
 * 它与显隐按钮同处行末动作容器,显隐按钮排在它**之后**,保持"显隐按钮仍在行末"
 * 这条既有位置语义.
 */
export function createProcessEntryButton(spec: ProcessEntrySpec): HTMLElement {
    const disabled = spec.disabledReason !== null;
    const button = createButton({
        class: 'row-process-btn',
        text: '过程',
        disabled,
        ariaLabel: disabled
            ? `${spec.name} 的过程不可用:${spec.disabledReason}`
            : `打开 ${spec.name} 的过程`,
        title: disabled ? (spec.disabledReason ?? undefined) : '在右栏过程页查看推导步骤',
    });
    if (!disabled) button.onClick(spec.onOpen);
    return button.element;
}

/**
 * 行外壳:把摘要/细节/结果行装配成 `<article class="evaluation-row">`.
 *
 * - 没有展开细节(`detail === null`,如被隐藏的条目):summary 进 `.row-main`,
 *   结果行跟在后面(主内容内换行,结果行独占第二行,见 panels.css);
 * - 有细节:建 `<details open=false>`,结果行**进公式块**并排在公式行之后
 *   (`result` 为 null 就不挂状态行,以免与细节里的等式重复);积分式排不
 *   出来时公式块为 null,此时为结果行单独建块,保证它不会掉出折叠区.
 *
 * `result` 节点本身可能已被搬进公式块(仍由调用方持有引用做异步回填);返回
 * `{ row, main }` 是因为积分条目在公式块不存在时要把状态行挂回主内容包装,
 * 而不是挂到行上变成动作区的第三个兄弟(见 IntegralItem.ensureStatusRow).
 * 开合完全交给 `<details>/<summary>` 原生行为;`actions` 是行末动作容器
 * (显隐按钮 + 可选的"过程"入口,由 `createRowActions` 生成,可为 null),
 * 它与 `.row-main` 同级,在行末(见 {@link createObjectRow}),
 * 不在 `<summary>` 内,所以点它只触发动作,不开合细节.
 */
export function createEvaluationRow(
    summary: HTMLElement,
    detail: EvaluationDetailSections | null,
    result: HTMLElement | null,
    actions: HTMLElement | null = null,
): { readonly row: HTMLElement; readonly main: HTMLElement } {
    const { row, main } = createObjectRow('evaluation-row', actions);

    if (detail === null) {
        main.append(summary);
        if (result !== null) main.append(result);
        return { row, main };
    }

    // 结果行进公式块内部(末尾);积分式排不出来时公式块为 null,此时为结果
    // 单独建一个块,保证结果行不会掉出折叠区.
    if (result !== null) {
        if (detail.formulas === null) {
            detail.formulas = el('div', { class: 'eval-detail-body' });
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
    return { row, main };
}
