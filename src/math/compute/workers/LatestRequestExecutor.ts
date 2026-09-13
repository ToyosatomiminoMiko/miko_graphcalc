/**
 * 单飞请求执行器.
 * 只在同一时刻运行一个请求;执行期间收到新请求时,
 * 只保留最新的那个,旧请求会被拒绝,避免高频刷新时积压.
 */
type PendingRequest<TRequest, TResponse> = {
    id: number;
    request: Omit<TRequest, 'id'>;
    resolve: (response: TResponse) => void;
    reject: (error: Error) => void;
};

export type RequestClient<TRequest extends { id: number }, TResponse> = {
    request(request: Omit<TRequest, 'id'>): Promise<TResponse>;
    dispose?: () => void;
};

export class LatestRequestExecutor<
    TRequest extends { id: number },
    TResponse,
> {
    /**
     * @cache
     * 缓存目的:维护 latest-only 队列所需的当前请求号和待处理请求.
     * 键/失效策略:_latestId 只增;_pending 只保留最新一个请求,旧请求拒绝.
     * 生命周期:跟随 LatestRequestExecutor 实例.
     */
    private _latestId = 0;
    private _inFlight = false;
    private _pending: PendingRequest<TRequest, TResponse> | null = null;
    private _disposed = false;

    constructor(private readonly client: RequestClient<TRequest, TResponse>) {}

    /**
     * @cache_access
     * 提交一个 latest-only 请求;执行中的旧请求会被后续请求取代.
     */
    request(request: Omit<TRequest, 'id'>): Promise<TResponse> {
        const id = ++this._latestId;
        if (this._inFlight) {
            this._pending?.reject(new Error('superseded'));
            return new Promise<TResponse>((resolve, reject) => {
                this._pending = { id, request, resolve, reject };
            });
        }

        this._inFlight = true;
        return this._run(id, request);
    }

    /**
     * @cache_access
     * 清空待处理请求并停止调度;不负责销毁共享 worker client.
     */
    dispose(): void {
        this._disposed = true;
        this._pending?.reject(new Error('LatestRequestExecutor disposed'));
        this._pending = null;
        // 这里的 client 可能是多个 renderer 共享的全局 worker client.
        // LatestRequestExecutor 只负责取消自己的逻辑请求,不能顺手 terminate
        // 掉其他对象仍在使用的 worker;全局 client 由应用级 owner 统一释放.
    }

    private async _run(
        id: number,
        request: Omit<TRequest, 'id'>,
    ): Promise<TResponse> {
        try {
            const response = await this.client.request(request);
            if (this._disposed || id !== this._latestId) {
                throw new Error('superseded');
            }
            return response;
        } finally {
            const next = this._pending;
            this._pending = null;
            this._inFlight = false;

            if (next && !this._disposed) {
                this._inFlight = true;
                void this._run(next.id, next.request)
                    .then(next.resolve, next.reject);
            }
        }
    }
}
