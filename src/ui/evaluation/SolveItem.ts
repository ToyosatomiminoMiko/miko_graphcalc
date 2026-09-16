/**
 * 求解 item:一条方程求解语句就是一行 DOM(`SolveItem`).
 *
 * 结构特征与求交/积分同骨架,但**数值不是异步的**:求解在编译期完成,
 * 步骤链与解集都随 IR 一起到达,所以本类不 override `renderValue`/
 * `renderError`.
 *
 * - 摘要(折叠态可见):彩色"求解"标签 + 变量名 + **题目**(待求解的方程);
 * - 展开细节:解集公式(或"无实数解"/"恒等式"明文),内核拒绝的理由,步骤计数;
 * - 行末动作:"过程"入口(载入右栏过程页,显示题目 + 逐行推导)+ 显隐按钮
 *   (隐藏 = 不调度求解内核,列表保留占位).
 *
 * 求解是声明级编译:隐藏项在 `compileSolves` 里就不再调用内核,因此这里
 * 只需按 `enabled` 决定显隐与入口可用性,没有别的异步状态.
 */
import type { SolveTask } from '../../contract/ir';
import {
    solveLatexDetails,
    solveLatexSummary,
} from '../../compiler/dsl/evaluationLatex';
import { createRowActions, createVisibilityButton } from '../shared/rowDom';
import { buildSolveProcess } from '../process/processData';
import { EvaluationItem, type EvaluationContext } from './EvaluationItem';
import {
    createDetailSections,
    createEvaluationRow,
    createEvaluationSummary,
    createProcessEntryButton,
    createResultRow,
} from './evaluationDom';

export class SolveItem extends EvaluationItem<SolveTask, void> {
    /**
     * 内容键:直接取会被渲染的题目/解集/步骤/错误与启用态.
     *
     * 不罗列 IR 字段清单:键跟着渲染内容走,内核新增一步求解说明时,
     * 行也会跟着刷新(与 analysisItem 同一条约定).`realRootCount`/`identity`
     * 不在键里:前者不参与渲染,后者已经由 `solutionLatex` 的有无体现--
     * 把不渲染的字段算进来只会让行白重建一遍.
     */
    static cacheKey(task: SolveTask): string {
        return JSON.stringify([
            task.name,
            task.equation,
            task.equationLatex,
            task.solutionLatex,
            task.error,
            task.enabled,
            task.steps,
        ]);
    }

    constructor(task: SolveTask, context: EvaluationContext) {
        // 摘要 = 题目:变量名 + 方程本身.隐藏项没有题目 LaTeX,回退成方程原文
        // (纯文本),不留下半条公式.
        const summary = createEvaluationSummary(
            {
                badgeClass: 'kind-solve',
                badgeLabel: '求解',
                latex: solveLatexSummary(task),
                text: task.equation,
            },
            task.name,
        );

        const detail = task.enabled ? createDetailSections(solveLatexDetails(task)) : null;

        // 显隐按钮:隐藏后不再调用求解内核(状态行给同一句明文).
        const toggle = createVisibilityButton(
            task.enabled,
            task.name,
            () => context.toggleHidden(task.name),
        );

        // "过程"入口:有步骤才可打开;隐藏与"内核拒绝"各有明文理由,不是灰按钮
        // 摆在那里让人猜.
        const processDisabledReason = !task.enabled
            ? '已隐藏,不参与计算'
            : task.steps.length === 0
                ? `无法求解: ${task.error ?? '没有可展示的步骤'}`
                : null;
        const processEntry = createProcessEntryButton({
            name: task.name,
            disabledReason: processDisabledReason,
            onOpen: () => context.openProcess({
                document: buildSolveProcess(task),
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
