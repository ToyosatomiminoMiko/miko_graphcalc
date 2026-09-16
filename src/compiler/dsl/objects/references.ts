/**
 * curve/surface 表达式里的对象引用(对象相加)解析.
 *
 * DSL 里一个 curve/surface 声明就是一个函数对象:`curve c1 = sin(x)` 是
 * y = f(x),`surface s1 = sin(x) * cos(y)` 是 z = f(x, y).本模块让这类
 * 函数对象的表达式可以**按名引用**其它同类对象,于是"曲线+曲线""曲面+
 * 曲面"就是普通的表达式运算:
 *
 * ```text
 * curve c1 = sin(x);
 * curve c2 = cos(x);
 * curve c3 = c1 + c2;      // y = sin(x) + cos(x)
 * ```
 *
 * 为什么必须在归一化之前做:表达式最终要交给 Rust 符号引擎/数值后端执行,
 * 它不认识对象名,`c1 + c2` 直接归一化只会把 c1/c2 当成自由参数(凭空多出
 * 两个同名滑块).所以引用替换一定发生在 `normalizeExpression` 之前,替换进去
 * 的是被引用对象**自己的表达式**,并递归展开,因此链式相加
 * (`curve c4 = c3 + c1`)与任意声明顺序都成立,只有成环才报错.
 *
 * 三条有意为之的边界(审查时请保留):
 * 1. 只有 `curve` 与 `surface` 参与这套引用,且必须同类(curve 只能引用
 *    curve,surface 只能引用 surface):不同维度的函数相加不是同一个几何
 *    对象.其它已声明的名字(volume/point/vector/implicit 对象,以及
 *    derivative/intersection/integral/analysis 产物)出现在 curve/surface
 *    表达式里会**报错**而不是被当成自由参数,避免静默变成滑块.
 * 2. 区间取所有被引用对象**有效区间**的交集(显式 range > 引用交集 >
 *    类型默认区间):相加后的函数只在共同定义域上有意义,交集为空直接报错,
 *    与 region 边界曲线的口径一致;当前语句自己显式写的 range 仍然优先.
 * 3. 参数名优先于对象名:`param c1` 与 `curve c1` 同名时,表达式里的 c1 仍按
 *    参数解释(既有语义不变);两者同名且被引用时给出"引用有歧义"的报错.
 *
 * 候选引用名不是"文本里长得像标识符的东西",而是 Rust 符号引擎给出的**自由
 * 符号**(extractSymbolNames,与系数提取同源):内置函数名,常量与坐标变量
 * 从一开始就不可能是引用,不需要在这里维护第二份内置名清单.替换时还会跳过
 * 紧跟 `(` 的标识符(那是函数调用位置,`c1(x + 1)` 会被符号引擎判成"暂不
 * 支持函数 c1"),因此"对象名恰好与内置函数同名"也不会劫持那个函数.
 *
 * 数值/渲染路径不读本模块的任何结构:展开后的表达式与区间照旧填进既有的
 * CurveBlueprint/SurfaceBlueprint,下游完全无感(见 ./build.ts 与
 * ../staticScene.ts).
 */
import { NUMERIC_CONFIG } from '../../../config/numericConfig';
import type { ObjectStatement } from '../../../contract/ast';
import { extractSymbolNames, normalizeExpression } from '../expression';
import { findOption, parseNumberListOfSize } from '../options';

export type FunctionObjectKind = 'curve' | 'surface';

/** curve 是 x 区间,surface 是 [xMin, xMax, yMin, yMax] 矩形. */
export type FunctionObjectRange =
    | [number, number]
    | [number, number, number, number];

export interface ResolvedObjectExpression {
    /** 展开对象引用后的表达式(已归一化,可直接进入 blueprint). */
    expr: string;
    /**
     * 被引用对象**有效区间**的交集;没有引用时为 null.
     *
     * 调用方据此区分"这条语句自己引用了别人"(用交集当默认区间)与"没有
     * 引用"(沿用对象类型默认区间),再把显式 range 放在两者之前.
     */
    range: FunctionObjectRange | null;
    /** 直接引用到的对象名,按首次出现顺序(供诊断与后续展示使用). */
    referencedNames: string[];
}

export interface ObjectReferenceResolver {
    /** 解析一条 curve/surface 语句的表达式:展开引用并给出引用区间交集. */
    resolve(statement: ObjectStatement): ResolvedObjectExpression;
}

/** 递归展开用的完整结果:除对外字段外还带"有效区间". */
interface ResolvedFunctionObject {
    expr: string;
    /** 直接引用对象有效区间的交集;没有引用为 null. */
    referencedRange: FunctionObjectRange | null;
    /** 有效区间 = 显式 range > 引用交集 > 类型默认区间. */
    effectiveRange: FunctionObjectRange;
    referencedNames: string[];
}

const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/g;

/** 坐标变量永远不是对象引用,即使有人把对象命名成 x/y/z. */
const COORDINATE_NAMES: ReadonlySet<string> = new Set(['x', 'y', 'z']);

function kindLabel(kind: FunctionObjectKind): string {
    return kind === 'curve' ? '曲线' : '曲面';
}

/**
 * 把表达式里的对象引用替换成 `(被引用对象的表达式)`.
 *
 * 只替换 pieces 里登记的名字(候选名来自符号引擎的自由符号,见
 * referencedNamesIn),因此内置函数名/常量不会被误替换.紧跟 `(` 的标识符
 * 是**函数调用位置**而不是值引用--符号引擎对 `c1(x + 1)` 直接报"表达式暂不
 * 支持函数 c1",所以这里保持原样:`curve cos = 1; curve c = cos(x) + cos;`
 * 里只有最后那个裸 `cos` 是引用,`cos(x)` 仍是余弦.`2(x + 1)` 这类隐式乘法
 * 是"数字后面跟括号",与标识符无关,不受影响.
 */
function substituteReferences(
    raw: string,
    pieces: ReadonlyMap<string, string>,
): string {
    if (pieces.size === 0) return raw;
    return raw.replace(
        IDENTIFIER_PATTERN,
        (token: string, offset: number, whole: string) => {
            const piece = pieces.get(token);
            if (piece === undefined) return token;
            return whole[offset + token.length] === '(' ? token : `(${piece})`;
        },
    );
}

function defaultRange(kind: FunctionObjectKind): FunctionObjectRange {
    return kind === 'curve'
        ? ([...NUMERIC_CONFIG.curve.defaultRange] as [number, number])
        : ([...NUMERIC_CONFIG.surface.defaultRange] as [number, number, number, number]);
}

/**
 * 从语句里读显式 range(与 ./build.ts 同一套解析与报错文案).
 *
 * 被引用对象的有效区间必须能回溯到它自己的声明,不能只看当前语句,所以
 * 引用解析里也要读一遍.文案与 build 保持一致(同一个 context 口径),
 * 谁先跑到都不会给出两套说法.
 */
function declaredRange(
    statement: ObjectStatement,
    context: string,
): FunctionObjectRange | null {
    const raw = findOption(statement.options, 'range');
    if (raw === undefined) return null;

    if (statement.kind === 'curve') {
        const values = parseNumberListOfSize(raw, 2, `${context} 的 range`);
        if (values[0] >= values[1]) {
            throw new Error(`${context} 的 range 需要 min < max`);
        }
        return [values[0], values[1]];
    }

    const values = parseNumberListOfSize(raw, 4, `${context} 的 range`);
    if (values[0] >= values[1] || values[2] >= values[3]) {
        throw new Error(`${context} 的 range 需要 min < max`);
    }
    return [values[0], values[1], values[2], values[3]];
}

/** 被引用对象区间的交集;为空时报错(相加后的函数没有公共定义域). */
function intersectRanges(
    ranges: readonly FunctionObjectRange[],
    kind: FunctionObjectKind,
    context: string,
): FunctionObjectRange {
    if (kind === 'curve') {
        let lo = -Infinity;
        let hi = Infinity;
        for (const range of ranges) {
            lo = Math.max(lo, range[0]);
            hi = Math.min(hi, range[1]);
        }
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
            throw new Error(`${context} 引用的对象 x 区间没有交集,相加后没有定义域`);
        }
        return [lo, hi];
    }

    let xLo = -Infinity;
    let xHi = Infinity;
    let yLo = -Infinity;
    let yHi = Infinity;
    for (const range of ranges) {
        xLo = Math.max(xLo, range[0]);
        xHi = Math.min(xHi, range[1]);
        // 按长度收窄到 4 元组(= surface 矩形);调用方已保证同类,这里只是
        // 让类型收窄,顺带对"混进 curve 区间"更宽容(只有 x 方向参与).
        if (range.length === 4) {
            yLo = Math.max(yLo, range[2]);
            yHi = Math.min(yHi, range[3]);
        }
    }
    if (
        !Number.isFinite(xLo) || !Number.isFinite(xHi) || xLo >= xHi
        || !Number.isFinite(yLo) || !Number.isFinite(yHi) || yLo >= yHi
    ) {
        throw new Error(`${context} 引用的对象 x/y 区间没有交集,相加后没有定义域`);
    }
    return [xLo, xHi, yLo, yHi];
}

/**
 * 建立一次静态场景编译期使用的引用解析器.
 *
 * @param statementsByName 所有对象声明(名字 -> 语句),用于递归展开引用.
 * @param declaredValueNames 所有"已声明的值名" -> 类型说明(例如
 *        `sphere 对象` / `derivative 产物`),用于把"引用了非 curve/surface
 *        的名字"识别成错误而不是自由参数;类型说明只进报错文案.
 * @param parameterNames 已声明参数名,决定参数/对象同名时的优先级.
 */
export function createObjectReferenceResolver(
    statementsByName: ReadonlyMap<string, ObjectStatement>,
    declaredValueNames: ReadonlyMap<string, string>,
    parameterNames: ReadonlySet<string>,
): ObjectReferenceResolver {
    /** 可作为引用目标的函数对象:只有 curve/surface. */
    const functionObjects = new Map<string, ObjectStatement>();
    for (const [name, statement] of statementsByName) {
        if (statement.kind === 'curve' || statement.kind === 'surface') {
            functionObjects.set(name, statement);
        }
    }

    /** 已解析对象的缓存(含有效区间),递归解析的 memo. */
    const resolvedCache = new Map<string, ResolvedFunctionObject>();

    /**
     * 判断表达式里的一个标识符是不是对象引用.
     *
     * 参数优先于对象(见文件头边界 3);两者同名时如果这个标识符真的出现在
     * 表达式里,就是无法消解的歧义,当场报错而不是猜一个.
     */
    function isReference(name: string, context: string): boolean {
        if (COORDINATE_NAMES.has(name)) return false;

        const isParameter = parameterNames.has(name);
        const functionObject = functionObjects.get(name);
        if (isParameter && functionObject) {
            throw new Error(
                `${context} 的 ${name} 既是参数又是${kindLabel(
                    functionObject.kind as FunctionObjectKind,
                )}对象,引用有歧义,请改名`,
            );
        }
        if (isParameter) return false;
        if (functionObject) return true;

        // 名字确实是"某个已声明的值"(体积/点/向量/implicit 对象,或求导/
        // 求交/积分/分析的产物),但它不是 curve/surface 对象声明:报错,
        // 而不是悄悄把它当成自由参数(那会凭空多出一个同名滑块).
        const declaredKind = declaredValueNames.get(name);
        if (declaredKind) {
            throw new Error(
                `${context} 引用了 ${name}(${declaredKind}):`
                + '对象相加只能引用已声明的 curve/surface 对象',
            );
        }
        return false;
    }

    /** 表达式里出现的对象引用名,按首次出现顺序去重. */
    function referencedNamesIn(raw: string, context: string): string[] {
        // 候选名一律取自 Rust 符号引擎的**自由符号**:函数名(sin/cos/...),
        // 常量(pi/e)与坐标变量 x/y/z 从这里就不可能被当成对象引用.这条
        // 口径与系数提取(extractCoefficientNames)完全同源,不在这里再维护
        // 第二份内置名清单(否则改内置函数时两边会漂移).
        const symbols = extractSymbolNames(raw, COORDINATE_NAMES);
        const names: string[] = [];
        for (const name of symbols) {
            if (isReference(name, context)) names.push(name);
        }
        return names;
    }

    /** 校验引用目标的类型一致,并解析它(递归 + 环检测). */
    function resolveTarget(
        reference: string,
        kind: FunctionObjectKind,
        context: string,
        stack: readonly string[],
    ): ResolvedFunctionObject {
        const target = functionObjects.get(reference)!;
        const targetKind = target.kind as FunctionObjectKind;
        if (targetKind !== kind) {
            throw new Error(
                `${context} 不能引用${kindLabel(targetKind)} ${reference}:`
                + `对象相加要求同为${kindLabel(kind)}`,
            );
        }
        return resolveByName(reference, stack);
    }

    /**
     * 递归解析一个已声明函数对象.
     *
     * stack 用于环检测:`curve a = b + 1; curve b = a + 1;` 会在这里报错,
     * 而不是无限递归.
     */
    function resolveByName(name: string, stack: readonly string[]): ResolvedFunctionObject {
        const cached = resolvedCache.get(name);
        if (cached) return cached;

        if (stack.includes(name)) {
            throw new Error(
                `对象 ${name} 的表达式循环引用: ${[...stack, name].join(' -> ')}`,
            );
        }

        const statement = functionObjects.get(name);
        if (!statement) {
            throw new Error(`对象 ${name} 未声明为 curve/surface`);
        }
        const kind = statement.kind as FunctionObjectKind;
        const context = `${kindLabel(kind)} ${name}`;
        const nextStack = [...stack, name];

        const referencedNames = referencedNamesIn(statement.expr, context);
        const pieces = new Map<string, string>();
        const referencedRanges: FunctionObjectRange[] = [];
        for (const reference of referencedNames) {
            const resolvedTarget = resolveTarget(reference, kind, context, nextStack);
            pieces.set(reference, resolvedTarget.expr);
            referencedRanges.push(resolvedTarget.effectiveRange);
        }

        const substituted = referencedNames.length === 0
            ? statement.expr
            : substituteReferences(statement.expr, pieces);

        const referencedRange = referencedNames.length === 0
            ? null
            : intersectRanges(referencedRanges, kind, context);

        const result: ResolvedFunctionObject = {
            expr: normalizeExpression(substituted),
            referencedRange,
            effectiveRange: declaredRange(statement, context)
                ?? referencedRange
                ?? defaultRange(kind),
            referencedNames,
        };
        resolvedCache.set(name, result);
        return result;
    }

    /** 合成语句(名字不在对象表里)的就地展开:不登记,但引用规则一致. */
    function resolveSynthetic(statement: ObjectStatement): ResolvedObjectExpression {
        const kind = statement.kind as FunctionObjectKind;
        const context = `${kindLabel(kind)} ${statement.name}`;
        const referencedNames = referencedNamesIn(statement.expr, context);
        if (referencedNames.length === 0) {
            return {
                expr: normalizeExpression(statement.expr),
                range: null,
                referencedNames,
            };
        }

        const pieces = new Map<string, string>();
        const referencedRanges: FunctionObjectRange[] = [];
        for (const reference of referencedNames) {
            const resolvedTarget = resolveTarget(reference, kind, context, []);
            pieces.set(reference, resolvedTarget.expr);
            referencedRanges.push(resolvedTarget.effectiveRange);
        }
        const substituted = substituteReferences(statement.expr, pieces);
        // 合成语句自己的 range 选项由调用方解析,这里只报告引用交集.
        return {
            expr: normalizeExpression(substituted),
            range: declaredRange(statement, context)
                ? null
                : intersectRanges(referencedRanges, kind, context),
            referencedNames,
        };
    }

    return {
        resolve(statement: ObjectStatement): ResolvedObjectExpression {
            // 常规路径:语句本身就登记在对象表里,走带缓存的递归解析.
            if (functionObjects.get(statement.name) === statement) {
                const resolved = resolveByName(statement.name, []);
                const context = `${kindLabel(statement.kind as FunctionObjectKind)} ${statement.name}`;
                return {
                    expr: resolved.expr,
                    // 显式 range 由调用方自己解析并优先使用;这里只报告
                    // "被引用对象的交集",没有引用才是 null.
                    range: declaredRange(statement, context) ? null : resolved.referencedRange,
                    referencedNames: resolved.referencedNames,
                };
            }
            return resolveSynthetic(statement);
        },
    };
}
