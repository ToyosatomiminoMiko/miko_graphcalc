/**
 * 微分方程 blueprint 的表达式小工具(**纯文本/纯函数**,不碰内核与 DOM).
 *
 * 单独成一个模块的原因:实体层(`odeBlueprint.ts`,下发斜率场/解族实体)与求值层
 * (`odeTasks.ts`)都要用这几个工具,而选项白名单必须两边同源;放任意一边都会让
 * 另一边反向依赖,进而成环.
 *
 * 三个工具各自有明确的"名称来源":
 * 1. {@link renameCoordinateSymbols} 把内核产出的自变量/因变量名换成渲染器
 *    认得的 `x`/`y`(渲染层只会按 x/y/z 采样,DSL 却允许 `t`/`u`);
 * 2. {@link substituteConstantSymbols} 把常数符号(`C`/`C_1`/`C_2`)换成具体
 *    数值,得到一条**可求值**的解曲线表达式;
 * 3. {@link familyConstants} 给 `curves = n` 选项挑一组常数取值(P2-A 的
 *    "族参数扫描"里"取哪几条"这一步的确定性口径).
 */
import { normalizeExpression } from './expression';

/**
 * `ode` 语句允许的选项白名单(**唯一来源**,设计文档 `docs/plan3.md` 第 1.1 节).
 *
 * 静态场景层与求值层都要按它做声明级校验,放在这个叶子模块里两边共用
 * (两边互相 import 会成环,见文件头).
 */
export const ODE_OPTION_NAMES = [
    'dependent',
    'independent',
    'constant',
    'curves',
    'range',
    'segments',
    'color',
] as const;

/**
 * 标识符边界感知的符号替换(文本级).
 *
 * 为什么不能用 `String.replace`:`C` 会命中 `cos` 里的字母,`C_1` 与 `C_2`
 * 会互相命中(`C` 替换成数值后 `C_1` 就再也匹配不上),而 `t` 会命中 `tan`.
 * 这里按"标识符 = ASCII 字母/下划线开头,后续字母/数字/下划线"扫描,只替换
 * 完整标识符.
 */
export function replaceSymbol(text: string, from: string, to: string): string {
    let result = '';
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        if (/[A-Za-z_]/.test(char)) {
            let end = index + 1;
            while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end += 1;
            const name = text.slice(index, end);
            result += name === from ? to : name;
            index = end;
        } else {
            result += char;
            index += 1;
        }
    }
    return result;
}

/**
 * 把内核用的自变量/因变量名换成渲染坐标 `x`/`y`.
 *
 * 只在需要时替换(名字已经相同就不动),避免无谓地重建字符串.返回
 * `{ expr, renamed }`,`renamed` 供展示层如实说明"自变量以 x 轴显示".
 */
export function renameCoordinateSymbols(
    expr: string,
    independent: string,
    dependent: string,
): { expr: string; renamed: boolean } {
    let result = expr;
    let renamed = false;
    if (dependent !== 'y' && dependent !== '') {
        result = replaceSymbol(result, dependent, 'y');
        renamed = true;
    }
    if (independent !== 'x' && independent !== '') {
        result = replaceSymbol(result, independent, 'x');
        renamed = true;
    }
    return { expr: result, renamed };
}

/**
 * 把常数符号替换成具体取值并归一化.
 *
 * `values` 是 `符号名 -> 数值`;替换后走 Rust 归一化(`normalizeExpression`),
 * 让物化层拿到与手写表达式完全同构的字符串(数值字面量 round-trip 由该入口
 * 保证,见 `expression.ts` 文件头).
 */
export function substituteConstantSymbols(
    expr: string,
    values: ReadonlyArray<readonly [string, number]>,
): string {
    let result = expr;
    for (const [symbol, value] of values) {
        // 负数要加括号:`C` -> `-1` 时 `2*C` 会变成 `2*-1`(归一化能读,但
        // 直接写括号更稳,也更好读).
        const literal = value < 0 ? `(${value})` : `${value}`;
        result = replaceSymbol(result, symbol, literal);
    }
    return normalizeExpression(result);
}

/** 一条解曲线的常数取值:一阶是单个 `C`,二阶是 `(C_1, C_2)`. */
export type FamilyConstant = number | readonly [number, number];

/**
 * 给一条 `ode` 语句挑解曲线的常数取值(P2-A:族参数扫描).
 *
 * 口径:
 * - 一阶:第一条用选项 `constant`(缺省 0),其后按 `±1, ±2, ...` 交替取,
 *   去重后截到 `count` 条 -- 对称取值让一族曲线在图上分布均匀;
 * - 二阶:`y = C_1 y_1 + C_2 y_2` 的两个基解最有教学价值,所以前两条取
 *   `(1,0)`/`(0,1)`,之后取 `(1,1)`/`(-1,1)`/`(1,-1)`/`(-1,-1)`;还不够就把
 *   整组乘上 `2, 3, ...` 继续取(保证条数与 `curves` 一致,不静默少画);
 * - `count <= 0` 返回空数组(选项 `curves` 缺省就是 0:不画解曲线).
 */
export function familyConstants(
    order: number,
    count: number,
    constant: number,
): FamilyConstant[] {
    if (count <= 0) return [];
    const values: FamilyConstant[] = [];
    if (order >= 2) {
        const base: Array<readonly [number, number]> = [
            [1, 0],
            [0, 1],
            [1, 1],
            [-1, 1],
            [1, -1],
            [-1, -1],
        ];
        for (let scale = 1; values.length < count; scale += 1) {
            for (const [first, second] of base) {
                if (values.length >= count) break;
                values.push([first * scale, second * scale]);
            }
        }
        return values;
    }
    values.push(constant);
    let step = 1;
    while (values.length < count) {
        for (const candidate of [step, -step]) {
            if (values.length >= count) break;
            if (!values.includes(candidate)) values.push(candidate);
        }
        step += 1;
    }
    return values;
}

/** 把一条常数取值渲染成选项/标签用的文本(二阶是 `(C_1, C_2)` 对). */
export function familyConstantLabel(value: FamilyConstant): string {
    return Array.isArray(value) ? `C_1=${value[0]}, C_2=${value[1]}` : `C=${value}`;
}

/**
 * 把一条常数取值变成 `substituteConstantSymbols` 要的替换表.
 *
 * `symbols` 来自内核(`["C"]` / `["C_1","C_2"]`),顺序与 `familyConstants`
 * 的取值口径一一对应(见该函数注释).
 */
export function familySubstitutions(
    symbols: readonly string[],
    value: FamilyConstant,
): Array<readonly [string, number]> {
    if (Array.isArray(value)) {
        const [first, second] = value as readonly [number, number];
        return [
            [symbols[0] ?? 'C_1', first],
            [symbols[1] ?? 'C_2', second],
        ];
    }
    return [[symbols[0] ?? 'C', value as number]];
}

/** 解曲线在实体列表里的名字后缀(主曲线之外的族成员依次编号). */
export function familyCurveName(statementName: string, index: number): string {
    return `${statementName}_c${index}`;
}
