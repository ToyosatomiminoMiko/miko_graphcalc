/**
 * 求交 item:一个求交条目就是一行 DOM(`IntersectionItem`).
 *
 * 结构特征:**只有一条纯文本结果行**,细节是"源对象 + 采样分段"这类元信息.
 * 数值(交点/交线数量)由 Worker 异步回填,首次渲染只有占位.
 *
 * 交点数/交线数是**纯文本统计**,不是数学公式,所以结果行进 `.eval-result`
 * 而不是 KaTeX;两个源对象与分段数走展开细节.
 */
import type {
    IntersectionOutput,
    IntersectionTask,
} from '@/contract/ir';
import {
    intersectionLatexDetails,
    intersectionLatexSummary,
} from '@/compiler/dsl/evaluationLatex';
import { createRowActions, createVisibilityButton } from '@miko/ui';
import { EvaluationItem, type EvaluationContext } from './EvaluationItem';
import {
    createDetailSections,
    createEvaluationRow,
    createEvaluationSummary,
    createResultRow,
} from './evaluationDom';

/**
 * 求交结果摘要(纯文本,排在结果行里).
 *
 * 交点与交线可能**同时存在**(曲面/体积求交既有离散交点也有交线),所以两边
 * 都要报,不能一边非空就把另一边丢掉.
 *
 * 不再统计"交线共 N 个点":那是采样折线的顶点数,随 `segments` 变而变,
 * 不是数学量,写进结果只会误导.
 */
function intersectionSummary(
    task: IntersectionTask,
    output: IntersectionOutput,
): string {
    const source = `${task.aName} ∩ ${task.bName}`;
    const parts: string[] = [];
    if (output.points.length > 0) parts.push(`交点 ${output.points.length} 个`);
    if (output.curves.length > 0) parts.push(`交线 ${output.curves.length} 条`);
    return `${source} · ${parts.length > 0 ? parts.join(' · ') : '无交'}`;
}

export class IntersectionItem extends EvaluationItem<
    IntersectionTask,
    IntersectionOutput
> {
    /**
     * 求交条目的内容键:摘要/细节公式与启用态.
     *
     * `color` 只影响三维渲染,不影响列表内容,不进键--否则改个颜色就会把
     * 用户展开的细节收起来.
     */
    static cacheKey(task: IntersectionTask): string {
        return JSON.stringify([
            intersectionLatexSummary(task),
            task.enabled,
            task.enabled ? intersectionLatexDetails(task) : null,
        ]);
    }

    /** 结果行一定存在(纯文本统计),没有可落空的公式. */
    private readonly result: HTMLElement;

    constructor(task: IntersectionTask, context: EvaluationContext) {
        const summary = createEvaluationSummary(
            {
                badgeClass: 'kind-intersection',
                badgeLabel: '求交',
                latex: intersectionLatexSummary(task),
            },
            task.name,
        );

        // 求交是异步任务:交点/交线数量由 Worker 回填到结果行,展开细节给
        // 两个源对象与采样分段.
        const detail = task.enabled
            ? createDetailSections(intersectionLatexDetails(task))
            : null;
        const result = createResultRow({
            className: task.enabled
                ? 'eval-result is-pending'
                : 'eval-result is-disabled',
            text: task.enabled ? '计算中...' : '已隐藏,不参与计算',
        });

        // 显隐按钮:隐藏后不进入求交计算队列(列表保留占位),
        // 按钮不在 summary 内,点它不会开合细节.
        const toggle = createVisibilityButton(
            task.enabled,
            task.name,
            () => context.toggleHidden(task.name),
        );

        // 求交一期不接过程页(细节行没有递等结构,见设计文档第 6 节的降级
        // 口径),行末只有显隐按钮.
        const { row } = createEvaluationRow(
            summary,
            detail,
            result,
            createRowActions(toggle),
        );
        row.classList.toggle('is-hidden', !task.enabled);
        super(task, row);
        this.result = result;
    }

    renderValue(output: IntersectionOutput): void {
        this.result.textContent = intersectionSummary(this.task, output);
        this.result.className = 'eval-result is-ready';
        this.row.classList.remove('has-error');
    }

    renderError(message: string): void {
        this.result.textContent = message;
        this.result.className = 'eval-result is-error';
        this.row.classList.add('has-error');
    }
}
