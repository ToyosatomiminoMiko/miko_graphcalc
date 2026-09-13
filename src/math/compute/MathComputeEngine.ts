/**
 * 数值计算门面.
 * 当前先把积分计算收口到这里,后续再把曲线/曲面/向量场采样逐步迁入.
 *
 * 积分请求按 task 的显式 `dim`/`domainKind` 组织:
 * - interval(1D 曲线)/ rectangle(2D 曲面矩形):复用原 Rust 一/二维入口;
 * - region(2D 面积图形):Rust `integrate_region`(B1/B2),边界曲线
 *   由 objects 按名解析;
 * - solid(3D 实体):Rust `integrate_solid`(C1/C2),域描述复用求交的
 *   sphere/box/conic 形状(带静态矩阵).
 */
import type {
    CurveObject,
    IntegralTask,
    RegionObject,
    SceneObject,
    SphereObject,
    BoxObject,
    ConicSolidObject,
    SurfaceObject,
} from '../../compiler/ir/types';
import type { Mat4 } from '../tensor/rowMajorMatrix';
import { invertMat4 } from '../tensor/rowMajorMatrix';
import { coefficientsToRecord } from '../adapters/coefficientUtils';
import {
    integrate as runIntegral,
    type IntegralResult,
    type IntegralSpec,
} from './workers/IntegralCompute';
import { describeSide } from '../adapters/IntersectionMath';
import {
    curveComputeClient,
    type CurveSampleResult,
} from './workers/CurveComputeClient';

export type IntegralSource = Extract<
    SceneObject,
    { kind: 'curve' | 'surface' | 'region' | 'sphere' | 'box' | 'conic' }
>;

export type CurveSampleRequest = {
    expr: string;
    coeffNames: string[];
    coeffValues: number[];
    range: [number, number];
    segments: number;
};

type SolidObject = SphereObject | BoxObject | ConicSolidObject;

function isSolid(object: SceneObject): object is SolidObject {
    return object.kind === 'sphere' || object.kind === 'box' || object.kind === 'conic';
}

function findObject(objects: readonly SceneObject[], id: number): SceneObject | undefined {
    return objects.find((object) => object.id === id);
}

export class MathComputeEngine {
    async sampleCurve(request: CurveSampleRequest): Promise<CurveSampleResult> {
        // 曲线采样与曲面/向量场保持一致:交给 Worker 执行,避免高 segments
        // 或大量曲线时阻塞主线程.失败直接上抛,由渲染层统一上报诊断,
        // 不再做主线程静默兜底(否则 Worker 故障会被悄悄掩盖).
        return curveComputeClient.request(request);
    }

    /**
     * 构建并执行一次积分计算.
     *
     * @param objects  当前场景全部对象(region 域需要按名解析边界曲线).
     * @param transforms 对象 id -> 静态矩阵(solid 域描述复用).
     */
    async integrate(
        task: IntegralTask,
        objects: readonly SceneObject[],
        transforms: Readonly<Record<number, Mat4>>,
    ): Promise<IntegralResult> {
        const source = findObject(objects, task.objectId);
        if (!source) {
            throw new Error(`积分 ${task.name} 找不到源对象`);
        }
        const spec = this._buildSpec(task, source, objects, transforms);
        return runIntegral(spec);
    }

    private _buildSpec(
        task: IntegralTask,
        source: SceneObject,
        objects: readonly SceneObject[],
        transforms: Readonly<Record<number, Mat4>>,
    ): IntegralSpec {
        // "region"/"solid" 域的被积表达式里出现的额外参数(见 integrals.ts),
        // 它们是任务自身携带的系数,不挂在域对象上.
        const integrandCoeffs = coefficientsToRecord(task.integrandCoefficients);

        // curve 源:被积函数是曲线自身,积分区间是 task.range;系数在对象上.
        if (task.domainKind === 'interval') {
            const curve = source as CurveObject;
            return {
                method: task.method,
                dim: 1,
                domainKind: 'interval',
                integrand: task.integrand,
                integrandCoeffs: coefficientsToRecord(curve.coefficients),
                range: task.range as [number, number],
                segments: task.segments,
                layers: task.layers,
            };
        }

        if (task.domainKind === 'rectangle') {
            const surface = source as SurfaceObject;
            return {
                method: task.method,
                dim: 2,
                domainKind: 'rectangle',
                integrand: task.integrand,
                integrandCoeffs: coefficientsToRecord(surface.coefficients),
                range: task.range as [number, number, number, number],
                segments: task.segments,
                layers: task.layers,
            };
        }

        if (task.domainKind === 'region') {
            const region = source as RegionObject;
            const curveA = objects.find((object) => object.name === region.curveAName);
            const curveB = objects.find((object) => object.name === region.curveBName);
            if (!curveA || !curveB || curveA.kind !== 'curve' || curveB.kind !== 'curve') {
                throw new Error(`积分 ${task.name} 的区域边界曲线缺失`);
            }
            const [xa, xb] = task.range as [number, number];
            return {
                method: task.method,
                dim: 2,
                domainKind: 'region',
                integrand: task.integrand,
                integrandCoeffs,
                range: [xa, xb],
                region: {
                    boundaries: [
                        this._curveBoundary(curveA),
                        this._curveBoundary(curveB),
                    ],
                },
                segments: task.segments,
                layers: task.layers,
            };
        }

        // solid
        if (!isSolid(source)) {
            throw new Error(`积分 ${task.name} 的 solid 源类型非法`);
        }
        const matrix = transforms[source.id] ?? null;
        const inverse = matrix ? invertMat4(matrix) : null;
        if (matrix && !inverse) {
            throw new Error(`积分 ${task.name} 的实体变换矩阵不可逆`);
        }
        const side = describeSide(source, matrix, inverse);
        return {
            method: task.method,
            dim: 3,
            domainKind: 'solid',
            integrand: task.integrand,
            integrandCoeffs,
            solid: {
                kind: side.kind as 'sphere' | 'box' | 'conic',
                params: side.params,
                matrix: side.matrix,
                inverse: side.inverse,
            },
            segments: task.segments,
            layers: task.layers,
        };
    }

    private _curveBoundary(curve: CurveObject): { expr: string; coeffs: Record<string, number> } {
        return {
            expr: curve.expr,
            coeffs: coefficientsToRecord(curve.coefficients),
        };
    }

    dispose(): void {
        // 本类只是计算门面,不拥有任何共享 worker.
        // worker 生命周期由应用级 dispose 统一处理.
    }
}

/**
 * 曲线/区域等实体共用的采样门面单例.
 *
 * MathComputeEngine 本身无状态(底层走共享 `curveComputeClient`),真正
 * 的 latest-only 调度在各自 renderer 的 LatestRequestExecutor 上,
 * 因此多个渲染器共享同一实例即可,不必每类渲染器各 new 一个.
 */
export const sharedCurveSamplingEngine = new MathComputeEngine();
