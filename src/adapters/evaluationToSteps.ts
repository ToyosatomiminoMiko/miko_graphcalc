/**
 * 过程数据源(**纯函数**,只消费 IR 与既有的细节行,不碰 DOM).
 *
 * 一期口径:数据来自现有 `analysisLatexDetailEntries` / `integralLatexDetailEntries`
 * 的细节行,按递等式口径重组--不新增内核产物,不改 IR 字段语义(见
 * docs/equation-solving-process.md 第 6 节).三类里先接**梯度与积分**
 * (细节行最多,递等结构最明显,路线图 B5 的降级口径),散度/旋度/求交
 * 继续留在 L1.
 *
 * 分工:
 * - `evaluationLatex.ts` 给出每行的**角色**(公式在那里拼装,只有它知道来历);
 * - 本模块把角色翻译成展示用的 `kind` 与依据文案(P4:文案与数据分离);
 * - `processSteps.ts` 只管上限与分区.
 * 因此"公式怎么排"与"这一步算什么依据"各自只有一个改动点.
 */
import type {
    AnalysisResult,
    AntiderivativeTask,
    IntegralTask,
    OdeTask,
    SceneObject,
    SolveStep,
    SolveTask,
} from '@/contract/ir';
import { UI_CONFIG } from '@/config/uiConfig';
import {
    analysisLatexDetailEntries,
    analysisLatexSummary,
    integralLatexDetailEntries,
    integralLatexSummary,
    type EvaluationDetailEntry,
    type EvaluationDetailRole,
} from '@/compiler/dsl/evaluationLatex';
import {
    truncateProcessSteps,
    type ProcessDocument,
    type ProcessStep,
    type ProcessStepKind,
} from '@/adapters/processSteps';

const process_maxSteps = UI_CONFIG.process.maxSteps;

/** 角色 -> 展示:`kind` 决定徽章分区,`reason` 是徽章文案. */
interface StepPresentation {
    readonly kind: ProcessStepKind;
    readonly reason: string;
}

/**
 * 只有**描述推导一步**的角色才进过程页.
 *
 * 纯文本元信息行(积分域/采样分段)不是等式,留在 L1 的 `<details>` 里;
 * 过程页是"一行一步的递等式",不掺说明文字.因此这里用 `Partial`:没有登记的
 * 角色(以及所有 `kind === 'text'` 的行)自然不成步,而不是靠调用方过滤.
 */
const ROLE_PRESENTATION: Partial<Record<EvaluationDetailRole, StepPresentation>> = {
    symbolic: { kind: 'definition', reason: '算子定义式' },
    value: { kind: 'numeric', reason: '数值代入' },
    point: { kind: 'algebra', reason: '代入取点' },
    spherical: { kind: 'numeric', reason: '球坐标回显' },
    scalar: { kind: 'numeric', reason: '函数值' },
    tangent: { kind: 'numeric', reason: '切向量' },
    equation: { kind: 'definition', reason: '积分定义式' },
    general: { kind: 'definition', reason: '通解' },
    particular: { kind: 'algebra', reason: '特解' },
};

/**
 * 把带角色的细节行分区成步骤,再按上限截断.
 *
 * `title` 给页头,`problem` 是题目(待处理的式子);截断只发生在这里,视图拿到
 * 的一定是最终步骤.
 */
function buildProcessDocument(
    title: string,
    problem: string | null,
    entries: readonly EvaluationDetailEntry[],
    maxSteps: number,
): ProcessDocument {
    const steps: ProcessStep[] = [];
    for (const entry of entries) {
        if (entry.line.kind !== 'latex') continue;
        const presentation = ROLE_PRESENTATION[entry.role];
        if (presentation === undefined) continue;
        steps.push({
            latex: entry.line.latex,
            kind: presentation.kind,
            reason: presentation.reason,
        });
    }
    const truncated = truncateProcessSteps(steps, maxSteps);
    return {
        title,
        problem,
        steps: truncated.steps,
        droppedSteps: truncated.droppedSteps,
    };
}

/** 梯度条目的过程:符号展开 -> 该点数值 -> 取点/回显 -> 函数值与切向量. */
export function buildGradientProcess(
    analysis: AnalysisResult,
    maxSteps: number = process_maxSteps,
): ProcessDocument {
    return buildProcessDocument(
        `梯度 ${analysis.name}`,
        analysisLatexSummary(analysis),
        analysisLatexDetailEntries(analysis),
        maxSteps,
    );
}

/**
 * 积分条目的过程:目前只有"积分式 = 数值"这一步(数值未回填时省略右端).
 *
 * 没有内核产物就没有更多步骤可给(路线图 B5 的三期范围);这里如实只产出
 * 已有的等式,不编造中间步骤.
 */
export function buildIntegralProcess(
    task: IntegralTask,
    objects: readonly SceneObject[],
    methodLabel: string,
    value: number | null,
    maxSteps: number = process_maxSteps,
): ProcessDocument {
    return buildProcessDocument(
        `积分 ${task.name}`,
        integralLatexSummary(task, objects),
        integralLatexDetailEntries(task, objects, methodLabel, value),
        maxSteps,
    );
}

/**
 * 约束条目的过程输入(求解 / 后续联立共用).
 *
 * 只有三样东西与"哪一类约束"有关:页头类别名,条目名,题目 LaTeX;步骤链
 * 一律是内核产物.把这三样抽出来,联立落地时不必再抄一份过程装配.
 */
export interface ConstraintProcessInput {
    /** 页头类别名(如 `求解`),与条目徽章文案同源. */
    readonly label: string;
    readonly name: string;
    /** 题目 LaTeX;空串表示排不出公式(页头不再显示题目区). */
    readonly problemLatex: string;
    readonly steps: readonly SolveStep[];
}

/**
 * 约束条目的过程:题目 + **内核产物**步骤.
 *
 * 这是"三期只换数据源"的落点:步骤的 `kind`/`reason`/`latex` 全部来自内核
 * (`math_rs::symbolic::solve`,联立落地后是同层的内核产物),过程页只把它排版
 * 出来,不再做任何重组或猜测.求解失败时给出空步骤 + 错误理由,过程页仍显示
 * 题目.
 *
 * 上限同样生效:内核理论上可以给出任意长的步骤链,视图的截断明文不能对
 * 内核数据源失灵.
 */
export function buildConstraintProcess(
    input: ConstraintProcessInput,
    maxSteps: number = process_maxSteps,
): ProcessDocument {
    const steps: ProcessStep[] = input.steps.map((step) => ({
        latex: step.latex,
        kind: step.kind,
        reason: step.reason,
    }));
    const truncated = truncateProcessSteps(steps, maxSteps);
    return {
        title: `${input.label} ${input.name}`,
        problem: input.problemLatex === '' ? null : input.problemLatex,
        steps: truncated.steps,
        droppedSteps: truncated.droppedSteps,
    };
}

/**
 * 方程求解条目的过程:题目就是待求解的方程,步骤由内核产物直接给出.
 *
 * 求解是统一词汇里的一个特例(`method = exact`),过程装配走
 * [`buildConstraintProcess`];保留本函数只是让"求解"有一个语义明确的入口.
 */
export function buildSolveProcess(
    task: SolveTask,
    maxSteps: number = process_maxSteps,
): ProcessDocument {
    return buildConstraintProcess(
        {
            label: '求解',
            name: task.name,
            problemLatex: task.equationLatex,
            steps: task.steps,
        },
        maxSteps,
    );
}

/**
 * 微分方程条目的过程:题目是原方程,步骤由**内核产物**直接给出.
 *
 * 与求解/不定积分同一条"只换数据源"的口径:`kind` / `reason` / `latex` 全部
 * 来自 `math_rs::symbolic::ode`,过程页只负责排版.最后一步固定是回代验证
 * (显式解对自变量求导代回;隐式解走隐函数全导),它是"这个解对不对"的凭据.
 *
 * 上限同样生效:分类 + 标准形 + 积分因子 + 两侧积分 + 初值代入 + 验证很容易
 * 超过默认步数上限,截断必须带明文(见 `truncateProcessSteps`).
 */
export function buildOdeProcess(
    task: OdeTask,
    maxSteps: number = process_maxSteps,
): ProcessDocument {
    const steps: ProcessStep[] = task.steps.map((step) => ({
        latex: step.latex,
        kind: step.kind,
        reason: step.reason,
    }));
    const truncated = truncateProcessSteps(steps, maxSteps);
    return {
        title: `微分方程 ${task.name}`,
        problem: task.equationLatex === '' ? null : task.equationLatex,
        steps: truncated.steps,
        droppedSteps: truncated.droppedSteps,
    };
}

/**
 * 不定积分条目的过程:题目是积分式,步骤由**内核产物**直接给出.
 *
 * 与求解同一条"三期只换数据源"的口径:`kind` / `reason` / `latex` 全部来自
 * `math_rs::symbolic::integral`,过程页只负责排版.最后一步固定是回代验证
 * (对原函数求导等于被积函数),它是"原函数对不对"的凭据,不能省略.
 */
export function buildAntiderivativeProcess(
    task: AntiderivativeTask,
    maxSteps: number = process_maxSteps,
): ProcessDocument {
    const steps: ProcessStep[] = task.steps.map((step) => ({
        latex: step.latex,
        kind: step.kind,
        reason: step.reason,
    }));
    const truncated = truncateProcessSteps(steps, maxSteps);
    return {
        title: `原函数 ${task.name}`,
        problem: task.integrandLatex === '' ? null : task.integrandLatex,
        steps: truncated.steps,
        droppedSteps: truncated.droppedSteps,
    };
}
