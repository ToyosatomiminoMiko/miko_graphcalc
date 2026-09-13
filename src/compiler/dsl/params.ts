/**
 * 参数收集/覆盖与求值 scope 辅助函数.
 * 从 DslCompiler 拆出,保持参数相关逻辑集中管理.
 *
 * 循环类系数(`param φ = 0 in cyclic [...]`)的取值归一化(普通参数夹取 /
 * 循环参数按区间取模回绕)实现在 `math/paramValue.ts`:参数面板也要用同一条
 * 口径,所以不放在编译侧.本文件是它在编译期的三个落点--声明校验
 * (`collectParams`),系数物化(`coefficientFromDeclaration`),求值 scope
 * (`buildParamScope`)--保证三者永远给出同一个值.
 */
import type { AstProgram } from '../ast/types';
import type { Coefficient, ParamDeclaration } from '../ir/types';
import { NUMERIC_CONFIG } from '../../config/numericConfig';
import { normalizeParamValue } from '../../math/paramValue';
import { withStatementSpan } from '../errors';
import { toFiniteNumber } from './options';

/** 按全局数值配置构造未声明参数项. */
export function createDefaultParam(name: string): ParamDeclaration {
    return {
        name,
        value: NUMERIC_CONFIG.param.defaultValue,
        min: NUMERIC_CONFIG.param.defaultMin,
        max: NUMERIC_CONFIG.param.defaultMax,
        step: NUMERIC_CONFIG.param.defaultStep,
        // 隐式参数没有声明处,也就没有"显式声明为循环"的机会:一律普通参数.
        cyclic: false,
    };
}

/**
 * 单个自由参数的取值解析(202609 review 结论,全 DSL 唯一入口).
 *
 * 规则:value = overrides[name] ?? 声明值;min/max/step 只来自声明表
 * (隐式参数使用 NUMERIC_CONFIG 默认).此前 objects/integrals 各写一份
 * "overrides[name] ?? declared.value",analyses 又手工建 scope,四处对
 * "参数未声明时怎么办"的处理互相矛盾(对象侧静默建默认,积分侧直接报错).
 * 收敛后差异只剩一个开关:materializeCoefficient 允许隐式默认,
 * requireDeclaredCoefficient 强制必须已声明(并携带语句级错误文案).
 */
function coefficientFromDeclaration(
    name: string,
    declared: ParamDeclaration,
    overrides: Record<string, number>,
): Coefficient {
    return {
        name,
        // 覆盖值同样过归一化:循环参数在圆周上是多值的,先回绕再交给下游,
        // 下游(含把系数发给 WASM 的调用方)拿到的永远是主值.
        value: normalizeParamValue(overrides[name] ?? declared.value, declared),
        min: declared.min,
        max: declared.max,
        step: declared.step,
        cyclic: declared.cyclic,
    };
}

/** 解析对象系数:未声明参数静默使用默认声明(与既有对象行为一致). */
export function materializeCoefficient(
    name: string,
    params: Map<string, ParamDeclaration>,
    overrides: Record<string, number>,
): Coefficient {
    return coefficientFromDeclaration(
        name,
        params.get(name) ?? createDefaultParam(name),
        overrides,
    );
}

/** 解析积分被积函数等"必须显式声明"的参数;未声明时直接报错. */
export function requireDeclaredCoefficient(
    name: string,
    params: Map<string, ParamDeclaration>,
    overrides: Record<string, number>,
    context: string,
): Coefficient {
    const declared = params.get(name);
    if (!declared) {
        throw new Error(`${context} 引用了未声明的参数 ${name}`);
    }
    return coefficientFromDeclaration(name, declared, overrides);
}

export function collectParams(ast: AstProgram): Map<string, ParamDeclaration> {
    const params = new Map<string, ParamDeclaration>();
    const seen = new Set<string>();

    for (const statement of ast.statements) {
        if (statement.type !== 'param') continue;
        // 语句级错误定位:该语句内部抛出的错误携带声明 span,
        // 应用层据此换算成源码行列(见 compiler/errors.ts).
        withStatementSpan(statement.span, () => {
            if (seen.has(statement.name)) {
                throw new Error(`参数 ${statement.name} 重复声明`);
            }
            seen.add(statement.name);

            const value = toFiniteNumber(statement.value, `参数 ${statement.name} 的 value`);
            const declaration = createDefaultParam(statement.name);
            declaration.value = value;
            if (statement.ui) {
                declaration.min = toFiniteNumber(statement.ui.min, `参数 ${statement.name} 的 min`);
                declaration.max = toFiniteNumber(statement.ui.max, `参数 ${statement.name} 的 max`);
                declaration.step = toFiniteNumber(statement.ui.step, `参数 ${statement.name} 的 step`);
            }
            // 循环类系数:DSL 里显式写了 `in cyclic [...]` 才为 true.
            declaration.cyclic = statement.cyclic === true;

            // 参数 UI 的范围是后续滑块的契约;不在这里校验,
            // 后续会生成反直觉甚至无法使用的滑块.
            if (declaration.min >= declaration.max) {
                throw new Error(`参数 ${statement.name} 需要满足 min < max`);
            }
            if (declaration.step <= 0) {
                throw new Error(`参数 ${statement.name} 的 step 必须大于 0`);
            }
            if (declaration.value < declaration.min || declaration.value > declaration.max) {
                // 循环参数的初始值允许落在域外(它会被回绕到 [min, max)),
                // 普通参数仍要求初始值在区间内.
                if (declaration.cyclic) {
                    declaration.value = normalizeParamValue(declaration.value, declaration);
                } else {
                    throw new Error(
                        `参数 ${statement.name} 的初始值 ${declaration.value} `
                        + `不在 [${declaration.min}, ${declaration.max}] 内`,
                    );
                }
            }

            params.set(statement.name, declaration);
        });
    }
    return params;
}

/**
 * 把覆盖值回写进参数声明表.
 *
 * 仅用于让 IR scene.params 携带当前滑块值(param 面板读它恢复滑块位置);
 * 各编译消费者(对象物化/积分/分析)必须直接使用 buildParamScope /
 * materializeCoefficient / requireDeclaredCoefficient 读取 overrides,
 * 不要依赖"先改 map 再读 map"的副作用通道(202609 review:回写 map 与
 * 逐处读 overrides 是双轨口径,已收敛为后者唯一来源).
 *
 * 回写同样过 normalizeParamValue:面板要拿到回绕后的主值,否则循环参数
 * 的滑块会停在域外位置而与实际求值不一致.
 */
export function applyParamOverrides(
    params: Map<string, ParamDeclaration>,
    overrides: Record<string, number>,
): void {
    for (const [name, value] of Object.entries(overrides)) {
        const param = params.get(name);
        if (param) param.value = normalizeParamValue(value, param);
    }
}

export function buildParamScope(
    params: Map<string, ParamDeclaration>,
    overrides: Record<string, number>,
): Record<string, number> {
    const scope: Record<string, number> = {};
    for (const [name, param] of params) {
        // scope 是表达式求值的唯一入口,循环参数在这里完成回绕;
        // 覆盖值来自参数面板/调用方,可能是域外的等价角(如 φ = 7).
        scope[name] = normalizeParamValue(overrides[name] ?? param.value, param);
    }
    return scope;
}
