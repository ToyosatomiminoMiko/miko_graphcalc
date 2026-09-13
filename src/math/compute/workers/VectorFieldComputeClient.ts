/**
 * 向量场采样 Worker 的主线程客户端.
 * 复用通用 ComputeWorkerClient,避免重复 pending/error/dispose 逻辑.
 */
import { createComputeWorkerClient } from './ComputeWorkerClient';
import type {
    VectorFieldWorkerRequest,
    VectorFieldWorkerResponse,
} from './VectorFieldWorker';

/**
 * @cache
 * 缓存目的:向量场采样复用同一个 Worker client.
 * 键/失效策略:模块级单例;应用销毁时由 disposeVectorFieldComputeClient 释放.
 * 生命周期:模块级,随页面存活.
 */
export const vectorFieldComputeClient = createComputeWorkerClient<
    VectorFieldWorkerRequest,
    VectorFieldWorkerResponse,
    Float32Array
>(
    () => new Worker(
        new URL('./VectorFieldWorker.ts', import.meta.url),
        { type: 'module' },
    ),
    (response) => response.vectors,
);

/**
 * 应用级释放入口.
 * 单个 VectorFieldRenderer 的 dispose 不应调用这里;只有确认整个应用不再
 * 需要向量场计算时才允许 terminate 这个共享 worker.
 */
export function disposeVectorFieldComputeClient(): void {
    vectorFieldComputeClient.dispose();
}
