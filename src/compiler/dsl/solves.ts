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
 * - 隐藏语义沿用约定 1("先完整校验,后禁用,仅跳过计算"):选项/重名/语句形状
 *   照常校验(`assertSolveShape` 在 hidden 分支**之前**执行),只是不再调用求解
 *   内核,`equationLatex` 留空由 UI 回退成方程原文(纯文本)--隐藏项没算过,
 *   不该假装有排版产物.
 *
 * ## 单方程与联立的分派
 *
 * `equations.length === 1` 走既有单方程内核(`solve_equation`,保持原线格式与
 * 原步骤口径);多条走联立内核(`solve_system`,JSON payload).两者的产物映射到
 * 同一个 `SolveTask`:`unknowns` 是未知量列表,`equations` 是方程原文列表
 * (见 contract/ir.ts 的 SolveTask;展示用的连接文案由 UI 从这两个字段派生,
 * IR 里不再各存一份派生字符串).
 */
import type { AstProgram, SolveStatement } from '@/contract/ast';
import type {
    ParamDeclaration,
    SolveMethod,
    SolveStep,
    SolveStepKind,
    SolveTask,
} from '@/contract/ir';
import { SOLVE_STEP_KINDS } from '@/contract/ir';
import {
    solve_equation as wasmSolveEquation,
    solve_system as wasmSolveSystem,
} from '@/generated/math_rs/math_rs';
import { NUMERIC_CONFIG } from '@/config/numericConfig';
import {
    findOption,
    parseCappedPositiveInteger,
    parseRangeList,
} from './options';
import { buildParamScope } from './params';
import { compileConstraintStatements } from './statementShell';

/** 求解语句允许的选项.
 *
 * - `variable` / `variables`:未知量(单数与名单两种写法);
 * - `range` / `segments`:仅联立数值路径使用(搜索区间与网格分段数);
 * - `method`:后端选择(`auto` / `exact` / `numeric`),缺省 `auto`.
 */
const SOLVE_OPTION_NAMES = ['variable', 'variables', 'range', 'segments', 'method'] as const;

/** `method` 选项的取值域(与 Rust `solve_core::SolveMethod` 同域). */
const SOLVE_METHODS: readonly SolveMethod[] = ['auto', 'exact', 'numeric'];

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
 *
 * `variables` 存在但一个名字都没写(如 `variables = ,`)时不回退到单数:
 * 那会让"写错了"看起来像"没写".
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

/**
 * 解析 `method` 选项;缺省 / 空串按 `auto`(由内核按问题形状选后端).
 *
 * 取值必须在 DSL 侧就报错:拼错 `method = numric` 却静默走 auto,比直接报错
 * 难查得多(与未知选项同一条约定).
 */
function parseMethod(statement: SolveStatement): SolveMethod {
    const raw = findOption(statement.options, 'method')?.trim();
    if (raw === undefined || raw === '') return 'auto';
    if (!(SOLVE_METHODS as readonly string[]).includes(raw)) {
        throw new Error(
            `求解 ${statement.name} 的 method 只接受 ${SOLVE_METHODS.join(' / ')},当前为 ${raw}`,
        );
    }
    return raw as SolveMethod;
}

/**
 * 语句形状校验:**与"算不算"无关**,所以 hidden 也必须过(约定 1).
 *
 * 这些是"源码写错",一律带语句 span 抛出;"读得出来但超出内核"的判断在 Rust
 * 内核里,作为**结果**落在 `SolveTask.error`.两者不能混:源码写错被静默跳过
 * (或超纲被当成语法错误)都会让用户按错误的方向改代码.
 */
function assertSolveShape(
    statement: SolveStatement,
    variables: string[],
    method: SolveMethod,
): void {
    const isSystem = statement.equations.length > 1;
    if (isSystem) return;

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
    if (method === 'numeric') {
        throw new Error(
            `求解 ${statement.name} 的单方程还没有数值后端:method 只能用 auto / exact`,
        );
    }
}

/**
 * 隐藏项的占位:保留方程原文与理由位,不调用内核.
 *
 * `method` 记**请求**的方法(隐藏项没调用内核,没有"实际方法"可报):
 * 隐藏的联立保留选项值,隐藏的单方程恒为 `exact`(`assertSolveShape` 已经挡住
 * 了单方程 + `numeric`).
 */
function disabledTask(
    name: string,
    equations: string[],
    method: SolveMethod,
): SolveTask {
    return {
        name,
        method: equations.length > 1 ? method : 'exact',
        unknowns: [],
        equations: [...equations],
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
        // 统一词汇:单方程只有精确后端(`numeric` 已被 assertSolveShape 挡住).
        method: 'exact',
        unknowns: outcome.variable === '' ? [] : [outcome.variable],
        equations: [...statement.equations],
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

/** 联立:走方程组内核,线性精确 / 非线性数值由内核按 `method` 决定. */
function compileEquationSystem(
    statement: SolveStatement,
    variables: string[],
    coefficientNames: string[],
    coefficientValues: Float64Array,
    requestedMethod: SolveMethod,
): SolveTask {
    const rangeRaw = findOption(statement.options, 'range');
    const domain = rangeRaw !== undefined
        ? parseRangeList(rangeRaw, `联立 ${statement.name} 的 range`)
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
                method: requestedMethod,
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
 * `compileConstraintStatements` 统一提供(与求交同一外壳);**形状校验在
 * hidden 分支之前**,这样隐藏项与显示项报同样的源码错误.
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
            const variables = parseVariableNames(statement);
            const method = parseMethod(statement);
            assertSolveShape(statement, variables, method);
            if (hidden) {
                return disabledTask(statement.name, statement.equations, method);
            }
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
                    method,
                );
        },
    );
}
