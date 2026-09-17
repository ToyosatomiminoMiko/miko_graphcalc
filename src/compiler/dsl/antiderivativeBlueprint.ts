/**
 * 不定积分(原函数)的**实体层**编译:语句 -> curve/surface blueprint + 展示事实.
 *
 * 从 staticScene.ts 拆出(该文件只保留静态场景编排与缓存,见其文件头):
 * 这里是"声明级建模"里体量最大的一块--表达式来自内核,积分常数并入
 * 表达式,定义域/外观继承源对象,三条口径都与静态场景的通用流程无关,单独
 * 成文件后两者的修改面互不干扰.
 *
 * 硬约束:**内核只调一次**.本模块同时产出实体 blueprint 与展示事实
 * (题目/原函数 LaTeX/验证结论/步骤链),求值层(antiderivativeTasks.ts)
 * 只消费那份事实,不再自己调内核--两处各调一次会在改内核时留下漂移风险
 * (同款口径见 solves.ts).
 */
import type { AntiderivativeStatement } from '@/contract/ast';
import type { AntiderivativeOrigin, SolveStepKind } from '@/contract/ir';
import {
    assertKnownOptions,
    findOption,
    parseNumberListOfSize,
    parseOptionalSegments,
} from './options';
import { extractSymbolNames } from './expression';
import { antiderivative as wasmAntiderivative } from '@/generated/math_rs/math_rs';
import { toSolveStepKind } from './stepKinds';
import type {
    CurveBlueprint,
    ObjectBlueprint,
    SurfaceBlueprint,
} from './objects/types';

/** `antiderivative` 语句允许的选项(外观与 range 继承源对象,可选覆盖). */
export const ANTIDERIVATIVE_OPTION_NAMES = [
    'color',
    'range',
    'segments',
    'constant',
    'variable',
] as const;

/**
 * 一条不定积分的编译事实:实体 blueprint + 求值条目要用的展示数据.
 *
 * 为什么把两者一起返回:内核只调**一次**,表达式(实体侧)与步骤链(展示侧)
 * 天然同源;分两处各调一次会在改内核时留下漂移风险(见 `antiderivativeTasks.ts`
 * 文件头).
 */
export interface AntiderivativeFact {
    sourceKind: 'curve' | 'surface';
    variable: string;
    integrand: string;
    integrandLatex: string;
    antiderivativeText: string;
    antiderivativeLatex: string;
    constant: number;
    constantSymbol: string;
    verified: boolean;
    steps: Array<{ latex: string; reason: string; kind: SolveStepKind }>;
    error: string | null;
}

/** 成功/失败两条分支共用的字段(见 AntiderivativeFact). */
type AntiderivativeFactBase = Pick<
    AntiderivativeFact,
    'sourceKind' | 'variable' | 'integrand' | 'constant' | 'constantSymbol'
>;

/** 内核 `antiderivative` 返回的 JSON 形状(与 Rust `AntiderivativeOutcome` 对齐). */
interface AntiderivativeOutcomeJson {
    integrand_latex: string;
    antiderivative_latex: string;
    antiderivative_text: string;
    verified: boolean;
    steps: Array<{ latex: string; reason: string; kind: string }>;
    error: string | null;
}

/**
 * 把 `antiderivative 名称 = antiderivative(源对象 [, 变量])` 编译成一个新对象
 * (设计文档 `docs/calculus-suite-plan.md` 第 3 节),并带回展示事实.
 *
 * 口径:
 * 1. **表达式来自内核**:`math_rs::symbolic::integral` 给出原函数文本(参数按
 *    声明值折叠)与步骤链;
 * 2. **积分常数并入表达式**:`constant` 选项(缺省 0)直接加在表达式上,对象
 *    因此可求值,展示层仍写 `+C`;
 * 3. **定义域/外观继承源对象**:颜色与 range 缺省取源对象,显式选项优先;
 * 4. **能力边界不是源码错误**:非初等/超出规则时返回 `blueprint: null` +
 *    `fact.error`,调用方保留占位条目而不是抛异常.
 */
export function buildAntiderivativeBlueprint(
    statement: AntiderivativeStatement,
    id: number,
    blueprintByName: Map<string, ObjectBlueprint>,
): { blueprint: CurveBlueprint | SurfaceBlueprint | null; fact: AntiderivativeFact } {
    const { planeSource, variable } = resolveAntiderivativeSource(statement, blueprintByName);
    const outcome = runAntiderivativeKernel(planeSource, variable);
    const constant = parseIntegrationConstant(statement);
    const baseFact: AntiderivativeFactBase = {
        sourceKind: planeSource.kind,
        variable,
        integrand: planeSource.expr,
        constant,
        constantSymbol: 'C',
    };

    if (outcome.error !== null) {
        return { blueprint: null, fact: buildFailedFact(baseFact, outcome) };
    }

    // 积分常数并入表达式:对象因此可求值,展示层仍写 `+C`.
    const expr = constant === 0
        ? outcome.antiderivative_text
        : `(${outcome.antiderivative_text}) + (${constant})`;
    const origin: AntiderivativeOrigin = {
        integrandExpr: planeSource.expr,
        variable: variable === 'y' ? 'y' : 'x',
        constant,
    };

    return {
        blueprint: buildProductBlueprint(statement, id, planeSource, expr, origin),
        fact: buildSuccessFact(baseFact, outcome),
    };
}

/**
 * 解析并校验源对象与积分变量.
 *
 * 顺序与原实现一致:源存在 -> 源类型 -> 选项白名单 -> 变量合法性,
 * 保证报错文案与"先报哪一条"都不随重构改变.
 */
function resolveAntiderivativeSource(
    statement: AntiderivativeStatement,
    blueprintByName: Map<string, ObjectBlueprint>,
): { planeSource: CurveBlueprint | SurfaceBlueprint; variable: string } {
    const sourceBlueprint = blueprintByName.get(statement.source.trim());
    if (sourceBlueprint === undefined) {
        throw new Error(
            `不定积分 ${statement.name} 引用了不存在的对象 ${statement.source}`,
        );
    }
    if (sourceBlueprint.kind !== 'curve' && sourceBlueprint.kind !== 'surface') {
        throw new Error(`不定积分 ${statement.name} 只能应用于 curve 或 surface`);
    }
    const planeSource = sourceBlueprint;
    assertKnownOptions(statement.options, ANTIDERIVATIVE_OPTION_NAMES, `不定积分 ${statement.name}`);
    const variable = (statement.variable ?? 'x').trim();
    if (planeSource.kind === 'curve' && variable !== 'x') {
        throw new Error(`不定积分 ${statement.name} 的 curve 源只支持对 x 积分`);
    }
    if (planeSource.kind === 'surface' && variable !== 'x' && variable !== 'y') {
        throw new Error(`不定积分 ${statement.name} 的曲面源只能对 x 或 y 积分`);
    }
    return { planeSource, variable };
}

/**
 * 调内核求原函数.
 *
 * 系数表**故意留空**:内核把除积分变量以外的符号当常数,原函数里因此
 * 保留参数名(`a*x^3/3 - cos(x)`),参数值由物化层按当前滑块折叠.
 * 若在这里传 `buildParamScope(params, {})`,得到的表达式会把参数冻在
 * 声明默认值上:静态场景按 AST 缓存,拖滑块只重物化不重解析,曲线就再也
 * 不跟手了(这正是原函数必须挂在静态场景 blueprint 上的代价,已实测).
 */
function runAntiderivativeKernel(
    planeSource: CurveBlueprint | SurfaceBlueprint,
    variable: string,
): AntiderivativeOutcomeJson {
    const declaredSymbols = declaredSymbolsFor(planeSource, variable);
    return JSON.parse(
        wasmAntiderivative(
            planeSource.expr,
            variable,
            [...declaredSymbols],
            new Float64Array(),
        ),
    ) as AntiderivativeOutcomeJson;
}

/**
 * 传给内核的"已声明符号"名单:只给**名字**不给值,内核据此把这些符号当
 * 已声明并保留在结果里(`a*x^3/3 - cos(x)`),数值由物化层按当前滑块折叠.
 *
 * 名单必须同时包含:
 * - 源对象的参数(`a`):原函数里保持符号,拖滑块才跟手;
 * - 源表达式里出现的**另一个坐标**(对 y 积分时的 x):它对积分是常数,
 *   内核只认"已声明"的符号,漏掉就会报"未声明符号 x"(实测踩过).
 */
function declaredSymbolsFor(
    planeSource: CurveBlueprint | SurfaceBlueprint,
    variable: string,
): Set<string> {
    const declaredSymbols = new Set<string>(planeSource.coefficientNames);
    for (const name of extractSymbolNames(planeSource.expr, new Set())) {
        if (name !== variable) declaredSymbols.add(name);
    }
    return declaredSymbols;
}

/** `constant` 选项:并入对象表达式的积分常数(缺省 0,非数字按 0). */
function parseIntegrationConstant(statement: AntiderivativeStatement): number {
    const rawConstant = findOption(statement.options, 'constant');
    const parsedConstant = rawConstant === undefined ? 0 : Number(rawConstant);
    return Number.isFinite(parsedConstant) ? parsedConstant : 0;
}

/**
 * 按源对象 kind 生成继承外观的 curve/surface blueprint.
 *
 * 分支内先解析 range 再解析 segments:两条校验错误的先后顺序与原实现一致.
 */
function buildProductBlueprint(
    statement: AntiderivativeStatement,
    id: number,
    planeSource: CurveBlueprint | SurfaceBlueprint,
    expr: string,
    origin: AntiderivativeOrigin,
): CurveBlueprint | SurfaceBlueprint {
    const context = `不定积分 ${statement.name}`;
    const color = findOption(statement.options, 'color') ?? planeSource.color;
    const rangeOption = findOption(statement.options, 'range');

    if (planeSource.kind === 'curve') {
        const range = rangeOption
            ? (parseNumberListOfSize(rangeOption, 2, `${context} 的 range`) as [number, number])
            : planeSource.range;
        const segments = parseOptionalSegments(statement.options, `${context} 的 segments`) ?? planeSource.segments;
        return {
            kind: 'curve',
            id,
            name: statement.name,
            expr,
            // 依赖继承源对象的系数:参数变化要让这条对象重新物化.
            coefficientNames: [...planeSource.coefficientNames],
            color,
            range,
            segments,
            antiderivativeOrigin: origin,
        };
    }

    const range = rangeOption
        ? (parseNumberListOfSize(rangeOption, 4, `${context} 的 range`) as [
            number,
            number,
            number,
            number,
        ])
        : planeSource.range;
    const segments = parseOptionalSegments(statement.options, `${context} 的 segments`) ?? planeSource.segments;
    return {
        kind: 'surface',
        id,
        name: statement.name,
        expr,
        coefficientNames: [...planeSource.coefficientNames],
        color,
        range,
        segments,
        antiderivativeOrigin: origin,
    };
}

/** 能力边界(非初等/超出规则)的事实:题目 LaTeX 仍有效,原函数与步骤为空. */
function buildFailedFact(
    base: AntiderivativeFactBase,
    outcome: AntiderivativeOutcomeJson,
): AntiderivativeFact {
    return {
        ...base,
        integrandLatex: outcome.integrand_latex,
        antiderivativeText: '',
        antiderivativeLatex: '',
        verified: false,
        steps: [],
        error: outcome.error,
    };
}

/** 内核成功返回的事实:表达式与步骤链同源. */
function buildSuccessFact(
    base: AntiderivativeFactBase,
    outcome: AntiderivativeOutcomeJson,
): AntiderivativeFact {
    return {
        ...base,
        integrandLatex: outcome.integrand_latex,
        antiderivativeText: outcome.antiderivative_text,
        antiderivativeLatex: outcome.antiderivative_latex,
        verified: outcome.verified,
        steps: outcome.steps.map((entry) => ({
            latex: entry.latex,
            reason: entry.reason,
            kind: toSolveStepKind(entry.kind),
        })),
        error: null,
    };
}
