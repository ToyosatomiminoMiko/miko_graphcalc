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
} from '@/generated/math_rs/math_rs';

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
        setBounded(rustExpressionCache, raw, normalized, EXPRESSION_CACHE_LIMIT);
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
 * 不能与 x/y/z 冲突(与采样侧 build_coefficients 的约定一致).
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
 * 三个模块级表达式缓存的容量上限.
 *
 * 为什么必须有界:表达式来自用户可编辑源码,每敲一个字符都可能产生新的
 * 表达式字符串,而这些 Map 是模块级,跟随页面存活.注释里"键集通常有限"
 * 只在静态场景成立,长会话持续编辑源码就是只增不回收的内存泄漏.
 * 512 远大于单屏公式数(几十条),热点表达式反复命中不会被淘汰,只是给
 * 无限增长的键集加一道硬上限.
 */
const EXPRESSION_CACHE_LIMIT = 512;

/**
 * 单个表达式的求导变量缓存上限:同一表达式一般只对 x/y/z 等少数变量
 * 求导,内层 Map 同样按插入序淘汰最旧变量,避免外层有界而内层无界.
 */
const DERIVATIVE_VARIABLE_CACHE_LIMIT = 8;

/**
 * 写入有界缓存:满员时先淘汰最旧(插入序)的一条.
 *
 * 已存在的键不淘汰:否则当它恰好是最旧条目时,会把刚命中的条目删掉,
 * 缓存反而永远存不住热点键.
 */
function setBounded<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
    if (!cache.has(key) && cache.size >= limit) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
}

/**
 * 归一化表达式缓存:原表达式字符串 -> 归一化结果.
 * 有界(EXPRESSION_CACHE_LIMIT,淘汰最旧);模块级生命周期,跟随页面存活.
 */
const rustExpressionCache = new Map<string, string>();

/**
 * @cache
 * 缓存目的:避免对象列表每次重绘都对同一表达式调用 Rust/WASM 生成 LaTeX.
 * 键/失效策略:原表达式字符串 -> LaTeX 字符串;有界
 *              (EXPRESSION_CACHE_LIMIT,淘汰最旧).
 * 生命周期:模块级,跟随页面存活.
 */
const latexExpressionCache = new Map<string, string>();

/**
 * @cache
 * 缓存目的:缓存符号求导结果,避免参数刷新时重复计算偏导数.
 * 键/失效策略:原表达式 -> (变量 -> 导数表达式);外层/内层都有界
 *              (EXPRESSION_CACHE_LIMIT / DERIVATIVE_VARIABLE_CACHE_LIMIT),
 *              各自淘汰最旧条目.
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
        setBounded(latexExpressionCache, expr, cached, EXPRESSION_CACHE_LIMIT);
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
        setBounded(derivativeExpressionCache, expr, byVariable, EXPRESSION_CACHE_LIMIT);
    }

    let cached = byVariable.get(variable);
    if (!cached) {
        cached = symbolicDerivative(expr, variable);
        setBounded(byVariable, variable, cached, DERIVATIVE_VARIABLE_CACHE_LIMIT);
    }
    return cached;
}
