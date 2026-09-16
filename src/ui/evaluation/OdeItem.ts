/**
 * 微分方程 item:一条 `ode` 语句就是一行 DOM(`OdeItem`).
 *
 * 结构特征与求解/原函数条目同骨架(`SolveItem`/`AntiderivativeItem`),因为
 * 数据来源是同一档:**声明级编译**--通解/特解/步骤链都随 IR 一起到达,没有
 * 异步数值回调,所以本类不 override `renderValue`/`renderError`.
 *
 * - 摘要(折叠态可见):彩色"微分方程"标签 + 名称 + **题目**(原方程);
 * - 展开细节:通解(隐式解会明确标注),特解,斜率场,回代验证,内核的如实
 *   说明与步骤计数;
 * - 行末动作:"过程"入口(载入右栏过程页)+ 显隐按钮(隐藏 = 不下发它下发的
 *   斜率场与解曲线,列表保留占位).
 */
import type { OdeTask } from '../../contract/ir';
import { detailLinesOf, odeLatexDetailEntries, odeLatexSummary } from '../../compiler/dsl/evaluationLatex';
import { createRowActions, createVisibilityButton } from '../shared/rowDom';
import { buildOdeProcess } from '../process/processData';
import { EvaluationItem, type EvaluationContext } from './EvaluationItem';
import {
    createDetailSections,
    createEvaluationRow,
    createEvaluationSummary,
    createProcessEntryButton,
    createResultRow,
} from './evaluationDom';

export class OdeItem extends EvaluationItem<OdeTask, void> {
    /**
     * 内容键:跟着**渲染内容**走(与求解/原函数条目同一条约定).
     *
     * 不罗列 IR 字段清单:内核新增一种步骤或细节行时,键会自动带上
     * `steps`/`verified`/`notes` 的变化,行跟着刷新.
     */
    static cacheKey(task: OdeTask): string {
        return JSON.stringify([
            task.name,
            task.equation,
            task.equationLatex,
            task.independent,
            task.dependent,
            task.order,
            task.generalLatex,
            task.particularLatex,
            task.implicit,
            task.initialConditions,
            task.slopeLatex,
            task.curveNames,
            task.notes,
            task.verified,
            task.error,
            task.enabled,
            task.steps,
        ]);
    }

    constructor(task: OdeTask, context: EvaluationContext) {
        // 摘要 = 题目:原方程.隐藏项没有题目 LaTeX,回退成方程原文(纯文本).
        const summary = createEvaluationSummary(
            {
                badgeClass: 'kind-ode',
                badgeLabel: '微分方程',
                latex: odeLatexSummary(task),
                text: task.equation,
            },
            task.name,
        );

        const detail = task.enabled
            ? createDetailSections(detailLinesOf(odeLatexDetailEntries(task)))
            : null;

        // 显隐按钮:隐藏后不再下发斜率场与解曲线,列表保留占位.
        const toggle = createVisibilityButton(
            task.enabled,
            task.name,
            () => context.toggleHidden(task.name),
        );

        // "过程"入口:有步骤才可打开;隐藏与"内核拒绝"各有明文理由.
        const processDisabledReason = !task.enabled
            ? '已隐藏,不参与计算'
            : task.steps.length === 0
                ? `无法求解: ${task.error ?? '没有可展示的步骤'}`
                : null;
        const processEntry = createProcessEntryButton({
            name: task.name,
            disabledReason: processDisabledReason,
            onOpen: () => context.openProcess({
                document: buildOdeProcess(task),
            }),
        });

        const status = task.enabled
            ? null
            : createResultRow({
                className: 'eval-result is-disabled',
                text: '已隐藏,不参与计算',
            });

        const { row } = createEvaluationRow(
            summary,
            detail,
            status,
            createRowActions(processEntry, toggle),
        );
        row.classList.toggle('is-hidden', !task.enabled);
        super(task, row);
    }
}
