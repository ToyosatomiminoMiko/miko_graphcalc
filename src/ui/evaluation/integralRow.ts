/**
 * 积分条目的 HTML 结构(类型专属定义).
 *
 * 结构特征:**公式行 + 纯文本元信息 + 一条可摘除的状态行**,且数值是异步的.
 *
 * - 摘要:积分式本体(不接 `=`),排不出来时回退纯文本源标签;
 * - 细节:
 *   1. 第一条公式行是**完整等式** `∫f dx = 数值`(数值未回填时省略右端);
 *   2. 后面是域/方法/分段/分层等纯文本元信息(走 `.eval-detail-meta`,不经 KaTeX);
 * - 状态行:只在需要时存在--`计算中...`/`已隐藏,不参与计算`/错误文本,以及
 *   积分式排不出来时的纯文本数值;**数值就绪且有等式时被摘掉**,否则同一条
 *   等式会在公式块里出现两遍.
 *
 * 因为"等式挂在哪,状态行留不留"随数值就绪而变,本类型的行句柄额外记住
 * 积分式本体 `bodyLatex`,异步回填时据此决定走哪条路径.
 */
import type { IntegralTask, SceneObject } from '../../compiler/ir/types';
import {
    integralLatexDetails,
    integralLatexSummary,
} from '../../compiler/dsl/evaluationLatex';
import { latexResultNumber } from '../../math/latexNumber';
import { formatNumber } from '../numberText';
import { createFormulaElement } from '../FormulaView';
import {
    createDetailSections,
    createElement,
    createEvaluationRow,
    createEvaluationSummary,
    createResultRow,
    createVisibilityButton,
} from './rowDom';
import type {
    EvaluationContext,
    EvaluationKindSpec,
    EvaluationRowHandles,
} from './rowTypes';

const INTEGRAL_METHOD_LABELS: Record<IntegralTask['method'], string> = {
    trapezoid: '梯形法',
    simpson: '辛普森法',
    'riemann:left': '黎曼和(左端点)',
    'riemann:right': '黎曼和(右端点)',
    'riemann:mid': '黎曼和(中点)',
    // 数值上它是"按值域分层数格子"的分层黎曼和,只收敛到(而不是等于)
    // 勒贝格积分;UI 里如实标注"层-测度近似",避免学生误以为这是
    // 测度论意义下的勒贝格积分.这是**命名语义**,不是待修复缺陷:
    // 符号引擎 202609 审查报告里没有对应条目,不要再往它上面挂编号.
    lebesgue: '层-测度近似',
};

/** 积分条目句柄:额外记住积分式本体,供异步数值回填拼完整等式. */
export interface IntegralRowHandles extends EvaluationRowHandles {
    /** 积分式本体(不含 `=`);null 表示排不出公式,数值只能落在状态行. */
    bodyLatex: string | null;
}

/** 被积源对象 + 方法的纯文本标签(摘要公式排不出来时的回退). */
function integralSourceLabel(
    task: IntegralTask,
    objects: readonly SceneObject[],
): string {
    const source = objects.find((object) => object.id === task.objectId);
    const sourceLabel = source?.kind === 'curve'
        ? '曲线'
        : source?.kind === 'surface'
            ? '曲面'
            : source?.kind === 'region'
                ? '区域'
                : source?.kind === 'sphere' || source?.kind === 'box' || source?.kind === 'conic'
                    ? '体积'
                    : '对象';
    const sourceName = source ? source.name : `#${task.objectId}`;
    return `${sourceLabel} ${sourceName} · ${INTEGRAL_METHOD_LABELS[task.method]}`;
}

/**
 * 把展开细节里的积分等式换成 `∫f dx = 数值`;`value = null` 时退回不带
 * 右端的积分式(出错/尚未算出).
 *
 * 公式块(`.eval-detail-body`)只放公式行;积分式排不出来时该块不存在,
 * 这时结果行仍然只由 `<code class="eval-result">` 承担,不去动元信息块.
 */
function replaceIntegralEquation(
    handles: IntegralRowHandles,
    value: number | null,
): void {
    if (handles.bodyLatex === null) return;
    const container = handles.row.querySelector<HTMLElement>('.eval-detail-body');
    if (!container) return;

    const latex = value === null
        ? handles.bodyLatex
        : `${handles.bodyLatex}=${latexResultNumber(value)}`;
    const equation = createFormulaElement(latex, 'eval-detail-line');
    const existing = container.querySelector<HTMLElement>('.eval-detail-line');
    if (existing) {
        existing.replaceWith(equation);
    } else {
        container.prepend(equation);
    }
}

/**
 * 状态行(计算中 / 已隐藏 / 错误文本)的唯一落点.
 *
 * 就绪后状态行会被摘掉(等式在细节行上),出错时再按需挂回公式块末尾.
 */
function ensureIntegralStatusRow(handles: IntegralRowHandles): HTMLElement {
    if (handles.result !== null) return handles.result;
    const result = createElement('code', 'eval-result is-error', '');
    const container = handles.row.querySelector<HTMLElement>('.eval-detail-body')
        ?? handles.row.querySelector<HTMLElement>('.object-main')
        ?? handles.row;
    container.append(result);
    handles.result = result;
    return result;
}

/**
 * 刷新积分数值.
 *
 * 积分式可排版时(有 `bodyLatex`),完整等式 `∫f dx = 数值` 由展开细节的
 * 第一条 `.eval-detail-line` **唯一**承载--就绪后要把"计算中"状态行摘掉:
 * 结果行与细节行同属一个公式块,留着它就是把同一条等式排两遍.
 *
 * 积分式排不出来时(`bodyLatex === null`)没有细节行可挂,状态行才是数值的
 * 唯一落点,退化成纯文本数值.
 */
function renderIntegralValue(handles: IntegralRowHandles, value: number): void {
    handles.row.classList.remove('has-error');
    if (handles.bodyLatex === null) {
        const result = handles.result;
        if (result === null) return;
        // 纯文本没有可复制的 TeX,顺手清掉可能残留的 data-tex.
        result.replaceChildren(document.createTextNode(formatNumber(value)));
        result.className = 'eval-result is-ready';
        delete result.dataset.tex;
    } else {
        handles.result?.remove();
        handles.result = null;
    }
    replaceIntegralEquation(handles, value);
}

/**
 * 错误态:丢掉右端数值,把状态行挂回来写错误文本.
 *
 * 成功态状态行带 `data-tex`(点击复制);转错误态必须摘掉,否则点错误提示
 * 会把上一次的等式复制进剪贴板(FormulaCopyController 认 `[data-tex]`).
 */
function renderIntegralError(handles: IntegralRowHandles, message: string): void {
    replaceIntegralEquation(handles, null);
    const result = ensureIntegralStatusRow(handles);
    result.replaceChildren(document.createTextNode(message));
    result.className = 'eval-result is-error';
    delete result.dataset.tex;
    handles.row.classList.add('has-error');
}

/**
 * 积分条目 key:取**会被渲染的摘要/细节/元信息**.
 *
 * `integralLatexSummary` 为 null 时列表回退到 `integralSourceLabel` 纯文本,
 * 所以两者都进键;域对象名(`\iint_{D}` 与"域:"行)也由这里覆盖,不靠手工
 * 复制 task 字段.`show` 只影响三维叠加层,不进键.
 */
function integralRowKey(task: IntegralTask, objects: EvaluationContext['objects']): string {
    return JSON.stringify([
        integralLatexSummary(task, objects),
        integralSourceLabel(task, objects),
        task.enabled,
        task.enabled
            ? integralLatexDetails(
                task,
                objects,
                INTEGRAL_METHOD_LABELS[task.method],
                null,
            )
            : null,
    ]);
}

export const integralRowSpec: EvaluationKindSpec<
    IntegralTask,
    number,
    IntegralRowHandles
> = {
    kind: 'integral',
    name: (task) => task.name,
    cacheKey: (task, context) => integralRowKey(task, context.objects),
    build(task, context, cachedResult) {
        // 隐藏项一律按"无结果"建行:旧数值(即便键碰巧一致)也不参与呈现.
        const value = task.enabled ? cachedResult : null;

        // 摘要公式 = 积分式本体(不接 `=`):与梯度条目同一条约定--折叠态只给
        // 算子的书写形式,数值由回填排版成完整等式.展不开公式(null,例如被积
        // 对象已删除)时退回纯文本,不编造公式.
        const bodyLatex = integralLatexSummary(task, context.objects);
        const summary = createEvaluationSummary(
            {
                badgeClass: 'kind-integral',
                badgeLabel: '积分',
                latex: bodyLatex,
                text: integralSourceLabel(task, context.objects),
            },
            task.name,
        );

        // 展开细节第一行就是完整等式;数值尚未回填时省略右端(纯文本元信息
        // 由各类型的细节生成函数决定,这里不需要额外判断).
        const details = task.enabled
            ? createDetailSections(integralLatexDetails(
                task,
                context.objects,
                INTEGRAL_METHOD_LABELS[task.method],
                value,
            ))
            : null;

        // 状态行只在"没有等式可挂"或"还没算出/已禁用"时需要:
        // - 就绪 + 有积分式:等式已由细节行承载,再挂状态行就是重复行;
        // - 其余状态:"计算中/已隐藏/错误文本"必须有落点.
        let status: HTMLElement | null;
        if (!task.enabled) {
            status = createResultRow({
                className: 'eval-result is-disabled',
                text: '已隐藏,不参与计算',
            });
        } else if (value === null) {
            status = createResultRow({
                className: 'eval-result is-pending',
                text: '计算中...',
            });
        } else if (bodyLatex === null) {
            status = createResultRow({ className: 'eval-result is-ready', text: '' });
        } else {
            status = null;
        }

        // 显隐按钮:隐藏后不再调度数值计算(状态行给"已隐藏,不参与计算"),
        // 按钮不在 summary 内,点它不会开合细节.
        const toggle = createVisibilityButton(
            task.enabled,
            task.name,
            () => context.toggleHidden(task.name),
        );

        const row = createEvaluationRow(summary, details, status, toggle);
        row.classList.toggle('is-hidden', !task.enabled);

        const handles: IntegralRowHandles = { row, result: status, bodyLatex };
        // 已有数值时把数值排好(行重建但键一致时走这条路径).
        if (value !== null) renderIntegralValue(handles, value);
        return handles;
    },
    resolve(handles, _task, value) {
        renderIntegralValue(handles, value);
    },
    reject(handles, _task, message) {
        renderIntegralError(handles, message);
    },
};
