/**
 * 对象物化:blueprint + 参数值 -> IR SceneObject.
 *
 * 声明期工作(buildObjectBlueprint,见 ./build.ts)已完成表达式归一化与
 * 选项/自由系数解析;本文件只在每次参数刷新时做数值求值:建参数 scope,
 * 把三元坐标/尺寸表达式与单值(radius/base/height/top/angle)求成数值,
 * 并执行各对象几何约束(正值/夹逼,cylinder 与 cone 的缺省 top,top|angle
 * 二选一),输出渲染层直接消费的 ir/types.ts 对象.三元求值收口见
 * evaluateRequiredTriple 注释(202609 review 第 3 项).
 */
import type {
    BoxObject,
    ConicSolidObject,
    CurveObject,
    ImplicitObject,
    ParamDeclaration,
    PointObject,
    RegionObject,
    SceneObject,
    SphereObject,
    SurfaceObject,
    VectorFieldObject,
    VectorObject,
} from '../../ir/types';
import { evaluateRequiredNumber } from '../expression';
import { buildParamScope, materializeCoefficient } from '../params';
import type { ObjectBlueprint } from './types';

/**
 * 把三元坐标/尺寸表达式一次求值成数值三元组.
 *
 * 202609 review 结论(第 3 项):point 坐标,vector 起点/方向,sphere/box/conic
 * 中心与 box 尺寸此前各写一遍 `exprs.map(expr => evaluateRequiredNumber(...))
 * as [number, number, number]`,共 7 处;收口后求值方式只有这一份,
 * 报错文案仍由调用方按对象与量纲(context)给出.单值(radius/base/height...)
 * 求值与每类对象的几何约束(正值/夹逼)是各自的领域语义,不并入本 helper.
 */
function evaluateRequiredTriple(
    exprs: readonly [string, string, string],
    scope: Record<string, number>,
    context: string,
): [number, number, number] {
    return [
        evaluateRequiredNumber(exprs[0], scope, context),
        evaluateRequiredNumber(exprs[1], scope, context),
        evaluateRequiredNumber(exprs[2], scope, context),
    ];
}

export function materializeObject(
    blueprint: ObjectBlueprint,
    params: Map<string, ParamDeclaration>,
    overrides: Record<string, number>,
): SceneObject {
    switch (blueprint.kind) {
        case 'curve': {
            return {
                kind: 'curve',
                id: blueprint.id,
                name: blueprint.name,
                expr: blueprint.expr,
                coefficients: blueprint.coefficientNames.map((name) => materializeCoefficient(name, params, overrides)),
                color: blueprint.color,
                enabled: true,
                range: blueprint.range,
                segments: blueprint.segments,
                // 纯展示元数据:只有 derivative 产物有,直接透传给公式层.
                derivativeOrigin: blueprint.derivativeOrigin,
            } satisfies CurveObject;
        }

        case 'surface': {
            return {
                kind: 'surface',
                id: blueprint.id,
                name: blueprint.name,
                expr: blueprint.expr,
                coefficients: blueprint.coefficientNames.map((name) => materializeCoefficient(name, params, overrides)),
                color: blueprint.color,
                enabled: true,
                range: blueprint.range,
                segments: blueprint.segments,
                derivativeOrigin: blueprint.derivativeOrigin,
            } satisfies SurfaceObject;
        }

        case 'point': {
            const scope = buildParamScope(params, overrides);
            const [x, y, z] = evaluateRequiredTriple(
                blueprint.coordinateExprs,
                scope,
                `点 ${blueprint.name} 的坐标`,
            );
            return {
                kind: 'point',
                id: blueprint.id,
                name: blueprint.name,
                expr: blueprint.expr,
                x,
                y,
                z,
                color: blueprint.color,
                enabled: true,
            } satisfies PointObject;
        }

        case 'vector': {
            const scope = buildParamScope(params, overrides);
            const [ox, oy, oz] = evaluateRequiredTriple(
                blueprint.originExprs,
                scope,
                `向量 ${blueprint.name} 的起点`,
            );
            const [dx, dy, dz] = evaluateRequiredTriple(
                blueprint.directionExprs,
                scope,
                `向量 ${blueprint.name} 的方向`,
            );
            return {
                kind: 'vector',
                id: blueprint.id,
                name: blueprint.name,
                expr: blueprint.expr,
                origin: { x: ox, y: oy, z: oz },
                direction: { x: dx, y: dy, z: dz },
                color: blueprint.color,
                enabled: true,
            } satisfies VectorObject;
        }

        case 'vector_field': {
            return {
                kind: 'vector_field',
                id: blueprint.id,
                name: blueprint.name,
                components: [blueprint.pExpr, blueprint.qExpr, blueprint.rExpr],
                coefficients: blueprint.coefficientNames.map((name) => materializeCoefficient(name, params, overrides)),
                color: blueprint.color,
                enabled: true,
                gridSize: blueprint.gridSize,
                range: blueprint.range,
                glyphScale: blueprint.glyphScale,
                // 纯展示元数据:只有隐式场求导产物有,直接透传给公式层.
                gradientOrigin: blueprint.gradientOrigin,
            } satisfies VectorFieldObject;
        }

        case 'sphere': {
            const scope = buildParamScope(params, overrides);
            const [x, y, z] = evaluateRequiredTriple(
                blueprint.positionExprs,
                scope,
                `球体 ${blueprint.name} 的中心`,
            );
            const radius = evaluateRequiredNumber(
                blueprint.radiusExpr,
                scope,
                `球体 ${blueprint.name} 的 radius`,
            );
            if (radius <= 0) {
                throw new Error(`球体 ${blueprint.name} 的 radius 必须大于 0`);
            }
            return {
                kind: 'sphere',
                id: blueprint.id,
                name: blueprint.name,
                expr: blueprint.expr,
                position: { x, y, z },
                radius,
                coefficients: blueprint.coefficientNames.map((name) => materializeCoefficient(name, params, overrides)),
                color: blueprint.color,
                opacity: blueprint.opacity,
                segments: blueprint.segments,
                enabled: true,
            } satisfies SphereObject;
        }

        case 'box': {
            const scope = buildParamScope(params, overrides);
            const [x, y, z] = evaluateRequiredTriple(
                blueprint.positionExprs,
                scope,
                `方块 ${blueprint.name} 的中心`,
            );
            const size = evaluateRequiredTriple(
                blueprint.sizeExprs,
                scope,
                `方块 ${blueprint.name} 的 size`,
            );
            if (size.some((value) => value <= 0)) {
                throw new Error(`方块 ${blueprint.name} 的 size 每个分量都必须大于 0`);
            }
            return {
                kind: 'box',
                id: blueprint.id,
                name: blueprint.name,
                expr: blueprint.expr,
                position: { x, y, z },
                size,
                coefficients: blueprint.coefficientNames.map((name) => materializeCoefficient(name, params, overrides)),
                color: blueprint.color,
                opacity: blueprint.opacity,
                enabled: true,
            } satisfies BoxObject;
        }

        case 'conic': {
            const scope = buildParamScope(params, overrides);
            const [x, y, z] = evaluateRequiredTriple(
                blueprint.positionExprs,
                scope,
                `旋转体 ${blueprint.name} 的中心`,
            );
            const baseRadius = evaluateRequiredNumber(
                blueprint.baseExpr,
                scope,
                `旋转体 ${blueprint.name} 的 base`,
            );
            const height = evaluateRequiredNumber(
                blueprint.heightExpr,
                scope,
                `旋转体 ${blueprint.name} 的 height`,
            );
            if (baseRadius <= 0) {
                throw new Error(`旋转体 ${blueprint.name} 的 base 必须大于 0`);
            }
            if (height <= 0) {
                throw new Error(`旋转体 ${blueprint.name} 的 height 必须大于 0`);
            }

            let topRadius: number;
            let sideAngle: number;
            if (blueprint.topExpr && blueprint.angleExpr) {
                throw new Error(
                    `旋转体 ${blueprint.name} 不能同时指定 top 和 angle,请二选一`,
                );
            }
            if (blueprint.topExpr) {
                topRadius = evaluateRequiredNumber(
                    blueprint.topExpr,
                    scope,
                    `旋转体 ${blueprint.name} 的 top`,
                );
                sideAngle = Math.atan((baseRadius - topRadius) / height);
            } else if (blueprint.angleExpr) {
                sideAngle = evaluateRequiredNumber(
                    blueprint.angleExpr,
                    scope,
                    `旋转体 ${blueprint.name} 的 angle`,
                );
                topRadius = baseRadius - height * Math.tan(sideAngle);
            } else if (blueprint.declaredKind === 'cylinder') {
                topRadius = baseRadius;
                sideAngle = 0;
            } else if (blueprint.declaredKind === 'cone') {
                topRadius = 0;
                sideAngle = Math.atan(baseRadius / height);
            } else {
                throw new Error(
                    `圆台 ${blueprint.name} 需要显式指定 top 或 angle`,
                );
            }

            // 数值误差下允许极小的越界;真正越界时宁可报错也不画一个反向/负数半径的畸形体.
            const epsilon = 1e-9;
            if (topRadius < -epsilon || topRadius > baseRadius + epsilon) {
                throw new Error(
                    `旋转体 ${blueprint.name} 的 top 半径 ${topRadius} 不在 [0, ${baseRadius}] 内`,
                );
            }
            topRadius = Math.min(baseRadius, Math.max(0, topRadius));

            return {
                kind: 'conic',
                id: blueprint.id,
                name: blueprint.name,
                expr: blueprint.expr,
                position: { x, y, z },
                baseRadius,
                topRadius,
                height,
                sideAngle,
                coefficients: blueprint.coefficientNames.map((name) => materializeCoefficient(name, params, overrides)),
                color: blueprint.color,
                opacity: blueprint.opacity,
                segments: blueprint.segments,
                enabled: true,
            } satisfies ConicSolidObject;
        }

        case 'region': {
            return {
                kind: 'region',
                id: blueprint.id,
                name: blueprint.name,
                curveAName: blueprint.curveAName,
                curveBName: blueprint.curveBName,
                range: blueprint.range,
                coefficients: blueprint.coefficientNames.map((name) => materializeCoefficient(name, params, overrides)),
                color: blueprint.color,
                opacity: blueprint.opacity,
                segments: blueprint.segments,
                enabled: true,
            } satisfies RegionObject;
        }

        case 'implicit': {
            // dim 与 expr 是声明级数据;唯一需要在参数刷新时重算的是 level
            // (它允许引用 param),系数与 curve/surface 走同一份物化路径.
            const scope = buildParamScope(params, overrides);
            const level = evaluateRequiredNumber(
                blueprint.levelExpr,
                scope,
                `隐式场 ${blueprint.name} 的 level`,
            );
            return {
                kind: 'implicit',
                id: blueprint.id,
                name: blueprint.name,
                expr: blueprint.expr,
                dim: blueprint.dim,
                level,
                coefficients: blueprint.coefficientNames.map((name) => materializeCoefficient(name, params, overrides)),
                color: blueprint.color,
                enabled: true,
            } satisfies ImplicitObject;
        }
    }
}
