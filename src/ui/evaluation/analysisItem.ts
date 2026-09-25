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
import type { AnalysisResult } from '@/contract/ir';
import {
    analysisLatexDetailEntries,
    analysisLatexSummary,
    detailLinesOf,
} from '@/compiler/dsl/evaluationLatex';
import { createRowActions, createVisibilityButton } from 'miko_ui';
import { buildGradientProcess } from '@/adapters/evaluationToSteps';
import { needsProcessPage } from '@/ui/process/disclosure';
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
    /** 行末动作容器:补挂的"过程"入口 prepend 进来,显隐按钮仍留在末位. */
    private actions: HTMLElement | null = null;

    /** 构造之后补挂入口时,点击回调要用到的上下文(构造期拿不到实例字段). */
    private context: EvaluationContext | null = null;

    /** 已挂上的"过程"入口;null = 本行没有. */
    private processEntry: HTMLElement | null = null;

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

        // 隐藏项没有细节可展开(detail=null),状态行会直接落在 main 里,
        // 屏幕上有"已隐藏,不参与计算"这句明文--不能只靠 is-hidden 的透明度.
        const status = analysis.enabled
            ? null
            : createResultRow({
                className: 'eval-result is-disabled',
                text: '已隐藏,不参与计算',
            });

        // "过程"入口(三级披露的 L2):一期只接梯度(其余算子没有可看的中间
        // 步骤).入口的有无**只**由披露判据决定,与是否隐藏无关;但隐藏项不生成
        // 细节行(数值在编译期被跳过),判据无从重算,所以隐藏时留给
        // preserveExpandedStateFrom 从同名旧行继承--否则点一下"隐藏"就会凭空
        // 多出一颗按钮.容器先建好,入口由 addProcessEntry 挂(显隐按钮仍在末位).
        const actions = createRowActions(toggle);
        const { row } = createEvaluationRow(summary, detail, status, actions);
        row.classList.toggle('is-hidden', !analysis.enabled);
        super(analysis, row);
        this.context = context;
        this.actions = actions;
        this.processEntryOffered = analysis.op === 'gradient'
            && analysis.enabled
            && needsProcessPage(detailLines);
        if (this.processEntryOffered) this.addProcessEntry(null);
    }

    /**
     * 隐藏时把"本行有'过程'入口"这一事实从同名旧行带过来.
     *
     * 披露判据读的是**会被渲染的细节行数**,而隐藏项在编译期就跳过了数值计算
     * (`analyses.ts` 的隐藏分支只留占位),同一套判据对隐藏后的 IR 只会得出
     * "没有入口".若照此重建,点一下"隐藏"就会让行末动作容器少一颗按钮--与
     * "隐藏只改变按钮状态,不改变动作集合"相反(将来的绘图/关联入口同样要守
     * 这条).因此这里继承旧行的决定,并把它置灰.
     *
     * 首次渲染就隐藏的条目没有旧行可继承:按"无入口"处理--判据本身来自渲染
     * 内容,算不出来就不摆一颗点不动的按钮;状态行的"已隐藏,不参与计算"已经
     * 把那句话说清了.
     */
    override preserveExpandedStateFrom(previous: AnalysisItem): void {
        super.preserveExpandedStateFrom(previous);
        // 只有梯度这一类有 L2 入口(见构造函数);其余算子的旧行本来就不会有,
        // 这里的 `op` 判断同时挡住"名字沿用但算子换了"这种改写.
        if (this.task.enabled || this.task.op !== 'gradient') return;
        if (!previous.processEntryOffered) return;
        this.processEntryOffered = true;
        this.addProcessEntry('已隐藏,不参与计算');
    }

    /**
     * 把"过程"入口挂进行末动作容器,排在显隐按钮**之前**(显隐按钮仍在行末).
     *
     * 入口可能在构造期挂上(可用),也可能在行重建后补挂(隐藏时从旧行继承);
     * 后者在构造期拿不到 `context`,所以回调读实例上记下的那一份.
     */
    private addProcessEntry(disabledReason: string | null): void {
        const context = this.context;
        if (this.processEntry !== null || this.actions === null || context === null) return;
        const entry = createProcessEntryButton({
            name: this.task.name,
            disabledReason,
            onOpen: () => context.openProcess({
                document: buildGradientProcess(this.task),
            }),
        });
        this.actions.prepend(entry);
        this.processEntry = entry;
    }
}
