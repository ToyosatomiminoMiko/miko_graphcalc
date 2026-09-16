/**
 * 方程求解编译(设计文档 `docs/equation-solving-process.md` 的三期内核).
 *
 * 与 `analyses.ts` 同一档:**声明级编译**.一次编译算出完整步骤链,写进 IR 的
 * `solves`;不像 integral/intersection 那样还有一次异步数值回调.
 *
 * 分工:
 * - 求解能力全在 Rust(`math_rs::symbolic::solve`),本文件只做"选项校验 ->
 *   组系数 -> 调 WASM -> 落 IR";
 * - 参数系数与积分/分析同一条链路(`buildParamScope`),方程里的参数名按当前
 *   值代入,内核不做符号系数代数;
 * - **能力边界错误不抛**:多未知量 / 三次以上 / 非多项式是"这条方程超出内核",
 *   不是源码写错.内核把它们作为**结果**给回来(Rust `SolveOutcome.error`),
 *   落在 `SolveTask.error`,列表照常保留占位并给理由,**题目 LaTeX 照给**;
 *   隐藏与声明类错误(重复名,未知选项)仍按既有约定带语句 span 抛出.
 * - 隐藏语义沿用约定 1("先完整校验,后禁用,仅跳过计算"):选项/重名照常校验,
 *   只是不再调用求解内核,`equationLatex` 留空由 UI 回退成方程原文(纯文本)--
 *   隐藏项没算过,不该假装有排版产物.
 */
import type { AstProgram } from '../ast/types';
import type {
    ParamDeclaration,
    SolveStep,
    SolveStepKind,
    SolveTask,
} from '../../ir';
import { SOLVE_STEP_KINDS } from '../../ir';
import { solve_equation as wasmSolveEquation } from '../../wasm/math_rs/math_rs';
import { withStatementSpan } from '../errors';
import { assertKnownOptions, findOption } from './options';
import { buildParamScope } from './params';

/** 求解语句允许的选项. */
const SOLVE_OPTION_NAMES = ['variable'] as const;

/** WASM `solve_equation` 返回的 JSON 形状(与 Rust `SolveOutcome` 对齐). */
interface SolveOutcomeJson {
    variable: string;
    equation_latex: string;
    solution_latex: string | null;
    real_root_count: number;
    identity: boolean;
    steps: Array<{ latex: string; reason: string; kind: string }>;
    /** 能力边界理由;null 表示求解成功. */
    error: string | null;
}

/**
 * 内核给的分区字符串 -> IR 的字面量联合.
 *
 * 未登记的分区退化成中性色 `algebra`:分区只影响徽章配色,不该因为内核新增
 * 一个取值就让整条过程渲染不出来.
 */
function toStepKind(raw: string): SolveStepKind {
    return (SOLVE_STEP_KINDS as readonly string[]).includes(raw)
        ? (raw as SolveStepKind)
        : 'algebra';
}

function toSteps(raw: SolveOutcomeJson['steps']): SolveStep[] {
    return raw.map((entry) => ({
        latex: entry.latex,
        reason: entry.reason,
        kind: toStepKind(entry.kind),
    }));
}

/** 隐藏项的占位:保留方程原文与理由位,不调用内核. */
function disabledTask(name: string, equation: string): SolveTask {
    return {
        name,
        equation,
        variable: '',
        equationLatex: '',
        solutionLatex: null,
        realRootCount: 0,
        identity: false,
        steps: [],
        error: null,
        enabled: false,
    };
}

/**
 * 编译全部 solve 语句.
 *
 * 参数系数一次算好(`scope` 覆盖全部已声明参数),因此方程里出现未声明符号时
 * 内核会明确报"未声明参数",而不是静默当成 0.
 */
export function compileSolves(
    ast: AstProgram,
    params: Map<string, ParamDeclaration>,
    overrides: Record<string, number>,
    hiddenSolveNames: ReadonlySet<string> = new Set(),
): SolveTask[] {
    const scope = buildParamScope(params, overrides);
    const coefficientNames = Object.keys(scope);
    const coefficientValues = new Float64Array(coefficientNames.map((name) => scope[name]));

    const solves: SolveTask[] = [];
    const seen = new Set<string>();

    for (const statement of ast.statements) {
        if (statement.type !== 'solve') continue;

        withStatementSpan(statement.span, () => {
            if (seen.has(statement.name)) {
                throw new Error(`求解 ${statement.name} 重复声明`);
            }
            seen.add(statement.name);
            assertKnownOptions(statement.options, SOLVE_OPTION_NAMES, `求解 ${statement.name}`);

            if (hiddenSolveNames.has(statement.name)) {
                solves.push(disabledTask(statement.name, statement.equation));
                return;
            }

            const variable = findOption(statement.options, 'variable')?.trim() ?? '';
            const outcome = JSON.parse(
                wasmSolveEquation(
                    statement.equation,
                    variable,
                    coefficientNames,
                    coefficientValues,
                ),
            ) as SolveOutcomeJson;
            solves.push({
                name: statement.name,
                equation: statement.equation,
                variable: outcome.variable,
                equationLatex: outcome.equation_latex,
                solutionLatex: outcome.solution_latex,
                realRootCount: outcome.real_root_count,
                identity: outcome.identity,
                steps: toSteps(outcome.steps),
                // 能力边界理由由内核作为**结果**给出(不是异常):方程读不出来
                // 才会抛错(见 Rust `solve_equation` 的说明).
                error: outcome.error,
                enabled: true,
            });
        });
    }

    return solves;
}
