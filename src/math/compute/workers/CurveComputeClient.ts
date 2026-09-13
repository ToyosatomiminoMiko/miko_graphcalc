/**
 * 曲线采样 Worker 的主线程客户端.
 * 曲线采样原先直接在主线程调用 WASM,这里改为与其他计算一致的 Worker 路径.
 */
import { createComputeWorkerClient } from './ComputeWorkerClient';
import type {
    CurveWorkerRequest,
    CurveWorkerResponse,
} from './CurveWorker';

/** 曲线采样结果:扁平顶点 + 每段起始顶点下标(见采样层 `CurvePoints`). */
export type CurveSampleResult = {
    points: Float32Array;
    offsets: Uint32Array;
};

/**
 * @cache
 * 缓存目的:曲线采样复用同一个 Worker client.
 * 键/失效策略:模块级单例;应用销毁时由 disposeCurveComputeClient 释放.
 * 生命周期:模块级,随页面存活.
 */
export const curveComputeClient = createComputeWorkerClient<
    CurveWorkerRequest,
    CurveWorkerResponse,
    CurveSampleResult
>(
    () => new Worker(
        new URL('./CurveWorker.ts', import.meta.url),
        { type: 'module' },
    ),
    (response) => ({ points: response.points, offsets: response.offsets }),
);

/**
 * 应用级释放入口.
 * 单个 CurveRenderer 的 dispose 不应调用这里;只有确认整个应用不再需要
 * 曲线采样时才允许 terminate 这个共享 worker.
 */
export function disposeCurveComputeClient(): void {
    curveComputeClient.dispose();
}
