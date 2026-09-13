/**
 * 选项与列表解析辅助函数.
 * 从 DslCompiler 拆出,负责 DSL 选项/数字列表解析.
 */
import type { OptionPair } from '../ast/types';
import type { AnalysisShow } from '../ir/types';
import { evaluateNumber, extractSymbolNames } from './expression';

const SHOW_KINDS = new Set<AnalysisShow>(['point', 'normal', 'tangent', 'tangent_plane']);

export function findOption(options: OptionPair[], name: string): string | undefined {
    return options.find((item) => item.name === name)?.value;
}

/**
 * DSL option 白名单校验.
 *
 * 数学工具最危险的行为不是报错,而是用户写错一个字段后静默使用默认值.
 * 这里同时拒绝未知选项和重复选项,让编译期错误尽量靠近源码问题.
 */
export function assertKnownOptions(
    options: OptionPair[],
    allowedNames: readonly string[],
    context: string,
): void {
    const allowed = new Set<string>(allowedNames);
    const seen = new Set<string>();

    for (const option of options) {
        if (!allowed.has(option.name)) {
            throw new Error(`${context} 包含未知选项: ${option.name}`);
        }
        if (seen.has(option.name)) {
            throw new Error(`${context} 包含重复选项: ${option.name}`);
        }
        seen.add(option.name);
    }
}

export function stripQuotes(value: string): string {
    return value.replace(/^["']|["']$/g, '');
}

export function parseNumberList(raw: string, context: string): number[] {
    const body = raw.trim();
    if (!body) {
        throw new Error(`${context} 不能为空`);
    }
    const items = body.replace(/[[\]]/g, '').split(',');
    if (items.length === 0 || items.some((item) => item.trim() === '')) {
        throw new Error(`${context} 包含空元素: ${raw}`);
    }
    const values = items.map((item) => Number(item.trim()));
    if (values.some((value) => !Number.isFinite(value))) {
        throw new Error(`${context} 不是有效的数字列表: ${raw}`);
    }
    return values;
}

/**
 * 定长数字列表解析:parseNumberList + 长度校验.
 *
 * 202609 review 结论:curve/surface/vector_field/integral 的 range,grid 此前各写
 * 一遍"拆串 + 数个数 + 报错"逻辑,文案还各不相同;统一成这个入口后,各调用点
 * 只需按自身语义做 min < max / 正整数 / 上限等二次校验即可.
 */
export function parseNumberListOfSize(
    raw: string,
    size: number,
    context: string,
): number[] {
    const values = parseNumberList(raw, context);
    if (values.length !== size) {
        throw new Error(
            `${context} 需要 ${size} 个数值,当前为 ${values.length} 个`,
        );
    }
    return values;
}

export function optionalNumber(
    raw: string | undefined,
    context: string,
): number | undefined {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        throw new Error(`${context} 不是有效数字: ${raw}`);
    }
    return value;
}

export function parsePositiveInteger(
    raw: string | undefined,
    context: string,
): number | undefined {
    const value = optionalNumber(raw, context);
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${context} 必须是正整数,当前为 ${raw}`);
    }
    return value;
}

/**
 * 带硬上限的正整数解析.
 * 正整数本身只是类型约束,不能防止用户输入一个会耗尽内存的巨大 segments.
 */
export function parseCappedPositiveInteger(
    raw: string | undefined,
    context: string,
    max: number,
): number | undefined {
    const value = parsePositiveInteger(raw, context);
    if (value !== undefined && value > max) {
        throw new Error(`${context} 不能超过 ${max},当前为 ${raw}`);
    }
    return value;
}

/**
 * 带硬上限的正整数解析,允许"计数"引用已声明参数.
 *
 * 与 parseCappedPositiveInteger 的区别:取值既可以是字面正整数,也可以是
 * 一个引用已声明参数(或参数表达式)的字符串.参数刷新时编译会携带当前值
 * 重跑,因此计数(如积分 segments/layers)能跟随滑块变化.
 *
 * 约束(与积分被积函数 requireDeclaredCoefficient 的口径一致,避免拼错的
 * 参数名被当成字面 0 静默画图):
 * - 表达式里出现的自由符号必须是已声明参数(否则报"引用了未声明的参数");
 * 求值结果必须是正整数且不超过 max.
 */
export function parseCappedPositiveIntegerFromScope(
    raw: string | undefined,
    context: string,
    max: number,
    scope: Record<string, number>,
): number | undefined {
    if (raw === undefined) return undefined;

    for (const symbol of extractSymbolNames(raw, new Set())) {
        if (!(symbol in scope)) {
            throw new Error(`${context} 引用了未声明的参数 ${symbol}`);
        }
    }

    const value = evaluateNumber(raw, scope);
    if (value === null) {
        throw new Error(`${context} 无法求值: ${raw}`);
    }
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${context} 必须是正整数,当前为 ${raw}`);
    }
    if (value > max) {
        throw new Error(`${context} 不能超过 ${max},当前为 ${raw}`);
    }
    return value;
}

export function parsePositiveIntegerList(raw: string, context: string): number[] {
    const values = parseNumberList(raw, context);
    if (values.some((value) => !Number.isInteger(value) || value <= 0)) {
        throw new Error(`${context} 中的每个值都必须是正整数: ${raw}`);
    }
    return values;
}

/**
 * 带硬上限的向量场 grid 解析.
 * 单独限制每轴还不够,必须再限制三维点数乘积,避免 1000 * 1000 * 1000
 * 这类在单轴校验下仍可通过的分配炸弹.
 */
export function parseCappedPositiveIntegerList(
    raw: string,
    context: string,
    maxAxis: number,
    maxTotal: number,
): number[] {
    const values = parsePositiveIntegerList(raw, context);
    if (values.some((value) => value > maxAxis)) {
        throw new Error(`${context} 中的每个值都不能超过 ${maxAxis}: ${raw}`);
    }

    const total = values.reduce(
        (product, value) => product * BigInt(value),
        BigInt(1),
    );
    if (total > BigInt(maxTotal)) {
        throw new Error(`${context} 的网格点总数不能超过 ${maxTotal}: ${raw}`);
    }
    return values;
}

export function toFiniteNumber(raw: string, context: string): number {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        throw new Error(`${context} 不是有效数字: ${raw}`);
    }
    return value;
}

/**
 * 解析 boolean 选项.
 *
 * 这里只接受明确的 true/false;空字符串/1/0/yes/no 都属于 DSL 错误.
 */
export function parseBooleanOption(
    options: OptionPair[],
    name: string,
    context: string,
    defaultValue: boolean,
): boolean {
    const raw = findOption(options, name);
    if (raw === undefined) return defaultValue;

    const normalized = raw.trim();
    switch (normalized) {
        case 'true':
            return true;
        case 'false':
            return false;
        default:
            throw new Error(`${context} 只能是 true 或 false,当前为 ${raw}`);
    }
}

export function parseShowOption(
    options: OptionPair[],
    defaultShow: AnalysisShow[] = ['point', 'normal'],
): AnalysisShow[] {
    const raw = findOption(options, 'show');
    if (raw === undefined) return defaultShow;

    // 不再过滤未知项.show 里的拼写错误必须直接报错,
    // 否则 gradient 的 normal/tangent_plane/tangent 可能被用户误认为已经绘制.
    const items = raw.replace(/[[\]]/g, '').split(',').map((item) => item.trim());
    if (items.length === 0 || items.some((item) => item.length === 0)) {
        throw new Error(`show 选项不能为空: ${raw}`);
    }

    for (const item of items) {
        if (!SHOW_KINDS.has(item as AnalysisShow)) {
            throw new Error(`show 选项包含未知种类: ${item}`);
        }
    }

    return items as AnalysisShow[];
}
