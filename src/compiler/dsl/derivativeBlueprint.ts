/**
 * `derivative` 语句的**实体层**编译:源对象 -> 新 curve/surface/vector_field.
 *
 * 从 staticScene.ts 拆出(该文件只保留静态场景编排与缓存).产物复用
 * objects/build.ts 的归一化/系数提取/选项校验,因此导数对象与手写
 * curve/surface/vector_field 完全同构;本模块只负责"从源对象取出表达式,
 * 定出求导变量,继承 range/segments,挂展示元数据".
 *
 * 两类源在此分派:
 * - curve/surface:`cachedDerivativeExpression` 求偏导 -> 同 kind 对象;
 * - implicit/sphere:梯度 ∇f -> vector_field(见 buildFieldDerivativeBlueprint).
 */
import type { DerivativeStatement, ObjectStatement, OptionPair } from '../ast/types';
import { assertKnownOptions } from './options';
import { cachedDerivativeExpression } from './expression';
import {
    sphereGradientExpressions,
    sphereImplicitExpression,
} from './implicitField';
import { buildObjectBlueprint } from './objects/build';
import type { ObjectBlueprint } from './objects/types';

/** `derivative` 求导语句允许的选项(与对象外观一致,transform/animation 不继承). */
const DERIVATIVE_OPTION_NAMES = ['color', 'range', 'segments'] as const;
/**
 * 隐式场求导(--> ∇f 向量场)允许的选项.
 *
 * 产物是 vector_field,所以收的是向量场自己的外观/采样选项;`segments`
 * 在这里不适用(vector_field 用 `grid`),出现在隐式场求导里会直接报错.
 */
const FIELD_DERIVATIVE_OPTION_NAMES = ['color', 'range', 'grid', 'scale'] as const;

/**
 * 可被求导引用的源:
 * - `curve` / `surface`:显式因变量,生成整条导数曲线/曲面;
 * - `implicit`:隐式标量场 `f=level`,求导 = 梯度 ∇f,生成向量场;
 * - `sphere`:内置隐式场 `|p−c|²−r²`,同样生成 ∇f 向量场.
 *
 * 存储归一化表达式,使链式求导(d²f 等)与单层求导共用同一解析结果.
 */
export type DerivativeSource =
    | { kind: 'curve' | 'surface'; expr: string }
    | { kind: 'implicit'; expr: string; dim: 2 | 3 }
    | { kind: 'sphere'; positionExprs: [string, string, string]; radiusExpr: string };

/**
 * 隐式场求导源(implicit / sphere)-> `∇f` 向量场 blueprint.
 *
 * 三分量就是 f 对 x/y/z 的符号偏导:implicit 走 Rust 符号引擎(带缓存),
 * 球体因为 ∇f = 2(p−c) 有闭式,直接用解析表达式,既省一次符号求导,也让
 * 结果不依赖符号引擎的化简风格.产物复用 vector_field 的归一化/系数提取/
 * 采样/渲染管线,只是额外挂一份 `gradientOrigin` 供公式层写成 `∇(f)`.
 */
function buildFieldDerivativeBlueprint(
    statement: DerivativeStatement,
    nextId: number,
    statementsByName: Map<string, ObjectStatement>,
    source: Extract<DerivativeSource, { kind: 'implicit' | 'sphere' }>,
): ObjectBlueprint {
    assertKnownOptions(
        statement.options,
        FIELD_DERIVATIVE_OPTION_NAMES,
        `求导 ${statement.name}`,
    );

    let components: [string, string, string];
    let sourceExpr: string;
    if (source.kind === 'implicit') {
        const gx = cachedDerivativeExpression(source.expr, 'x');
        const gy = cachedDerivativeExpression(source.expr, 'y');
        // 2D 隐式曲线不含 z:显式补 0,保持 vector_field 的三分量形状.
        const gz = source.dim === 3
            ? cachedDerivativeExpression(source.expr, 'z')
            : '0';
        components = [gx, gy, gz];
        sourceExpr = source.expr;
    } else {
        components = sphereGradientExpressions(source.positionExprs);
        sourceExpr = sphereImplicitExpression(source.positionExprs, source.radiusExpr);
    }

    const synthetic: ObjectStatement = {
        type: 'object',
        kind: 'vector_field',
        name: statement.name,
        expr: `[${components.join(', ')}]`,
        // 选项已按 vector_field 白名单校验,直接透传;不像 curve/surface
        // 求导那样继承源对象的 range/segments--隐式场没有这些外观选项.
        options: statement.options,
        span: statement.span,
    };
    const blueprint = buildObjectBlueprint(synthetic, nextId, statementsByName);
    if (!blueprint || blueprint.kind !== 'vector_field') {
        throw new Error(`求导 ${statement.name} 无法生成梯度向量场`);
    }
    blueprint.gradientOrigin = { sourceExpr };
    return blueprint;
}

/**
 * 把 `derivative 名称 = derivative(源对象 [, 变量])` 编译成一个新对象
 * blueprint(curve -> curve 求 x 导,surface -> surface 需指定 x|y;
 * implicit / sphere -> vector_field,即 ∇f).
 *
 * 产物复用 `buildObjectBlueprint` 的归一化/系数提取/选项校验,因此导数对象
 * 与手写 curve/surface/vector_field 完全同构,之后照常进入物化与渲染管线;
 * color 缺省用调色板(每个新对象一个),range/segments 缺省继承源对象
 * (与源画在同一区间).
 *
 * 求导函数名为全名 `derivative`(项目约定不缩写,见 miko.pest).
 *
 * ── 审查记录(202609,供后续审查参考) ────────────────────────────
 * 1) 类型推断:结果 kind 由源对象决定(curve->curve,surface->surface,
 *    implicit/sphere->vector_field),求导变量 curve 缺省 'x',surface
 *    必填 x|y,隐式场是对整个 f 求梯度(无变量参数).这与 gradient 按
 *    源对象分派,integral 按 sourceKind 推 dim/domainKind 的推断风格一致,
 *    不是新引入的约定.
 * 2) 两条有意为之的边界(审查时请保留,勿当作缺陷"修复"):
 *    a. 链式求导按源码顺序处理:`derivative d2 = derivative(d1)` 要求 d1
 *       声明在前;直接引用 curve/surface 源则允许前向引用(见调用处
 *       resolvable 的预填).若希望链式也支持乱序,需改成两阶段解析.
 *    b. 产物 kind 与手写对象相同(选项只收对应对象自己的外观项,
 *       transform/animation 刻意不继承--导数是独立函数图形,与源对象的
 *       平移/动画无关);唯一例外是 derivativeOrigin/gradientOrigin 这两块
 *       展示元数据:公式要写成 d/dx(源函数)=导函数 或 ∇(源函数)=∇f,
 *       而不是看不出求导的 y=f(x)(见 dsl/latex.ts),数值与渲染路径不读它.
 * ──────────────────────────────────────────────────────────────
 */
export function buildDerivativeObjectBlueprint(
    statement: DerivativeStatement,
    nextId: number,
    statementsByName: Map<string, ObjectStatement>,
    resolvable: Map<string, DerivativeSource>,
    declaredObjectNames: ReadonlySet<string>,
): ObjectBlueprint {
    const source = statement.source.trim();
    const sourceInfo = resolvable.get(source);
    if (!sourceInfo) {
        if (declaredObjectNames.has(source)) {
            throw new Error(
                `求导 ${statement.name} 只能应用于 curve/surface/implicit/sphere 类型对象`,
            );
        }
        throw new Error(`求导 ${statement.name} 引用了不存在的对象 ${source}`);
    }

    // 隐式场源(implicit / sphere)求导 = 梯度,直接产出向量场.
    if (sourceInfo.kind === 'implicit' || sourceInfo.kind === 'sphere') {
        return buildFieldDerivativeBlueprint(
            statement,
            nextId,
            statementsByName,
            sourceInfo,
        );
    }

    assertKnownOptions(statement.options, DERIVATIVE_OPTION_NAMES, `求导 ${statement.name}`);

    const variable = resolveDerivativeVariable(statement, sourceInfo);
    const derivExpr = cachedDerivativeExpression(sourceInfo.expr, variable);

    const synthetic: ObjectStatement = {
        type: 'object',
        kind: sourceInfo.kind,
        name: statement.name,
        expr: derivExpr,
        options: mergeDerivativeOptions(statement, statementsByName.get(source)),
        span: statement.span,
    };
    const blueprint = buildObjectBlueprint(synthetic, nextId, statementsByName);
    if (!blueprint) {
        throw new Error(`求导 ${statement.name} 无法生成对象`);
    }

    // 只挂展示元数据:导出的对象本身仍是普通 curve/surface,数值/渲染不变;
    // 公式层据此写成 d/dx(源函数)=导函数 或 ∂/∂y(源函数)=导函数.
    if (blueprint.kind === 'curve' || blueprint.kind === 'surface') {
        blueprint.derivativeOrigin = {
            sourceExpr: sourceInfo.expr,
            variable,
        };
    }
    return blueprint;
}

/**
 * 求导变量:curve 缺省 `x`(且只能是 x),surface 必填 `x`|`y`.
 * 变量校验排在选项白名单之后,保持报错先后与原实现一致.
 */
function resolveDerivativeVariable(
    statement: DerivativeStatement,
    sourceInfo: Extract<DerivativeSource, { kind: 'curve' | 'surface' }>,
): 'x' | 'y' {
    let variable = statement.variable;
    if (sourceInfo.kind === 'curve') {
        if (variable === undefined) variable = 'x';
        if (variable !== 'x') {
            throw new Error(`曲线 ${statement.name} 的求导变量只能是 x`);
        }
    } else {
        if (variable === undefined) {
            throw new Error(`曲面求导 ${statement.name} 需要指定变量 x 或 y`);
        }
        if (variable !== 'x' && variable !== 'y') {
            throw new Error(`曲面求导 ${statement.name} 的变量只能是 x 或 y`);
        }
    }
    return variable;
}

/**
 * 产物选项:从源对象继承 range/segments(否则用各自默认),并允许求导语句覆盖.
 * color 不继承(缺省走 build.ts 的调色板),与"导数是独立函数图形"一致.
 */
function mergeDerivativeOptions(
    statement: DerivativeStatement,
    sourceStmt: ObjectStatement | undefined,
): OptionPair[] {
    const inheritedRange = sourceStmt?.options.find((option) => option.name === 'range');
    const inheritedSegments = sourceStmt?.options.find((option) => option.name === 'segments');
    const ownColor = statement.options.find((option) => option.name === 'color');
    const ownRange = statement.options.find((option) => option.name === 'range');
    const ownSegments = statement.options.find((option) => option.name === 'segments');

    const options: OptionPair[] = [];
    if (inheritedRange && !ownRange) options.push(inheritedRange);
    if (inheritedSegments && !ownSegments) options.push(inheritedSegments);
    if (ownColor) options.push(ownColor);
    if (ownRange) options.push(ownRange);
    if (ownSegments) options.push(ownSegments);
    return options;
}
