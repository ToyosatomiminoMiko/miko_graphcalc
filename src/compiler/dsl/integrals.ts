/**
 * 积分任务编译.
 *
 * 把 DSL 中的 integral 声明转成渲染层可消费的 IntegralTask.
 *
 * 维度语义:IR `IntegralTask` 携带显式 `dim: 1|2|3` 与 `domainKind`
 * (interval/rectangle/region/solid),不再用 range 长度推断维度;
 * region/solid 域因此可以自然进入同一张 task 形状.
 *
 * 方法 × 域矩阵(与 prompt/feature.md §方法矩阵一致):
 * | 域 | riemann:left | right/mid | trapezoid | simpson | lebesgue |
 * | curve(1D) | ✅ | ✅ | ✅ | ✅ | ✅ |
 * | surface 矩形(2D) | ✅ | ✅ | ✅ | ✅ | ✅ |
 * | region 带(2D) | ✅(B2) | ✅(B2) | ✅(B1) | ✅(B1) | ✅(B2 层) |
 * | solid 体(3D) | ✅(C1) | ✅(C1) | ✅(C2) | ✅(C2) | ✅(f≡1 直接测度;非平凡 f 按 C1 层) |
 *
 * 被积函数:
 * - curve/surface 源 = 对象自带表达式(y=f(x) / z=f(x,y));
 * - region/solid 源 = 选项 `integrand`,缺省 `"1"`(即区域面积/体积);
 * - integrand 变量一律为世界坐标.
 *
 * 后续规划(roadmap):区域 y 型 / 极坐标 r-θ / 多曲线边界 / region 参与求交 /
 * region 作为曲面底域等,见 `compiler/ir/types.ts` RegionObject 注释.
 */
import type { IntegralStatement } from '../ast/types';
import {
    INTEGRAL_METHOD_NAMES,
} from '../ir/types';
import type {
    Coefficient,
    IntegralDomainKind,
    IntegralMethod,
    IntegralTask,
    ParamDeclaration,
    SceneObject,
} from '../ir/types';
import { NUMERIC_CONFIG } from '../../config/numericConfig';
import { normalizeExpression, extractSymbolNames } from './expression';
import { buildParamScope, requireDeclaredCoefficient } from './params';
import {
    assertKnownOptions,
    findOption,
    parseBooleanOption,
    parseCappedPositiveIntegerFromScope,
    parseNumberListOfSize,
} from './options';

/**
 * DSL 接受的 method 整串.
 *
 * 裸 `riemann` 是历史写法,编译期归一化为 `riemann:left`;
 * `riemann:left/right/mid` 与 `lebesgue`/`trapezoid`/`simpson` 同级.
 * 名单取自 IR 的 `INTEGRAL_METHOD_NAMES`(唯一来源,见 ir/types.ts),
 * 这里只额外接受旧写法 `riemann`, 作为别名存在.
 */
const INTEGRAL_METHODS = new Set<string>([
    ...INTEGRAL_METHOD_NAMES,
    'riemann',
]);

function normalizeIntegralMethod(raw: string): IntegralMethod {
    if (raw === 'riemann') return 'riemann:left';
    return raw as IntegralMethod;
}

const INTEGRAL_OPTION_NAMES = [
    'method',
    'range',
    'segments',
    'layers',
    'show',
    'integrand',
] as const;

/** source kind -> (dim, domainKind) 显式映射. */
const DOMAIN_KIND_BY_SOURCE: Record<
    'curve' | 'surface' | 'region' | 'sphere' | 'box' | 'conic',
    { dim: 1 | 2 | 3; domainKind: IntegralDomainKind }
> = {
    curve: { dim: 1, domainKind: 'interval' },
    surface: { dim: 2, domainKind: 'rectangle' },
    region: { dim: 2, domainKind: 'region' },
    sphere: { dim: 3, domainKind: 'solid' },
    box: { dim: 3, domainKind: 'solid' },
    conic: { dim: 3, domainKind: 'solid' },
};

const SOLID_KINDS = new Set<SceneObject['kind']>(['sphere', 'box', 'conic']);

/**
 * 域对象的世界坐标变量集;region 在 z=0 平面,因此其 integrand 不允许 z.
 */
const WORLD_VARIABLES: Record<IntegralDomainKind, Set<string>> = {
    interval: new Set(['x']),
    rectangle: new Set(['x', 'y']),
    region: new Set(['x', 'y']),
    solid: new Set(['x', 'y', 'z']),
};

/**
 * 物化被积表达式里出现的自由参数.
 *
 * 202609 review 结论:只做"世界坐标变量剔除 + 逐个解析",取值/报错逻辑
 * 已收敛到 params.ts 的 requireDeclaredCoefficient(未声明参数必须报错,
 * 与对象系数"隐式默认"的口径差异是有意的,见 params.ts 注释).
 */
function materializeIntegrandCoefficients(
    integrand: string,
    domainKind: IntegralDomainKind,
    params: Map<string, ParamDeclaration>,
    overrides: Record<string, number>,
    context: string,
): Coefficient[] {
    const excluded = WORLD_VARIABLES[domainKind];
    const symbols = extractSymbolNames(integrand, excluded);
    return symbols.map((name) =>
        requireDeclaredCoefficient(name, params, overrides, `${context} 的被积表达式`),
    );
}

/**
 * 物化 segments/layers 这类"计数"选项里引用的自由参数.
 *
 * 计数允许写参数(如 `segments = k`),因此 k 变化时积分任务必须重算;产物
 * 只用于参数刷新的 dirty 判定,不参与数值计算(计数已在编译期求成具体数字).
 * 未声明参数必须报错(与积分被积函数的 requireDeclaredCoefficient 口径一致).
 */
function materializeCountCoefficients(
    raw: string | undefined,
    params: Map<string, ParamDeclaration>,
    overrides: Record<string, number>,
    context: string,
): Coefficient[] {
    if (raw === undefined) return [];
    const symbols = extractSymbolNames(raw, new Set());
    return symbols.map((name) =>
        requireDeclaredCoefficient(name, params, overrides, context),
    );
}

/**
 * 编译单条 integral 语句(供 compileScene 在语句 span 包裹内调用).
 */
export function compileIntegralTask(
    statement: IntegralStatement,
    objectByName: Map<string, SceneObject>,
    params: Map<string, ParamDeclaration>,
    paramOverrides: Record<string, number> = {},
): IntegralTask {
    const name = statement.name;
    const source = objectByName.get(statement.source.trim());
    if (!source) {
        throw new Error(`积分 ${name} 引用了不存在的对象 ${statement.source}`);
    }
    if (
        source.kind !== 'curve'
        && source.kind !== 'surface'
        && source.kind !== 'region'
        && !SOLID_KINDS.has(source.kind)
    ) {
        throw new Error(
            `积分 ${name} 只能应用于 curve/surface/region 或体积对象`,
        );
    }

    // DSL 必须严格失败:未知 option 或重复 option 是用户错误,
    // 不能静默忽略后按默认值画一张"看起来正确"的图.
    assertKnownOptions(
        statement.options,
        INTEGRAL_OPTION_NAMES,
        `积分 ${name}`,
    );

    const rawMethod = findOption(statement.options, 'method') ?? NUMERIC_CONFIG.integral.defaultMethod;
    if (!INTEGRAL_METHODS.has(rawMethod)) {
        throw new Error(`未知积分方法: ${rawMethod}`);
    }
    const method = normalizeIntegralMethod(rawMethod);

    const { dim, domainKind } = DOMAIN_KIND_BY_SOURCE[
        source.kind as keyof typeof DOMAIN_KIND_BY_SOURCE
    ];

    // ---- range:按域种类显式解析,不再用长度推断 ----
    const rawRange = findOption(statement.options, 'range');
    let range: [number, number] | [number, number, number, number] | undefined;

    if (domainKind === 'interval') {
        const rangeValues = rawRange
            ? parseNumberListOfSize(rawRange, 2, `积分 ${name} 的 range`)
            : [...NUMERIC_CONFIG.integral.defaultRange1D];
        if (rangeValues[0] >= rangeValues[1]) {
            throw new Error(`积分 ${name} 需要有效的一维区间 a < b`);
        }
        range = [rangeValues[0], rangeValues[1]];
    } else if (domainKind === 'rectangle') {
        const rangeValues = rawRange
            ? parseNumberListOfSize(rawRange, 4, `积分 ${name} 的 range`)
            : [...NUMERIC_CONFIG.integral.defaultRange2D];
        if (rangeValues[0] >= rangeValues[1] || rangeValues[2] >= rangeValues[3]) {
            throw new Error(`积分 ${name} 需要有效的二维区间`);
        }
        range = [rangeValues[0], rangeValues[1], rangeValues[2], rangeValues[3]];
    } else if (domainKind === 'region') {
        // "region" 源的 x 区间:显式 range 覆盖,否则沿用区域对象自身的 x 区间.
        if (rawRange) {
            const rangeValues = parseNumberListOfSize(
                rawRange,
                2,
                `积分 ${name} 的 region range`,
            );
            if (rangeValues[0] >= rangeValues[1]) {
                throw new Error(`积分 ${name} 需要有效的 x 区间 a < b`);
            }
            range = [rangeValues[0], rangeValues[1]];
        } else if (source.kind === 'region') {
            range = source.range;
        }
    } else {
        // solid 域 = 渲染出的世界实体,不接受 range.
        if (rawRange) {
            throw new Error(`积分 ${name} 的 solid 域不接受 range,域由体积对象本身决定`);
        }
    }

    // ---- 被积函数 ----
    // curve/surface 的对象自带表达式即被积函数;region/solid 用 `integrand`,
    // 缺省 "1".region 在 z=0 平面,y 上下界由边界曲线给出,被积函数是 g(x,y).
    let integrand: string;
    if (source.kind === 'curve' || source.kind === 'surface') {
        integrand = source.expr;
    } else {
        const rawIntegrand = findOption(statement.options, 'integrand') ?? '1';
        integrand = normalizeExpression(rawIntegrand);
    }
    // 被积表达式里出现的"非域对象"参数才计入 task 自身的系数:
    // curve/surface 的被积函数 = 对象表达式,其参数已挂在对象 coefficients 上,
    // 由既有"对象 dirty -> 积分重算"链路覆盖,不在这里重复收集.
    const integrandCoefficients = (
        source.kind === 'curve' || source.kind === 'surface'
    )
        ? []
        : materializeIntegrandCoefficients(
            integrand,
            domainKind,
            params,
            paramOverrides,
            `积分 ${name}`,
        );

    // 一/二/三维积分的资源风险完全不同,使用各自的独立上限.
    const maxSegments = dim === 1
        ? NUMERIC_CONFIG.limits.integral.maxSegments1D
        : dim === 2
            ? NUMERIC_CONFIG.limits.integral.maxSegments2D
            : NUMERIC_CONFIG.limits.integral.maxSegments3D;
    // 计数(segments/layers)允许引用已声明参数,取值随参数刷新变化
    // (与球半径/尺寸等参数字表达式的口径一致,见 options.ts 的
    // parseCappedPositiveIntegerFromScope).
    const scope = buildParamScope(params, paramOverrides);
    const rawSegments = findOption(statement.options, 'segments');
    const segments = parseCappedPositiveIntegerFromScope(
        rawSegments,
        `积分 ${name} 的 segments`,
        maxSegments,
        scope,
    ) ?? NUMERIC_CONFIG.integral.defaultSegments;
    if (method === 'simpson' && segments % 2 !== 0) {
        throw new Error(`积分 ${name} 的辛普森法要求分段数必须为偶数,当前为 ${segments}`);
    }
    const rawLayers = findOption(statement.options, 'layers');
    const layers = parseCappedPositiveIntegerFromScope(
        rawLayers,
        `积分 ${name} 的 layers`,
        NUMERIC_CONFIG.limits.integral.maxLayers,
        scope,
    ) ?? Math.min(NUMERIC_CONFIG.integral.defaultLayersCap, segments);
    // 计数选项里引用的参数只有声明级校验,编译期不参与数值;它们单独挂到
    // task.countCoefficients 上,供渲染层做参数刷新的 dirty 判定.
    const countCoefficients = [
        ...materializeCountCoefficients(
            rawSegments,
            params,
            paramOverrides,
            `积分 ${name} 的 segments`,
        ),
        ...materializeCountCoefficients(
            rawLayers,
            params,
            paramOverrides,
            `积分 ${name} 的 layers`,
        ),
    ];
    const show = parseBooleanOption(
        statement.options,
        'show',
        `积分 ${name} 的 show`,
        NUMERIC_CONFIG.integral.showDefault,
    );

    return {
        name,
        objectId: source.id,
        sourceKind: source.kind as IntegralTask['sourceKind'],
        dim,
        domainKind,
        method,
        integrand,
        integrandCoefficients,
        countCoefficients,
        range,
        segments,
        layers,
        show,
        enabled: true,
    };
}
