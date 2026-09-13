/**
 * 对象 blueprint 构建:ObjectStatement -> 各对象 blueprint.
 *
 * 表达式在进入 blueprint 前统一经 Rust 符号引擎归一化,因此后续
 * 采样/积分/分析和渲染都直接消费 Rust/evalexpr 可执行的字符串.
 * 归一化覆盖所有"函数型"表达式:curve/surface 单表达式,vector_field 的
 * P/Q/R 三分量,体积对象的位置/几何参数,region 的边界曲线表达式
 * (202609 review:vector_field 分量与 region 边界系数此前保留了未归一化原文,
 * 同一表达式在曲线/向量场语境下会走不同的符号求导/LaTeX 路径,已收口;
 * region 的边界曲线又必须与边界 curve 自身同源,故统一对 raw 语句表达式
 * 再做一次归一化后提取系数--normalizeExpression 自带缓存,成本可忽略).
 *
 * region(面积图形)实体:V1 只支持 x 型带状区域,不持有曲线几何拷贝,只按
 * 名引用两条边界 `curve`;后续规划(y 型 / 极坐标 r-θ / 多曲线边界 /
 * region 参与求交 / region 作为曲面底域)见 `compiler/ir/types.ts` 的
 * `RegionObject` 注释与 `prompt/feature.md`.
 *
 * 物化阶段(blueprint + 参数值 -> 数值 IR)见同目录 ./materialize.ts;本文件与
 * 物化是对象子系统的两个独立 switch(各自按 9 种 kind 分派),只共享
 * ./types.ts 的 blueprint 类型.
 */
import { NUMERIC_CONFIG } from '../../../config/numericConfig';
import { RENDER_CONFIG } from '../../../config/renderConfig';
import type { ObjectStatement } from '../../ast/types';
import {
    assertKnownOptions,
    findOption,
    optionalNumber,
    parseCappedPositiveInteger,
    parseCappedPositiveIntegerList,
    parseNumberListOfSize,
    stripQuotes,
} from '../options';
import {
    extractSymbolNames,
    normalizeExpression,
    parseArrayStrings,
    type ExpressionArray,
} from '../expression';
import type { ObjectBlueprint } from './types';

const RENDER_CONFIG_VOLUME_OPACITY = RENDER_CONFIG.volume.defaultOpacity;

const CURVE_OPTION_NAMES = ['color', 'range', 'segments', 'transform', 'animation'] as const;
const SURFACE_OPTION_NAMES = ['color', 'range', 'segments', 'transform', 'animation'] as const;
const VECTOR_FIELD_OPTION_NAMES = ['color', 'range', 'grid', 'scale', 'transform', 'animation'] as const;
const POINT_OPTION_NAMES = ['color', 'transform', 'animation'] as const;
const VECTOR_OPTION_NAMES = ['color', 'transform', 'animation'] as const;
const SPHERE_OPTION_NAMES = ['color', 'radius', 'opacity', 'segments', 'transform', 'animation'] as const;
const BOX_OPTION_NAMES = ['color', 'size', 'opacity', 'transform', 'animation'] as const;
const CONIC_OPTION_NAMES = [
    'color',
    'base',
    'height',
    'angle',
    'top',
    'opacity',
    'segments',
    'transform',
    'animation',
] as const;
// "region" V1:只有外观/采样选项;transform/animation 由未知选项校验直接拒绝,
// 后续规划(极坐标/y 型/多边界等)见文件头与 RegionObject 注释.
const REGION_OPTION_NAMES = ['range', 'color', 'opacity', 'segments'] as const;
// 隐式标量场:只有方程右端 level 与颜色.刻意不收 transform/animation--
// 隐式方程写在世界坐标里,给它套变换需要把逆矩阵折进表达式,超出 V1 范围.
const IMPLICIT_OPTION_NAMES = ['level', 'color'] as const;

const REGION_REFERENCE_PATTERN = /^region\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)$/;

function arrayItems(value: ExpressionArray): ExpressionArray[] | null {
    return Array.isArray(value) ? value : null;
}

function stringItem(value: ExpressionArray): string | null {
    return typeof value === 'string' ? value : null;
}

function parseArrayItems(raw: string): ExpressionArray[] | null {
    try {
        return arrayItems(parseArrayStrings(raw));
    } catch {
        return null;
    }
}

function toExpressionTuple(items: ExpressionArray[]): [string, string, string] {
    return [
        stringItem(items[0]) ?? '',
        stringItem(items[1]) ?? '',
        stringItem(items[2]) ?? '',
    ];
}

function parseVectorComponents(raw: string): [string, string, string] {
    const items = parseArrayItems(raw);
    if (items && items.length === 3) {
        return toExpressionTuple(items);
    }
    throw new Error('vector_field 需要 [P, Q, R] 形式的向量表达式');
}

function parsePointComponents(raw: string, context: string): [string, string, string] {
    const items = parseArrayItems(raw);
    if (!items || items.length !== 3) {
        throw new Error(`${context} 需要 [x, y, z] 形式`);
    }
    return toExpressionTuple(items);
}

/** 解析 `region(c1, c2)` 形式的对象表达式,取回两条边界曲线名. */
function parseRegionReference(
    raw: string,
    context: string,
): { a: string; b: string } {
    const match = raw.trim().match(REGION_REFERENCE_PATTERN);
    if (!match) {
        throw new Error(`${context} 需要 region(曲线A, 曲线B) 形式`);
    }
    return { a: match[1], b: match[2] };
}

/** 解析一条 `[min, max]` 形式的 x 区间(range 选项),统一校验与报错. */
function parseXRange2(raw: string, context: string): [number, number] {
    const values = parseNumberListOfSize(raw, 2, `${context} 的 range`);
    if (values[0] >= values[1]) {
        throw new Error(`${context} 的 range 需要 min < max`);
    }
    return [values[0], values[1]];
}

/** 从 curve 声明语句读 x 区间;缺省取曲线默认 range. */
function curveRangeFromStatement(statement: ObjectStatement): [number, number] {
    const raw = findOption(statement.options, 'range');
    if (raw === undefined) {
        return [...NUMERIC_CONFIG.curve.defaultRange] as [number, number];
    }
    return parseXRange2(raw, `曲线 ${statement.name}`);
}

/** 两条边界曲线 x 区间交集;为空时报错(区域无定义带). */
function intersectCurveRanges(
    aRange: [number, number],
    bRange: [number, number],
    context: string,
): [number, number] {
    const lo = Math.max(aRange[0], bRange[0]);
    const hi = Math.min(aRange[1], bRange[1]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
        throw new Error(
            `${context} 的两条边界曲线 x 区间没有交集,区域为空`,
        );
    }
    return [lo, hi];
}

function parseVectorObject(
    raw: string,
    context: string,
): {
    originExprs: [string, string, string];
    directionExprs: [string, string, string];
} {
    const items = parseArrayItems(raw);
    if (!items) {
        throw new Error(`${context} 需要 [dx, dy, dz] 或 [[x0,y0,z0],[dx,dy,dz]]`);
    }

    if (items.length === 3) {
        return {
            originExprs: ['0', '0', '0'],
            directionExprs: toExpressionTuple(items),
        };
    }

    if (items.length === 2) {
        const originItems = arrayItems(items[0]);
        const directionItems = arrayItems(items[1]);
        if (originItems?.length === 3 && directionItems?.length === 3) {
            return {
                originExprs: toExpressionTuple(originItems),
                directionExprs: toExpressionTuple(directionItems),
            };
        }
    }

    throw new Error(`${context} 需要 [dx, dy, dz] 或 [[x0,y0,z0],[dx,dy,dz]]`);
}

/**
 * 解析体积对象的透明度选项.
 *
 * 体积对象默认和积分可视化一样使用半透明材质;这里只接受 [0, 1] 的常量,
 * 不把 `opacity` 做成自由参数,因为透明度不需要参与数值计算.
 */
function parseOpacity(
    raw: string | undefined,
    context: string,
    defaultValue: number,
): number {
    const value = optionalNumber(raw, context) ?? defaultValue;
    if (value < 0 || value > 1) {
        throw new Error(`${context} 必须在 0 到 1 之间,当前为 ${value}`);
    }
    return value;
}

/**
 * 把 `size = 2` 或 `size = [2, 3, 4]` 统一成三轴表达式.
 *
 * 单个数值表示 cube,即三个轴共用同一个表达式.
 */
function parseSizeExpressions(raw: string, context: string): [string, string, string] {
    const items = parseArrayItems(raw);
    if (!items) {
        return [raw, raw, raw];
    }
    if (items.length === 1) {
        const scalar = stringItem(items[0]);
        if (!scalar) throw new Error(`${context} 包含无效元素`);
        return [scalar, scalar, scalar];
    }
    if (items.length === 3) {
        return toExpressionTuple(items);
    }
    throw new Error(`${context} 需要 1 个或 3 个分量,当前为 ${items.length} 个`);
}

/** 收集体积对象位置与几何参数里的自由参数,供 param 面板和增量刷新使用. */
function collectVolumeCoefficientNames(expressions: string[]): string[] {
    return extractCoefficientNames(expressions, new Set());
}

function extractCoefficientNames(
    expressions: string[],
    variables: ReadonlySet<string>,
): string[] {
    const names = new Set<string>();
    for (const expression of expressions) {
        for (const name of extractSymbolNames(expression, variables)) {
            names.add(name);
        }
    }
    return [...names];
}

export function buildObjectBlueprint(
    statement: ObjectStatement,
    id: number,
    statementsByName: ReadonlyMap<string, ObjectStatement> = new Map(),
): ObjectBlueprint | null {
    const color = stripQuotes(
        findOption(statement.options, 'color')
            ?? NUMERIC_CONFIG.colorPalette[id % NUMERIC_CONFIG.colorPalette.length],
    );

    switch (statement.kind) {
        case 'curve': {
            assertKnownOptions(statement.options, CURVE_OPTION_NAMES, `曲线 ${statement.name}`);
            const expr = normalizeExpression(statement.expr);
            const rawRange = findOption(statement.options, 'range');
            const range = rawRange
                ? parseXRange2(rawRange, `曲线 ${statement.name}`)
                : undefined;
            const segments = parseCappedPositiveInteger(
                findOption(statement.options, 'segments'),
                `曲线 ${statement.name} 的 segments`,
                NUMERIC_CONFIG.limits.curve.maxSegments,
            );
            return {
                name: statement.name,
                id,
                kind: 'curve',
                expr,
                coefficientNames: extractCoefficientNames([expr], new Set(['x'])),
                color,
                range,
                segments,
            };
        }

        case 'surface': {
            assertKnownOptions(statement.options, SURFACE_OPTION_NAMES, `曲面 ${statement.name}`);
            const expr = normalizeExpression(statement.expr);
            const rawRange = findOption(statement.options, 'range');
            const rangeValues = rawRange
                ? parseNumberListOfSize(rawRange, 4, `曲面 ${statement.name} 的 range`)
                : [...NUMERIC_CONFIG.surface.defaultRange];
            if (rangeValues[0] >= rangeValues[1] || rangeValues[2] >= rangeValues[3]) {
                throw new Error(`曲面 ${statement.name} 的 range 需要 min < max`);
            }
            const range = [
                rangeValues[0],
                rangeValues[1],
                rangeValues[2],
                rangeValues[3],
            ] as [number, number, number, number];
            const segments = parseCappedPositiveInteger(
                findOption(statement.options, 'segments'),
                `曲面 ${statement.name} 的 segments`,
                NUMERIC_CONFIG.limits.surface.maxSegments,
            );
            return {
                name: statement.name,
                id,
                kind: 'surface',
                expr,
                coefficientNames: extractCoefficientNames([expr], new Set(['x', 'y'])),
                color,
                range,
                segments,
            };
        }

        case 'vector_field': {
            assertKnownOptions(
                statement.options,
                VECTOR_FIELD_OPTION_NAMES,
                `向量场 ${statement.name}`,
            );
            // 分量与 curve/surface 一样先归一化再入库(见文件头 202609 review 结论),
            // 保证散度/旋度符号求导与 LaTeX 展示与曲线语境同源.
            const [pExpr, qExpr, rExpr] = parseVectorComponents(statement.expr)
                .map((component) => normalizeExpression(component)) as [
                    string,
                    string,
                    string,
                ];
            const rawRange = findOption(statement.options, 'range');
            const rangeValues = rawRange
                ? parseNumberListOfSize(rawRange, 6, `向量场 ${statement.name} 的 range`)
                : [...NUMERIC_CONFIG.vectorField.defaultRange];
            if (
                rangeValues[0] >= rangeValues[1]
                || rangeValues[2] >= rangeValues[3]
                || rangeValues[4] >= rangeValues[5]
            ) {
                throw new Error(`向量场 ${statement.name} 的 range 需要 min < max`);
            }
            const gridValues = parseCappedPositiveIntegerList(
                findOption(statement.options, 'grid')
                    ?? `[${NUMERIC_CONFIG.vectorField.defaultGrid.join(', ')}]`,
                `向量场 ${statement.name} 的 grid`,
                NUMERIC_CONFIG.limits.vectorField.maxAxisGrid,
                NUMERIC_CONFIG.limits.vectorField.maxTotalGridPoints,
            );
            if (gridValues.length !== 3) {
                throw new Error(`向量场 ${statement.name} 的 grid 需要 3 个数值`);
            }
            const glyphScale = optionalNumber(
                findOption(statement.options, 'scale'),
                `向量场 ${statement.name} 的 scale`,
            )
                ?? NUMERIC_CONFIG.vectorField.defaultGlyphScale;
            return {
                name: statement.name,
                id,
                kind: 'vector_field',
                pExpr,
                qExpr,
                rExpr,
                coefficientNames: extractCoefficientNames([pExpr, qExpr, rExpr], new Set(['x', 'y', 'z'])),
                color,
                gridSize: [gridValues[0], gridValues[1], gridValues[2]] as [number, number, number],
                range: {
                    x: [rangeValues[0], rangeValues[1]],
                    y: [rangeValues[2], rangeValues[3]],
                    z: [rangeValues[4], rangeValues[5]],
                },
                glyphScale,
            };
        }

        case 'point': {
            assertKnownOptions(statement.options, POINT_OPTION_NAMES, `点 ${statement.name}`);
            return {
                name: statement.name,
                id,
                kind: 'point',
                expr: statement.expr,
                coordinateExprs: parsePointComponents(statement.expr, `点 ${statement.name}`),
                color,
            };
        }

        case 'vector': {
            assertKnownOptions(statement.options, VECTOR_OPTION_NAMES, `向量 ${statement.name}`);
            const vector = parseVectorObject(statement.expr, `向量 ${statement.name}`);
            return {
                name: statement.name,
                id,
                kind: 'vector',
                expr: statement.expr,
                originExprs: vector.originExprs,
                directionExprs: vector.directionExprs,
                color,
            };
        }

        case 'sphere': {
            assertKnownOptions(statement.options, SPHERE_OPTION_NAMES, `球体 ${statement.name}`);
            const positionExprs = parsePointComponents(statement.expr, `球体 ${statement.name}`);
            const radiusExpr = findOption(statement.options, 'radius') ?? String(
                NUMERIC_CONFIG.volume.defaultSphereRadius,
            );
            const opacity = parseOpacity(
                findOption(statement.options, 'opacity'),
                `球体 ${statement.name} 的 opacity`,
                RENDER_CONFIG_VOLUME_OPACITY,
            );
            const segments = parseCappedPositiveInteger(
                findOption(statement.options, 'segments'),
                `球体 ${statement.name} 的 segments`,
                NUMERIC_CONFIG.limits.volume.maxRadialSegments,
            ) ?? NUMERIC_CONFIG.volume.defaultRadialSegments;
            return {
                name: statement.name,
                id,
                kind: 'sphere',
                expr: statement.expr,
                positionExprs,
                radiusExpr,
                coefficientNames: collectVolumeCoefficientNames([...positionExprs, radiusExpr]),
                color,
                segments,
                opacity,
            };
        }

        case 'box': {
            assertKnownOptions(statement.options, BOX_OPTION_NAMES, `方块 ${statement.name}`);
            const positionExprs = parsePointComponents(statement.expr, `方块 ${statement.name}`);
            const sizeExprs = parseSizeExpressions(
                findOption(statement.options, 'size') ?? `[${NUMERIC_CONFIG.volume.defaultBoxSize.join(', ')}]`,
                `方块 ${statement.name} 的 size`,
            );
            const opacity = parseOpacity(
                findOption(statement.options, 'opacity'),
                `方块 ${statement.name} 的 opacity`,
                RENDER_CONFIG_VOLUME_OPACITY,
            );
            return {
                name: statement.name,
                id,
                kind: 'box',
                expr: statement.expr,
                positionExprs,
                sizeExprs,
                coefficientNames: collectVolumeCoefficientNames([...positionExprs, ...sizeExprs]),
                color,
                opacity,
            };
        }

        case 'cylinder':
        case 'cone':
        case 'frustum': {
            assertKnownOptions(statement.options, CONIC_OPTION_NAMES, `旋转体 ${statement.name}`);
            const positionExprs = parsePointComponents(statement.expr, `旋转体 ${statement.name}`);
            const baseExpr = findOption(statement.options, 'base') ?? String(
                NUMERIC_CONFIG.volume.defaultConicBase,
            );
            const heightExpr = findOption(statement.options, 'height') ?? String(
                NUMERIC_CONFIG.volume.defaultConicHeight,
            );
            const topExpr = findOption(statement.options, 'top');
            const angleExpr = findOption(statement.options, 'angle');
            const opacity = parseOpacity(
                findOption(statement.options, 'opacity'),
                `旋转体 ${statement.name} 的 opacity`,
                RENDER_CONFIG_VOLUME_OPACITY,
            );
            const segments = parseCappedPositiveInteger(
                findOption(statement.options, 'segments'),
                `旋转体 ${statement.name} 的 segments`,
                NUMERIC_CONFIG.limits.volume.maxRadialSegments,
            ) ?? NUMERIC_CONFIG.volume.defaultRadialSegments;
            const declaredKind = statement.kind as 'cylinder' | 'cone' | 'frustum';
            return {
                name: statement.name,
                id,
                kind: 'conic',
                expr: statement.expr,
                declaredKind,
                positionExprs,
                baseExpr,
                heightExpr,
                topExpr,
                angleExpr,
                coefficientNames: collectVolumeCoefficientNames([
                    ...positionExprs,
                    baseExpr,
                    heightExpr,
                    ...(topExpr ? [topExpr] : []),
                    ...(angleExpr ? [angleExpr] : []),
                ]),
                color,
                segments,
                opacity,
            };
        }

        case 'region': {
            assertKnownOptions(statement.options, REGION_OPTION_NAMES, `区域 ${statement.name}`);
            const { a, b } = parseRegionReference(statement.expr, `区域 ${statement.name}`);
            if (a === b) {
                throw new Error(`区域 ${statement.name} 的两条边界曲线不能相同`);
            }
            const curveA = statementsByName.get(a);
            const curveB = statementsByName.get(b);
            if (!curveA) {
                throw new Error(`区域 ${statement.name} 引用了不存在的曲线 ${a}`);
            }
            if (!curveB) {
                throw new Error(`区域 ${statement.name} 引用了不存在的曲线 ${b}`);
            }
            if (curveA.kind !== 'curve' || curveB.kind !== 'curve') {
                throw new Error(
                    `区域 ${statement.name} 的边界必须是曲线(curve)对象`,
                );
            }
            const rawRange = findOption(statement.options, 'range');
            const range = rawRange
                ? parseXRange2(rawRange, `区域 ${statement.name}`)
                : intersectCurveRanges(
                    curveRangeFromStatement(curveA),
                    curveRangeFromStatement(curveB),
                    `区域 ${statement.name}`,
                );
            const opacity = parseOpacity(
                findOption(statement.options, 'opacity'),
                `区域 ${statement.name} 的 opacity`,
                RENDER_CONFIG_VOLUME_OPACITY,
            );
            const segments = parseCappedPositiveInteger(
                findOption(statement.options, 'segments'),
                `区域 ${statement.name} 的 segments`,
                NUMERIC_CONFIG.limits.region.maxSegments,
            ) ?? NUMERIC_CONFIG.region.defaultSegments;
            return {
                name: statement.name,
                id,
                kind: 'region',
                expr: statement.expr.trim(),
                curveAName: curveA.name,
                curveBName: curveB.name,
                range,
                // 系数从"归一化后的边界表达式"提取,与边界 curve 自身 blueprints
                // 的 coefficientNames 保持同源(见文件头 202609 review 结论;
                // 归一化有缓存,重复调用成本可忽略).
                coefficientNames: extractCoefficientNames(
                    [normalizeExpression(curveA.expr), normalizeExpression(curveB.expr)],
                    new Set(['x']),
                ),
                color,
                opacity,
                segments,
            };
        }

        case 'implicit': {
            assertKnownOptions(statement.options, IMPLICIT_OPTION_NAMES, `隐式场 ${statement.name}`);
            const expr = normalizeExpression(statement.expr);
            // 维度由表达式里实际出现的坐标变量推断:出现 z 即三维 level-set
            // 曲面,否则是二维隐式曲线.不要求三个变量都出现(`z - 1 = 0` 也是
            // 合法平面),但至少要有 x/y/z 之一,否则它根本不是等值面方程.
            const symbols = new Set(extractSymbolNames(expr, new Set()));
            const hasZ = symbols.has('z');
            const hasPlanarCoordinate = symbols.has('x') || symbols.has('y');
            if (!hasZ && !hasPlanarCoordinate) {
                throw new Error(
                    `隐式场 ${statement.name} 的表达式必须包含坐标变量 x/y/z`,
                );
            }
            const levelExpr = findOption(statement.options, 'level') ?? '0';
            return {
                name: statement.name,
                id,
                kind: 'implicit',
                expr,
                dim: hasZ ? 3 : 2,
                levelExpr,
                // level 里也可能引用 param(如 `level = k`),与 f 的自由参数
                // 一起进入系数集合,保证参数面板与增量刷新口径一致.
                coefficientNames: extractCoefficientNames(
                    [expr, levelExpr],
                    new Set(['x', 'y', 'z']),
                ),
                color,
            };
        }

        default:
            return null;
    }
}
