/**
 * 原函数 item:一条 `antiderivative` 语句就是一行 DOM(`AntiderivativeItem`).
 *
 * 结构特征与求解条目同骨架(`SolveItem`),因为两者的数据来源是同一档:
 * **声明级编译**--原函数表达式与步骤链都随 IR 一起到达,没有异步数值回调,
 * 所以本类不 override `renderValue`/`renderError`.
 *
 * - 摘要(折叠态可见):彩色"原函数"标签 + 名称 + **题目**(积分式);
 * - 展开细节:通解 `= F + C`,下发对象的常数取值,**回代验证**结论,内核拒绝
 *   的理由与步骤计数;
 * - 行末动作:"过程"入口(载入右栏过程页,显示题目 + 逐行推导)+ 显隐按钮
 *   (隐藏 = 不调内核,也不下发实体对象,列表保留占位).
 *
 * 与求解的唯一差别在下发对象:原函数同时是一条 curve/surface,所以隐藏它
 * 会连实体一起消失(编译期就不生成对象,见 `compileAntiderivatives`).
 */
import type { AntiderivativeTask } from '@/contract/ir';
import {
    antiderivativeLatexDetailEntries,
    detailLinesOf,
    antiderivativeLatexSummary,
} from '@/compiler/dsl/evaluationLatex';
import { createRowActions, createVisibilityButton } from 'miko_ui';
import { buildAntiderivativeProcess } from '@/adapters/evaluationToSteps';
import { EvaluationItem, type EvaluationContext } from './EvaluationItem';
import {
    createDetailSections,
    createEvaluationRow,
    createEvaluationSummary,
    createProcessEntryButton,
    createResultRow,
} from './evaluationDom';

export class AntiderivativeItem extends EvaluationItem<AntiderivativeTask, void> {
    /**
     * 内容键:跟着**渲染内容**走(与求解条目同一条约定).
     *
     * 不罗列 IR 字段清单:内核新增一种步骤或细节行时,键会自动带上
     * `steps`/`verified`/`constant` 的变化,行跟着刷新;`objectId`/`range` 等
     * 不参与渲染的字段不算进来,免得白重建一次行.
     */
    static cacheKey(task: AntiderivativeTask): string {
        return JSON.stringify([
            task.name,
            task.integrand,
            task.integrandLatex,
            task.variable,
            task.antiderivativeLatex,
            task.antiderivativeText,
            task.constant,
            task.verified,
            task.error,
            task.enabled,
            task.steps,
        ]);
    }

    constructor(task: AntiderivativeTask, context: EvaluationContext) {
        // 摘要 = 题目:积分式.隐藏项没有题目 LaTeX,回退成被积函数原文(纯文本),
        // 不留下半条公式.
        const summary = createEvaluationSummary(
            {
                badgeClass: 'kind-antiderivative',
                badgeLabel: '原函数',
                latex: antiderivativeLatexSummary(task),
                text: `∫ ${task.integrand} d${task.variable}`,
            },
            task.name,
        );

        const detail = task.enabled
            ? createDetailSections(detailLinesOf(antiderivativeLatexDetailEntries(task)))
            : null;

        // 显隐按钮:隐藏后不再调用积分内核,也不下发实体对象.
        const toggle = createVisibilityButton(
            task.enabled,
            task.name,
            () => context.toggleHidden(task.name),
        );

        // "过程"入口:有步骤才可打开;隐藏与"内核拒绝"各有明文理由.
        const processDisabledReason = !task.enabled
            ? '已隐藏,不参与计算'
            : task.steps.length === 0
                ? `无法求原函数: ${task.error ?? '没有可展示的步骤'}`
                : null;
        const processEntry = createProcessEntryButton({
            name: task.name,
            disabledReason: processDisabledReason,
            onOpen: () => context.openProcess({
                document: buildAntiderivativeProcess(task),
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
        // 求原函数的推导天然在 L2,入口常驻:有无与是否隐藏无关,隐藏只置灰
        // (见基类 processEntryOffered).
        this.processEntryOffered = true;
    }
}
