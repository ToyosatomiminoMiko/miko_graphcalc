/**
 * 通用 Worker 客户端.
 * 负责 pending map/请求 id/Worker 创建/销毁和错误传播,
 * 供 Surface/VectorField/Integral 等计算 Worker 复用.
 */
type PendingRequest<TResponse> = {
    resolve: (response: TResponse) => void;
    reject: (error: Error) => void;
};

export type ComputeWorkerMessage<TResponse> = TResponse & {
    id: number;
    error?: string;
};

export class ComputeWorkerClient<
    TRequest extends { id: number },
    TResponse extends { error?: string },
> {
    /**
     * @cache
     * 缓存目的:复用同一个 Worker 实例,并用 id 缓存未完成请求.
     * 键/失效策略:_worker 按需创建,错误或 dispose 时置空;_pending 以请求
     *              id 为键,响应后删除.
     * 生命周期:跟随 ComputeWorkerClient 实例.
     */
    private _worker: Worker | null = null;
    private readonly _pending = new Map<number, PendingRequest<TResponse>>();
    private _nextId = 0;

    constructor(private readonly workerFactory: () => Worker) {}

    /**
     * @cache_access
     * 通过复用 Worker 发送请求,并登记到 pending 缓存.
     */
    request(request: Omit<TRequest, 'id'>): Promise<TResponse> {
        const id = ++this._nextId;
        return new Promise<TResponse>((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            this._getWorker().postMessage({ ...request, id });
        });
    }

    /**
     * @cache_access
     * 终止 Worker 并拒绝所有 pending 请求.
     */
    dispose(): void {
        this._worker?.terminate();
        this._worker = null;

        const error = new Error('Compute worker disposed');
        for (const pending of this._pending.values()) {
            pending.reject(error);
        }
        this._pending.clear();
    }

    /**
     * @cache_access
     * 返回当前 Worker;不存在时创建并缓存.
     */
    private _getWorker(): Worker {
        if (this._worker) return this._worker;

        this._worker = this.workerFactory();
        this._worker.onmessage = (event: MessageEvent<ComputeWorkerMessage<TResponse>>) => {
            this._handleMessage(event.data);
        };
        this._worker.onerror = (event: ErrorEvent) => {
            const error = new Error(event.message || 'Compute worker failed');
            for (const pending of this._pending.values()) {
                pending.reject(error);
            }
            this._pending.clear();

            this._worker?.terminate();
            this._worker = null;
        };

        return this._worker;
    }

    /**
     * @cache_access
     * 根据响应 id 命中 pending 缓存并完成对应 Promise.
     */
    private _handleMessage(response: ComputeWorkerMessage<TResponse>): void {
        const pending = this._pending.get(response.id);
        if (!pending) return;

        this._pending.delete(response.id);
        if (response.error) {
            pending.reject(new Error(response.error));
            return;
        }
        pending.resolve(response);
    }
}

export type ComputeWorkerApi<
    TRequest extends { id: number },
    TResult,
> = {
    request(request: Omit<TRequest, 'id'>): Promise<TResult>;
    dispose(): void;
};

/**
 * 创建计算 Worker 客户端.
 *
 * 不同计算域(曲线/曲面/向量场/积分/求交)的差异只有 Worker 入口和响应
 * 字段映射,pending/错误传播/dispose 由 ComputeWorkerClient 统一处理;
 * 调用方不再需要各自写一个"几乎一样"的包装类.
 */
export function createComputeWorkerClient<
    TRequest extends { id: number },
    TResponse,
    TResult = TResponse,
>(
    workerFactory: () => Worker,
    decode?: (response: ComputeWorkerMessage<TResponse>) => TResult,
): ComputeWorkerApi<TRequest, TResult> {
    const client = new ComputeWorkerClient<TRequest, ComputeWorkerMessage<TResponse>>(
        workerFactory,
    );

    return {
        request(request) {
            const result = client.request(request);
            return decode ? result.then(decode) : (result as Promise<TResult>);
        },
        dispose() {
            client.dispose();
        },
    };
}
