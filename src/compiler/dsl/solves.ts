/**
 * 方程求解编译(设计文档 `docs/equation-solving-process.md` 的三期内核).
 *
 * 与 `analyses.ts` 同一档:**声明级编译**.一次编译算出完整步骤链,写进 IR 的
 * `solves`;不像 integral/intersection 那样还有一次异步数值回调.
 *
 * 分工:
 * - 求解能力全在 Rust(`math_rs::symbolic::solve` 与 `math_rs::symbolic::system`),
 *   本文件只做"组系数 -> 调 WASM -> 落 IR";查重 / 选项校验 / 语句级错误定位 /
 *   hidden 语义由 `statementShell.ts` 的 `compileConstraintStatements` 统一提供;
 * - 参数系数与积分/分析同一条链路(`buildParamScope`),方程里的参数名按当前
 *   值代入,内核不做符号系数代数;
 * - **能力边界错误不抛**:多未知量 / 三次以上 / 非多项式 / 超定欠定是"这条方程
 *   超出内核",不是源码写错.内核把它们作为**结果**给回来(Rust 的 `error`
 *   字段),落在 `SolveTask.error`,列表照常保留占位并给理由,**题目 LaTeX 照给**;
 *   隐藏与声明类错误(重复名,未知选项)仍按既有约定带语句 span 抛出.
 * - 隐藏语义沿用约定 1("先完整校验,后禁用,仅跳过计算"):选项/重名照常校验,
 *   只是不再调用求解内核,`equationLatex` 留空由 UI 回退成方程原文(纯文本)--
 *   隐藏项没算过,不该假装有排版产物.
 *
 * ## 单方程与联立的分派
 *
 * `equations.length === 1` 走既有单方程内核(`solve_equation`,保持原线格式与
 * 原步骤口径);多条走联立内核(`solve_system`,JSON payload).两者的产物映射到
 * 同一个 `SolveTask`:联立的未知量列表进 `unknowns`,`variable` 只是展示用的
 * `, ` 连接文案(见 contract/ir.ts 的 SolveTask).
 */
import type { AstProgram, SolveStatement } from '../../contract/ast';
import type {
    ParamDeclaration,
    SolveMethod,
    SolveStep,
    SolveStepKind,
    SolveTask,
} from '../../contract/ir';
import { SOLVE_STEP_KINDS } from '../../contract/ir';
import {
    solve_equation as wasmSolveEquation,
    solve_system as wasmSolveSystem,
} from '../../generated/math_rs/math_rs';
import { NUMERIC_CONFIG } from '../../config/numericConfig';
import {
    findOption,
    parseCappedPositiveInteger,
    parseNumberListOfSize,
} from './options';
import { buildParamScope } from './params';
import { compileConstraintStatements } from './statementShell';

/** 求解语句允许的选项.
 *
 * - `variable` / `variables`:未知量(单数与名单两种写法);
 * - `range` / `segments`:仅联立数值路径使用(搜索区间与网格分段数).
 */
const SOLVE_OPTION_NAMES = ['variable', 'variables', 'range', 'segments'] as const;

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

/** WASM `solve_system` 返回的 JSON 形状(与 Rust `SystemOutcome` 对齐). */
interface SystemOutcomeJson {
    variables: string[];
    problem_latex: string;
    solution_latex: string | null;
    solution_count: number;
    steps: Array<{ latex: string; reason: string; kind: string }>;
    /** 能力边界理由;null 表示求解成功. */
    error: string | null;
    /** 内核实际用的方法:`"exact"` 或 `"numeric"`. */
    method: string;
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

function toSteps(raw: Array<{ latex: string; reason: string; kind: string }>): SolveStep[] {
    return raw.map((entry) => ({
        latex: entry.latex,
        reason: entry.reason,
        kind: toStepKind(entry.kind),
    }));
}

/**
 * 解析未知量选项:`variables = x, y` 优先,否则退到单数 `variable = x`.
 *
 * 两种写法都接受,是因为单方程习惯写 `variable`,联立习惯写 `variables`;
 * 内核侧统一收成名单.
 */
function parseVariableNames(statement: SolveStatement): string[] {
    const plural = findOption(statement.options, 'variables');
    if (plural !== undefined) {
        return plural
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
    }
    const single = findOption(statement.options, 'variable')?.trim();
    return single ? [single] : [];
}

/** 隐藏项的占位:保留方程原文与理由位,不调用内核. */
function disabledTask(name: string, equations: string[]): SolveTask {
    return {
        name,
        // 隐藏项没有算过:单方程取保守的 exact,方程组取 auto(精确优先 + 数值回退).
        method: equations.length > 1 ? 'auto' : 'exact',
        unknowns: [],
        equations: [...equations],
        equation: equations.join('; '),
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

/** 单方程:走既有内核,保持原线格式与原步骤口径. */
function compileSingleEquation(
    statement: SolveStatement,
    variables: string[],
    coefficientNames: string[],
    coefficientValues: Float64Array,
): SolveTask {
    if (variables.length > 1) {
        throw new Error(
            `求解 ${statement.name} 只有一个方程,但给了 ${variables.length} 个变量`,
        );
    }
    if (
        findOption(statement.options, 'range') !== undefined
        || findOption(statement.options, 'segments') !== undefined
    ) {
        throw new Error(
            `求解 ${statement.name} 的 range/segments 只对联立方程组有意义`,
        );
    }

    const outcome = JSON.parse(
        wasmSolveEquation(
            statement.equations[0],
            variables[0] ?? '',
            coefficientNames,
            coefficientValues,
        ),
    ) as SolveOutcomeJson;
    return {
        name: statement.name,
        // 统一词汇:单方程恒为精确后端;`unknowns` 是 `variable` 的列表形式.
        method: 'exact',
        unknowns: outcome.variable === '' ? [] : [outcome.variable],
        equations: [...statement.equations],
        equation: statement.equations[0],
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
    };
}

/** 联立:走方程组内核,线性精确 / 非线性数值由内核按 `auto` 决定. */
function compileEquationSystem(
    statement: SolveStatement,
    variables: string[],
    coefficientNames: string[],
    coefficientValues: Float64Array,
): SolveTask {
    const rangeRaw = findOption(statement.options, 'range');
    const domain = rangeRaw !== undefined
        ? parseNumberListOfSize(rangeRaw, 2, `联立 ${statement.name} 的 range`)
        : [];
    const segments =
        parseCappedPositiveInteger(
            findOption(statement.options, 'segments'),
            `联立 ${statement.name} 的 segments`,
            NUMERIC_CONFIG.limits.system.maxSegments,
        ) ?? 0;

    const outcome = JSON.parse(
        wasmSolveSystem(
            JSON.stringify({
                equations: statement.equations,
                variables,
                coeff_names: coefficientNames,
                // Float64Array 直接 stringify 会变成 "0"/"1" 键的对象,必须展开.
                coeff_values: [...coefficientValues],
                domain,
                segments,
                method: 'auto',
            }),
        ),
    ) as SystemOutcomeJson;

    // 内核如实回报实际走的方法;能力边界可能停在 auto(还没选定后端),原样保留.
    const method: SolveMethod =
        outcome.method === 'numeric'
            ? 'numeric'
            : outcome.method === 'exact'
                ? 'exact'
                : 'auto';
    return {
        name: statement.name,
        method,
        unknowns: outcome.variables,
        equations: [...statement.equations],
        // 展示用原文:联立用 `; ` 连接,纯文本回退时读者能看出是方程组.
        equation: statement.equations.join('; '),
        variable: outcome.variables.join(', '),
        equationLatex: outcome.problem_latex,
        solutionLatex: outcome.solution_latex,
        realRootCount: outcome.solution_count,
        identity: false,
        steps: toSteps(outcome.steps),
        error: outcome.error,
        enabled: true,
    };
}

/**
 * 编译全部 solve 语句.
 *
 * 参数系数一次算好(`scope` 覆盖全部已声明参数),因此方程里出现未声明符号时
 * 内核会明确报"未声明参数",而不是静默当成 0.
 *
 * 查重 / 选项校验 / 语句级错误定位 / hidden 语义由
 * `compileConstraintStatements` 统一提供(与求交同一外壳).
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

    return compileConstraintStatements(
        ast,
        (statement): statement is SolveStatement => statement.type === 'solve',
        '求解',
        SOLVE_OPTION_NAMES,
        hiddenSolveNames,
        (statement, hidden) => {
            if (hidden) {
                return disabledTask(statement.name, statement.equations);
            }
            const variables = parseVariableNames(statement);
            return statement.equations.length <= 1
                ? compileSingleEquation(
                    statement,
                    variables,
                    coefficientNames,
                    coefficientValues,
                )
                : compileEquationSystem(
                    statement,
                    variables,
                    coefficientNames,
                    coefficientValues,
                );
        },
    );
}
