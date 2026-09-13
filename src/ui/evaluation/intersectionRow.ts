/**
 * 求交条目的 HTML 结构(类型专属定义).
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
} from '../../compiler/ir/types';
import {
    intersectionLatexDetails,
    intersectionLatexSummary,
} from '../../compiler/dsl/evaluationLatex';
import {
    createDetailSections,
    createEvaluationRow,
    createEvaluationSummary,
    createResultRow,
    createVisibilityButton,
} from './rowDom';
import type {
    EvaluationKindSpec,
    EvaluationRowHandles,
} from './rowTypes';

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

/** 求交条目句柄:结果行一定存在(纯文本统计),没有可落空的公式. */
export interface IntersectionRowHandles extends EvaluationRowHandles {
    result: HTMLElement;
}

/**
 * 求交条目 key:摘要/细节公式与启用态.
 *
 * `color` 只影响三维渲染,不影响列表内容,不进键--否则改个颜色就会把
 * 用户展开的细节收起来.
 */
function intersectionRowKey(task: IntersectionTask): string {
    return JSON.stringify([
        intersectionLatexSummary(task),
        task.enabled,
        task.enabled ? intersectionLatexDetails(task) : null,
    ]);
}

export const intersectionRowSpec: EvaluationKindSpec<
    IntersectionTask,
    IntersectionOutput,
    IntersectionRowHandles
> = {
    kind: 'intersection',
    name: (task) => task.name,
    cacheKey: (task) => intersectionRowKey(task),
    build(task, context) {
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

        const row = createEvaluationRow(summary, detail, result, toggle);
        row.classList.toggle('is-hidden', !task.enabled);
        return { row, result };
    },
    resolve(handles, task, output) {
        handles.result.textContent = intersectionSummary(task, output);
        handles.result.className = 'eval-result is-ready';
        handles.row.classList.remove('has-error');
    },
    reject(handles, _task, message) {
        handles.result.textContent = message;
        handles.result.className = 'eval-result is-error';
        handles.row.classList.add('has-error');
    },
};
