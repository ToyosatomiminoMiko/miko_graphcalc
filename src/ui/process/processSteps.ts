/**
 * 过程步骤的数据词汇:步骤类型,依据徽章文案,步骤上限与步骤分区.
 *
 * 这是**纯数据/纯函数**模块(P4:文案与数据分离):渲染层只读 `kind` 决定
 * 徽章配色,读 `reason` 直接显示,不在这里写任何 DOM.
 *
 * 为什么要把 `rule` 与 `algebra` 分开(路线图 B1 的风险①):化简规则
 * ("同底数幂合并","因式分解")与求导法则("链式法则","积法则")不是一个
 * 概念,混在一起学生会把前者当成求导法则.`kind` 因此是步骤的一等字段,
 * 一期由数据源标注,三期由内核产物给出,UI 不变.
 */
import { SOLVE_STEP_KINDS, type SolveStepKind } from '../../ir';

/**
 * 步骤类型:决定依据徽章的视觉分区(样式归 CSS,见 css/process.css).
 *
 * 与内核产物 `SolveStep.kind` **同域**:它现在是求解内核与 UI 之间的契约
 * (取值定义在 `ir/types.ts` 的 `SOLVE_STEP_KINDS`),UI 不再自己维护第二份
 * 字面量联合--内核新增一个分区时,这里要么跟着加文案,要么在 `processData`
 * 里退化处理,不会悄悄漂移.
 */
export type ProcessStepKind = SolveStepKind;

/** 一"步":一行 KaTeX 公式 + 它的依据.序号由渲染层按数组位置给出. */
export interface ProcessStep {
    /** 一行 LaTeX;不换行,排不下时由该行横向滚动. */
    readonly latex: string;
    readonly kind: ProcessStepKind;
    /** 依据徽章文案(数学内容,由数据源给出). */
    readonly reason: string;
}

/**
 * 一条可展示的过程.
 *
 * `droppedSteps` 为 null 表示未截断;否则是被上限丢弃的步骤数,渲染层必须
 * 给出明文("另有 N 步未显示"),不能静默截断.
 *
 * `problem` 是**题目**的 LaTeX(待求解的方程 / 被分析的算子式);过程页顶部
 * 先显示它,读者才知道这一串步骤在解什么.没有题目(或数据源给不出)时省略.
 */
export interface ProcessDocument {
    /** 页头标题(如 `梯度 g` / `求解 S`);条目名的信息已经在这里. */
    readonly title: string;
    /** 题目 LaTeX;省略或 null 时不显示题目区. */
    readonly problem?: string | null;
    readonly steps: readonly ProcessStep[];
    readonly droppedSteps: number | null;
}

/** 规范顺序:分区输出按它,避免依赖步骤出现顺序.与内核分区同源(不另立别名). */
const PROCESS_STEP_KINDS: readonly ProcessStepKind[] = SOLVE_STEP_KINDS;

/** 徽章文案(中性词):配色表达"哪一类依据",文案表达"这一类的名字". */
export const PROCESS_STEP_KIND_LABELS: Record<ProcessStepKind, string> = {
    rule: '法则',
    algebra: '代数',
    definition: '定义',
    numeric: '数值',
    // 不定积分与微分方程内核引入的三类依据(见 ir/types.ts 的 SOLVE_STEP_KINDS).
    table: '查表',
    substitute: '换元',
    check: '验证',
};

/**
 * 按步骤上限截断.
 *
 * 上限非正数时返回空列表并把全部步骤记为丢弃(调用方仍能给出明文),
 * 不抛异常:上限是配置,配置写错不该让列表整块挂掉.
 *
 * 上限一律先规范化(`floor` + 夹到 0)再比较,否则 `3.5` 会得到"取 3 步却
 * 按 3.5 判断"的两种口径;`NaN` 与"上限 0"同义(配置写错不挂列表).
 */
export function truncateProcessSteps(
    steps: readonly ProcessStep[],
    maxSteps: number,
): { readonly steps: readonly ProcessStep[]; readonly droppedSteps: number | null } {
    const normalized = Number.isNaN(maxSteps) ? 0 : Math.max(0, Math.floor(maxSteps));
    if (steps.length <= normalized) {
        return { steps, droppedSteps: null };
    }
    return {
        steps: steps.slice(0, normalized),
        droppedSteps: steps.length - normalized,
    };
}

/**
 * 步骤分区:把步骤按 `kind` 归到四个区(组内保持原顺序,空区不出现).
 *
 * 用途是页头的依据图例("定义 2 · 数值 3")--它让"这条过程用了哪几类依据"
 * 一眼可见,而不必逐行扫徽章.纯函数,与 DOM 无关.
 */
export function partitionStepsByKind(
    steps: readonly ProcessStep[],
): ReadonlyArray<{ readonly kind: ProcessStepKind; readonly steps: readonly ProcessStep[] }> {
    const groups = new Map<ProcessStepKind, ProcessStep[]>();
    for (const step of steps) {
        const group = groups.get(step.kind);
        if (group === undefined) groups.set(step.kind, [step]);
        else group.push(step);
    }
    return PROCESS_STEP_KINDS
        .filter((kind) => groups.has(kind))
        .map((kind) => ({ kind, steps: groups.get(kind)! }));
}
