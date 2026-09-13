/**
 * 求交 Worker 的主线程客户端.
 *
 * 与曲线/曲面/积分采样一致:共享一个 Worker + latest-only 调度器,
 * 高频拖动滑块时旧求交请求会被替换,不积压任务.
 */
import type { IntersectionComputeInput } from '../../adapters/IntersectionMath';
import { ComputeWorkerClient } from './ComputeWorkerClient';
import { LatestRequestExecutor } from './LatestRequestExecutor';
import type {
    IntersectionWorkerRequest,
    IntersectionWorkerResponse,
} from './IntersectionWorker';

export type IntersectionComputeResult = {
    points: Float64Array;
    curvePoints: Float64Array;
    curveOffsets: Uint32Array;
};

/**
 * @cache
 * 缓存目的:求交计算复用同一个 Worker client.
 * 键/失效策略:模块级单例;应用销毁时由 disposeIntersectionComputeClient 释放.
 * 生命周期:模块级,随页面存活.
 */
const intersectionClient = new ComputeWorkerClient<IntersectionWorkerRequest, IntersectionWorkerResponse>(() => new Worker(
    new URL('./IntersectionWorker.ts', import.meta.url),
    { type: 'module' },
));

/**
 * @cache
 * 缓存目的:保证求交请求 latest-only,避免高频刷新堆积旧任务.
 * 键/失效策略:单飞队列;新请求取代 pending 请求.
 * 生命周期:模块级,随页面存活.
 */
const intersectionExecutor = new LatestRequestExecutor<IntersectionWorkerRequest, IntersectionWorkerResponse>(
    intersectionClient,
);

/**
 * @cache_access
 * 提交一次求交计算.
 */
export function requestIntersection(
    input: IntersectionComputeInput,
): Promise<IntersectionComputeResult> {
    return intersectionExecutor
        .request(input)
        .then((response) => {
            return {
                points: response.points!,
                curvePoints: response.curvePoints!,
                curveOffsets: response.curveOffsets!,
            };
        });
}

/**
 * 应用级释放入口:停掉 latest-only 调度后 terminate 共享 Worker.
 */
export function disposeIntersectionComputeClient(): void {
    intersectionExecutor.dispose();
    intersectionClient.dispose();
}
