/**
 * 曲面采样 Worker 的主线程客户端.
 * 复用通用 ComputeWorkerClient,避免重复 pending/error/dispose 逻辑.
 */
import { createComputeWorkerClient } from './ComputeWorkerClient';
import type {
    SurfaceWorkerRequest,
    SurfaceWorkerResponse,
} from './SurfaceWorker';

/**
 * @cache
 * 缓存目的:曲面采样复用同一个 Worker client.
 * 键/失效策略:模块级单例;应用销毁时由 disposeSurfaceComputeClient 释放.
 * 生命周期:模块级,随页面存活.
 */
export const surfaceComputeClient = createComputeWorkerClient<
    SurfaceWorkerRequest,
    SurfaceWorkerResponse
>(
    () => new Worker(
        new URL('./SurfaceWorker.ts', import.meta.url),
        { type: 'module' },
    ),
);

/**
 * 应用级释放入口.
 * 单个 SurfaceMesh 的 dispose 不应调用这里;只有确认整个应用不再需要
 * 曲面计算时才允许 terminate 这个共享 worker.
 */
export function disposeSurfaceComputeClient(): void {
    surfaceComputeClient.dispose();
}
