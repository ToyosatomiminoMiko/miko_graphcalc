/**
 * 分析 item:一个分析条目就是一行 DOM(`AnalysisItem`).
 *
 * 结构特征:**启用时没有独立结果行,也没有纯文本元信息**--所有内容都是数学,
 * 全部按公式行进 `.eval-detail-body`:符号定义 / ∇f(P) / P / 球坐标回显 /
 * f(P) / 切线 T.折叠态只留一行"算子在哪个点".
 *
 * 数值在编译期就算好了(`AnalysisResult` 自带 `scalar`/`vector`),所以这一类
 * 不 override `renderValue`/`renderError`:渲染即最终态.
 *
 * 隐藏项例外:细节根本不生成,此时挂一条"已隐藏,不参与计算"的状态行,
 * 让"不渲染 + 不参与计算"在列表里有明文,而不是只靠透明度.
 */
import type { AnalysisResult } from '../../ir';
import {
    analysisLatexDetailEntries,
    analysisLatexSummary,
    detailLinesOf,
} from '../../compiler/dsl/evaluationLatex';
import { createRowActions, createVisibilityButton } from '../shared/rowDom';
import { buildGradientProcess } from '../process/processData';
import { needsProcessPage } from '../process/disclosure';
import { EvaluationItem, type EvaluationContext } from './EvaluationItem';
import {
    createDetailSections,
    createEvaluationRow,
    createEvaluationSummary,
    createProcessEntryButton,
    createResultRow,
} from './evaluationDom';

/** 分析条目的彩色类型标签文案(算子维度). */
const ANALYSIS_KIND_LABELS: Record<AnalysisResult['op'], string> = {
    gradient: '梯度',
    divergence: '散度',
    curl: '旋度',
    laplacian: '拉普拉斯',
};

export class AnalysisItem extends EvaluationItem<AnalysisResult, void> {
    /**
     * 内容键:直接取**会被渲染的公式/文本**.
     *
     * 不再罗列 IR 字段:以前靠手工维护字段清单,漏掉过 `symbolic`(细节第一行)
     * 导致源表达式变了细节不刷新,又把只影响三维叠加层的 `show` 算了进来.
     * 键跟着渲染内容走,从根上避免"键漏字段".`enabled` 决定细节是否生成,
     * 必须进键.
     */
    static cacheKey(analysis: AnalysisResult): string {
        return JSON.stringify([
            analysisLatexSummary(analysis),
            analysis.enabled,
            analysis.enabled ? detailLinesOf(analysisLatexDetailEntries(analysis)) : null,
        ]);
    }

    /** `cached` 用不上:分析的数值编译期就在 IR 里,没有异步回填路径. */
    constructor(analysis: AnalysisResult, context: EvaluationContext) {
        // 折叠态:彩色算子标签 + 变量名 + 一行 KaTeX 公式(摘要公式不可复制).
        const summary = createEvaluationSummary(
            {
                badgeClass: `kind-analysis kind-analysis-${analysis.op}`,
                badgeLabel: ANALYSIS_KIND_LABELS[analysis.op],
                latex: analysisLatexSummary(analysis),
            },
            analysis.name,
        );

        // 展开细节里先给算子的符号展开,再给该点的数值结果;隐藏项不生成
        // 细节(数值在编译期被跳过,只有占位).细节行只算一次,披露判据与
        // 公式块消费同一份.
        const detailLines = analysis.enabled
            ? detailLinesOf(analysisLatexDetailEntries(analysis))
            : [];
        const detail = analysis.enabled ? createDetailSections(detailLines) : null;

        // 显隐按钮:切换后重新编译,该条目的数值计算随之跳过(隐藏 = 不渲染
        // + 不参与计算);按钮不在 summary 内,点它不会开合细节.
        const toggle = createVisibilityButton(
            analysis.enabled,
            analysis.name,
            () => context.toggleHidden(analysis.name),
        );

        // "过程"入口(三级披露的 L2):一期只接梯度(其余算子没有可看的中间
        // 步骤);隐藏项入口置灰并给理由--不参与计算也就没有过程可展示,但
        // "为什么点不了"要有明文.
        const processDisabledReason = analysis.enabled ? null : '已隐藏,不参与计算';
        const hasProcess = analysis.op === 'gradient';
        const processEntry = hasProcess
            && (processDisabledReason !== null || needsProcessPage(detailLines))
            ? createProcessEntryButton({
                name: analysis.name,
                disabledReason: processDisabledReason,
                onOpen: () => context.openProcess({
                    document: buildGradientProcess(analysis),
                }),
            })
            : null;

        // 隐藏项没有细节可展开(detail=null),状态行会直接落在 main 里,
        // 屏幕上有"已隐藏,不参与计算"这句明文--不能只靠 is-hidden 的透明度.
        const status = analysis.enabled
            ? null
            : createResultRow({
                className: 'eval-result is-disabled',
                text: '已隐藏,不参与计算',
            });

        // 显隐按钮排在"过程"之后:它的位置语义(仍在行末)不因多一个入口而变.
        const { row } = createEvaluationRow(
            summary,
            detail,
            status,
            createRowActions(processEntry, toggle),
        );
        row.classList.toggle('is-hidden', !analysis.enabled);
        super(analysis, row);
    }
}
