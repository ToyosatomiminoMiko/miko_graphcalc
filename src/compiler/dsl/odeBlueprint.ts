/**
 * 微分方程(斜率场 + 解曲线)的**实体层**编译:语句 -> blueprint 组 + 展示事实.
 *
 * 从 staticScene.ts 拆出(该文件只保留静态场景编排与缓存);与
 * antiderivativeBlueprint.ts 同一条分工:**内核只调一次**,这里产出实体
 * blueprint 与展示事实,求值层(odeTasks.ts)只消费事实.
 *
 * 一条 `ode` 语句会下发多个实体,因此本模块按"斜率场 / 解曲线"两段构建,
 * id 从 `firstId` 起连续分配,并由 `fact.slopeObjectId`/`fact.curveNames`
 * 记录回来(调用方按返回顺序登记,见 staticScene.ts 的 collectOdeObjects).
 *
 * 表达式工具(坐标轴重命名/常数符号替换/解族取值)在叶子模块
 * odeExpressions.ts,本模块与求值层共用它,避免互相 import 成环.
 */
import type { OdeStatement, OptionPair } from '../../contract/ast';
import type { ParamDeclaration, SolveStepKind } from '../../contract/ir';
import { NUMERIC_CONFIG } from '../../config/numericConfig';
import {
    assertKnownOptions,
    findOption,
    parseNumberList,
    parseOptionalSegments,
    stripQuotes,
    toFiniteNumber,
} from './options';
import { extractSymbolNames, normalizeExpression } from './expression';
import {
    familyConstants,
    familyCurveName,
    familySubstitutions,
    ODE_OPTION_NAMES,
    renameCoordinateSymbols,
    substituteConstantSymbols,
} from './odeExpressions';
import { solve_ode as wasmSolveOde } from '../../generated/math_rs/math_rs';
import { toSolveStepKind } from './stepKinds';
import type { CurveBlueprint, SurfaceBlueprint } from './objects/types';

/**
 * 一条微分方程的编译事实:实体 blueprint + 求值条目要用的展示数据
 * (设计文档 `docs/plan3.md` 第 1.3 节).
 *
 * 与不定积分同一条分工:内核只调**一次**(在静态场景层),表达式(实体侧)与
 * 步骤链(展示侧)天然同源;`odeTasks.ts` 只消费这份事实.
 */
export interface OdeFact {
    /** 方程原文. */
    equation: string;
    dependent: string;
    independent: string;
    order: number;
    equationLatex: string;
    generalLatex: string | null;
    particularLatex: string | null;
    /** 通解是不是隐式形式(`Φ(x,y) = C`). */
    implicit: boolean;
    arbitraryConstantCount: number;
    initialConditions: string[];
    verified: boolean;
    steps: Array<{ latex: string; reason: string; kind: SolveStepKind }>;
    error: string | null;
    notes: string[];
    /** 斜率场 LaTeX(`f(x,y)`);没有时为空串. */
    slopeLatex: string;
    /** 斜率场实体 id;0 表示没下发. */
    slopeObjectId: number;
    /** 解曲线实体名(特解在前,解族在后). */
    curveNames: string[];
}

/** 内核 `solve_ode` 返回的 JSON 形状(与 Rust `OdeOutcome` 对齐). */
interface OdeOutcomeJson {
    equation_latex: string;
    independent: string;
    dependent: string;
    order: number;
    general_latex: string | null;
    particular_latex: string | null;
    general_text: string;
    particular_text: string;
    implicit: boolean;
    arbitrary_constants: number;
    constant_symbols: string[];
    slope_text: string;
    slope_latex: string;
    verified: boolean;
    steps: Array<{ latex: string; reason: string; kind: string }>;
    error: string | null;
    notes: string[];
}

/**
 * 把 `ode 名称 = 方程[, 初值...] [选项];` 编译成实体对象 + 展示事实
 * (设计文档 `docs/plan3.md` 的 P1-A/P2-A).
 *
 * 下发的对象(**P1-A:复用既有渲染器,零新增**):
 * 1. `<名字>`:`surface z = f(x, y)` -- 方程右端就是**斜率场**(高度图);
 * 2. `<名字>_p`:特解曲线(写了初值时);
 * 3. `<名字>_c1.._cN`:解族曲线(`curves = N` 时按常数取值各一条).
 *
 * 三条口径:
 * - **参数保持符号**:内核只收参数名,解里因此留着 `p`/`q`/`a`,数值由物化层
 *   按当前滑块折叠(这条教训的完整理由见 antiderivativeBlueprint.ts 的
 *   "系数表故意留空"注释);
 * - **隐式解不下发曲线**:`Φ(x,y)=C` 没法当 `y=f(x)` 求值,内核会给 `notes`
 *   如实说明,列表里只留公式(设计文档 P3-A);
 * - **坐标轴重命名**:渲染层只认 `x`/`y`,自变量是 `t`,因变量是 `u` 时按名替换
 *   (`odeExpressions.renameCoordinateSymbols`),并在 `notes` 里写明.
 */
export function buildOdeBlueprints(
    statement: OdeStatement,
    firstId: number,
    params: ReadonlyMap<string, ParamDeclaration>,
): { blueprints: Array<CurveBlueprint | SurfaceBlueprint>; fact: OdeFact } {
    const context = `微分方程 ${statement.name}`;
    assertKnownOptions(statement.options, ODE_OPTION_NAMES, context);
    const dependentName = (findOption(statement.options, 'dependent') ?? '').trim();
    const independentName = (findOption(statement.options, 'independent') ?? '').trim();
    // 只给**名字**不给值:解里的参数保持符号(与二期同一条教训).
    const outcome = JSON.parse(
        wasmSolveOde(
            statement.equation,
            statement.initialConditions,
            dependentName,
            independentName,
            [...params.keys()],
        ),
    ) as OdeOutcomeJson;

    const fact = buildOdeFact(statement, outcome);
    // range 选项按长度分派:2 个数是解曲线区间,4 个数同时给斜率场域.
    const { curveRange, surfaceRange } = parseOdeRanges(statement.options, context);
    const explicitColor = findOption(statement.options, 'color');
    const segments = parseOptionalSegments(statement.options, `${context} 的 segments`);
    const constant = parseOdeConstant(statement.options, context);
    const curveCount = parseOdeCurves(statement.options, context);

    const blueprints: Array<CurveBlueprint | SurfaceBlueprint> = [];
    let nextId = firstId;

    // 1) 斜率场(右端 `f(x,y)`):能力边界时也可能有(方程本身读得出来).
    const slope = buildOdeSlopeBlueprint(
        statement,
        outcome,
        nextId,
        explicitColor,
        surfaceRange,
        segments,
        fact.equation,
    );
    if (slope) {
        blueprints.push(slope);
        fact.slopeObjectId = nextId;
        nextId += 1;
    }

    // 2) 解曲线:特解优先,随后按 `curves` 选项给解族.
    const curveColor = stripQuotes(
        explicitColor ?? NUMERIC_CONFIG.colorPalette[nextId % NUMERIC_CONFIG.colorPalette.length],
    );
    blueprints.push(
        ...buildOdeCurveBlueprints(
            statement,
            outcome,
            fact,
            nextId,
            curveColor,
            curveRange,
            segments,
            constant,
            curveCount,
        ),
    );

    return { blueprints, fact };
}

/** 内核产物 -> 展示事实(不含实体 id,那些在 blueprint 分配时回填). */
function buildOdeFact(statement: OdeStatement, outcome: OdeOutcomeJson): OdeFact {
    return {
        equation: statement.equation.trim(),
        dependent: outcome.dependent,
        independent: outcome.independent,
        order: outcome.order,
        equationLatex: outcome.equation_latex,
        generalLatex: outcome.general_latex,
        particularLatex: outcome.particular_latex,
        implicit: outcome.implicit,
        arbitraryConstantCount: outcome.arbitrary_constants,
        initialConditions: statement.initialConditions,
        verified: outcome.verified,
        steps: outcome.steps.map((entry) => ({
            latex: entry.latex,
            reason: entry.reason,
            kind: toSolveStepKind(entry.kind),
        })),
        error: outcome.error,
        notes: [...outcome.notes],
        slopeLatex: outcome.slope_latex,
        slopeObjectId: 0,
        curveNames: [],
    };
}

/**
 * `range` 选项:2 个数是解曲线区间,4 个数同时给斜率场域(设计文档 P1-A).
 * 两种长度都要求每一维 `min < max`;其他长度直接报错.
 */
function parseOdeRanges(
    options: OptionPair[],
    context: string,
): {
    curveRange: [number, number] | undefined;
    surfaceRange: [number, number, number, number] | undefined;
} {
    let curveRange: [number, number] | undefined;
    let surfaceRange: [number, number, number, number] | undefined;
    const rawRange = findOption(options, 'range');
    if (rawRange === undefined) return { curveRange, surfaceRange };

    const values = parseNumberList(rawRange, `${context} 的 range`);
    if (values.length === 2) {
        if (values[0] >= values[1]) {
            throw new Error(`${context} 的 range 需要 min < max`);
        }
        curveRange = [values[0], values[1]];
    } else if (values.length === 4) {
        if (values[0] >= values[1] || values[2] >= values[3]) {
            throw new Error(`${context} 的 range 需要 min < max`);
        }
        curveRange = [values[0], values[1]];
        surfaceRange = [values[0], values[1], values[2], values[3]];
    } else {
        throw new Error(`${context} 的 range 需要 2 个或 4 个数`);
    }
    return { curveRange, surfaceRange };
}

/** 斜率场 `z = f(x, y)`;右端为空串(能力边界)时返回 null,不下发实体. */
function buildOdeSlopeBlueprint(
    statement: OdeStatement,
    outcome: OdeOutcomeJson,
    id: number,
    explicitColor: string | undefined,
    surfaceRange: [number, number, number, number] | undefined,
    segments: number | undefined,
    equation: string,
): SurfaceBlueprint | null {
    if (outcome.slope_text === '') return null;
    const renamed = renameCoordinateSymbols(
        outcome.slope_text,
        outcome.independent,
        outcome.dependent,
    );
    const expr = normalizeExpression(renamed.expr);
    return {
        kind: 'surface',
        id,
        name: statement.name,
        expr,
        coefficientNames: extractSymbolNames(expr, new Set(['x', 'y'])),
        color: stripQuotes(
            explicitColor ?? NUMERIC_CONFIG.colorPalette[id % NUMERIC_CONFIG.colorPalette.length],
        ),
        range: surfaceRange ?? [...NUMERIC_CONFIG.surface.defaultRange],
        segments,
        odeOrigin: {
            role: 'slope',
            statement: statement.name,
            equation,
            constant: null,
        },
    };
}

/**
 * 解曲线:特解在前,随后按 `curves = N` 给解族(常数取值见 familyConstants).
 *
 * id 从 `firstCurveId` 连续分配,名字同步写回 `fact.curveNames`(隐藏整条
 * 语句时按名字前缀过滤实体,见 contract/ir.ts 的 OdeOrigin).
 */
function buildOdeCurveBlueprints(
    statement: OdeStatement,
    outcome: OdeOutcomeJson,
    fact: OdeFact,
    firstCurveId: number,
    color: string,
    curveRange: [number, number] | undefined,
    segments: number | undefined,
    constant: number,
    curveCount: number,
): CurveBlueprint[] {
    const blueprints: CurveBlueprint[] = [];
    let nextId = firstCurveId;

    const pushCurve = (
        name: string,
        text: string,
        role: 'particular' | 'family',
        value: number | null,
    ): void => {
        const renamed = renameCoordinateSymbols(text, outcome.independent, outcome.dependent);
        const expr = normalizeExpression(renamed.expr);
        blueprints.push({
            kind: 'curve',
            id: nextId,
            name,
            expr,
            coefficientNames: extractSymbolNames(expr, new Set(['x'])),
            color,
            range: curveRange,
            segments,
            odeOrigin: {
                role,
                statement: statement.name,
                equation: fact.equation,
                constant: value,
            },
        });
        fact.curveNames.push(name);
        nextId += 1;
    };

    if (outcome.particular_text !== '') {
        pushCurve(`${statement.name}_p`, outcome.particular_text, 'particular', null);
    }
    if (outcome.general_text !== '' && curveCount > 0) {
        const constants = familyConstants(outcome.order, curveCount, constant);
        constants.forEach((value, index) => {
            const subs = familySubstitutions(outcome.constant_symbols, value);
            const text = substituteConstantSymbols(outcome.general_text, subs);
            pushCurve(
                familyCurveName(statement.name, index + 1),
                text,
                'family',
                Array.isArray(value) ? null : (value as number),
            );
        });
    }
    // 隐式解不下发曲线的原因由内核的 `notes` 如实给出(见 ode.rs 各分支),
    // 这里不重复叠一条同义提示.
    return blueprints;
}

/** `constant` 选项:解族取值(缺省 0). */
function parseOdeConstant(options: OptionPair[], context: string): number {
    const raw = findOption(options, 'constant');
    if (raw === undefined) return 0;
    return toFiniteNumber(raw, `${context} 的 constant`);
}

/** `curves` 选项:画几条解曲线(缺省 0 = 只画斜率场). */
function parseOdeCurves(options: OptionPair[], context: string): number {
    const raw = findOption(options, 'curves');
    if (raw === undefined) return 0;
    const value = toFiniteNumber(raw, `${context} 的 curves`);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${context} 的 curves 需要是非负整数`);
    }
    return Math.min(value, NUMERIC_CONFIG.limits.ode.maxCurves);
}
