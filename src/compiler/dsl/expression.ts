/**
 * 表达式解析/归一化/求值/符号求导与数组解析的统一入口.
 *
 * 这里的解析和符号运算全部由 Rust/WASM 完成,TypeScript 只负责缓存和
 * 组合调用,不再依赖外部 JavaScript 数学库.
 */
import {
    evaluate_scalar as wasmEvaluateScalar,
    latex_expression as wasmLatexExpression,
    matrix4_from_expr as wasmMatrix4FromExpr,
    normalize_expression as wasmNormalizeExpression,
    parse_array_strings as wasmParseArrayStrings,
    symbolic_derivative as wasmSymbolicDerivative,
    symbolic_variables as wasmSymbolicVariables,
} from '../../wasm/math_rs/math_rs';

export type ExpressionArray = string | ExpressionArray[];

function throwExpressionError(raw: string, error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`表达式无法处理: ${raw} (${message})`);
}

/**
 * 把常见数学表达式归一化为 evalexpr/Rust 数值后端可执行的形式.
 *
 * 归一化结果按原表达式缓存;对象建模,分析,参数求值都走这里,
 * 避免同一个表达式在编译管线里被重复归一化.
 */
export function normalizeExpression(raw: string): string {
    const cached = rustExpressionCache.get(raw);
    if (cached !== undefined) return cached;
    try {
        const normalized = wasmNormalizeExpression(raw);
        rustExpressionCache.set(raw, normalized);
        return normalized;
    } catch (error) {
        throwExpressionError(raw, error);
    }
}

/** 把 DSL 表达式转成 UI 展示用的 LaTeX 字符串(内部实现,调用方走缓存入口). */
function latexExpression(raw: string): string {
    try {
        return wasmLatexExpression(raw);
    } catch (error) {
        throwExpressionError(raw, error);
    }
}

function evaluateRustScalar(
    expr: string,
    scope: Record<string, number>,
): number | null {
    const names = Object.keys(scope);
    const values = new Float64Array(names.map((name) => scope[name]));
    try {
        const value = wasmEvaluateScalar(
            expr,
            names,
            values,
            Number.NaN,
            Number.NaN,
            Number.NaN,
        );
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

export function evaluateNumber(
    raw: string,
    scope?: Record<string, number>,
): number | null {
    return evaluateRustScalar(normalizeExpression(raw), scope ?? {});
}

/**
 * 在世界坐标 (x, y, z) 处求值一个标量表达式.
 *
 * `evaluateNumber` 把 x/y/z 都置为 NaN,只适合"坐标不参与"的参数/选项
 * 求值;一维/二维/三维隐式场的 f 与 ∇f 求值需要真实坐标,因此单独给一个
 * 入口.表达式必须先归一化(调用方保证,或这里就地归一化),scope 里的名字
 * 不能与 x/y/z 冲突(与采样侧 build_base_context 的约定一致).
 *
 * 求值仍走 Rust/WASM 的 `evaluate_scalar`,失败或非有限值返回 null,
 * 由调用方给出与自身语义相关的错误文案.
 */
export function evaluateExpressionAt(
    expr: string,
    scope: Record<string, number>,
    x: number,
    y: number,
    z: number,
): number | null {
    const names = Object.keys(scope);
    const values = new Float64Array(names.map((name) => scope[name]));
    try {
        const value = wasmEvaluateScalar(
            normalizeExpression(expr),
            names,
            values,
            x,
            y,
            z,
        );
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

export function evaluateRequiredNumber(
    raw: string,
    scope: Record<string, number>,
    context: string,
): number {
    const value = evaluateNumber(raw, scope);
    if (value === null) {
        throw new Error(`${context} 无法求值: ${raw}`);
    }
    return value;
}

function symbolicDerivative(expr: string, variable: string): string {
    try {
        return wasmSymbolicDerivative(expr, variable);
    } catch (error) {
        throwExpressionError(`d(${expr})/d(${variable})`, error);
    }
}

export function extractSymbolNames(
    expr: string,
    excludedVariables: ReadonlySet<string> = new Set(),
): string[] {
    try {
        return Array.from(wasmSymbolicVariables(expr, [...excludedVariables]));
    } catch (error) {
        throwExpressionError(expr, error);
    }
}

export function parseArrayStrings(raw: string): ExpressionArray {
    try {
        return JSON.parse(wasmParseArrayStrings(raw)) as ExpressionArray;
    } catch (error) {
        throwExpressionError(raw, error);
    }
}

export function evaluateMatrixExpr(raw: string): number[] {
    try {
        return Array.from(wasmMatrix4FromExpr(raw));
    } catch (error) {
        throwExpressionError(raw, error);
    }
}

/**
 * 归一化表达式缓存:原表达式字符串 -> 归一化结果.
 * 键集通常有限,不做失效策略;模块级生命周期,跟随页面存活.
 */
const rustExpressionCache = new Map<string, string>();

/**
 * @cache
 * 缓存目的:避免对象列表每次重绘都对同一表达式调用 Rust/WASM 生成 LaTeX.
 * 键/失效策略:原表达式字符串 -> LaTeX 字符串;无失效机制,表达式集合通常有限.
 * 生命周期:模块级,跟随页面存活.
 */
const latexExpressionCache = new Map<string, string>();

/**
 * @cache
 * 缓存目的:缓存符号求导结果,避免参数刷新时重复计算偏导数.
 * 键/失效策略:原表达式 -> (变量 -> 导数表达式);无失效机制.
 * 生命周期:模块级,跟随页面存活.
 */
const derivativeExpressionCache = new Map<string, Map<string, string>>();

/**
 * @cache_access
 * 返回表达式的 LaTeX 展示字符串,命中缓存时直接返回.
 */
export function cachedLatexExpression(expr: string): string {
    let cached = latexExpressionCache.get(expr);
    if (!cached) {
        cached = latexExpression(expr);
        latexExpressionCache.set(expr, cached);
    }
    return cached;
}

/**
 * @cache_access
 * 返回表达式对指定变量的符号导数,命中缓存时直接返回.
 */
export function cachedDerivativeExpression(expr: string, variable: string): string {
    let byVariable = derivativeExpressionCache.get(expr);
    if (!byVariable) {
        byVariable = new Map<string, string>();
        derivativeExpressionCache.set(expr, byVariable);
    }

    let cached = byVariable.get(variable);
    if (!cached) {
        cached = symbolicDerivative(expr, variable);
        byVariable.set(variable, cached);
    }
    return cached;
}
