/**
 * Worker 侧统一入口.
 *
 * 每个计算 Worker 的差异只有三件事:初始化哪个 WASM 包、请求/响应类型、
 * 调用哪个 wasm 函数.这里把 WASM init、onmessage 挂载、异常转 error
 * 响应收口成一份实现,Worker 文件只需声明类型并注册自己的处理函数.
 */
type WorkerScope = {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage(message: unknown, transfer?: Transferable[]): void;
};

export type WasmWorkerRequest = { id: number };
export type WasmWorkerResponse = { id: number; error?: string };

export type WasmWorkerPost<TResponse> = (
    response: TResponse,
    transfer?: Transferable[],
) => void;

/**
 * 挂载 Worker 消息处理.
 *
 * @param init WASM 初始化 Promise;每次请求前先等待,但只初始化一次.
 * @param handler 具体计算;通过 `post` 回传响应,支持 Transferable 大数组.
 */
export function createWasmWorker<
    TRequest extends WasmWorkerRequest,
    TResponse extends WasmWorkerResponse,
>(
    init: Promise<unknown>,
    handler: (
        request: TRequest,
        post: WasmWorkerPost<TResponse>,
    ) => void | Promise<void>,
): void {
    const scope = self as unknown as WorkerScope;

    scope.onmessage = (event: MessageEvent<TRequest>) => {
        const request = event.data;
        void (async () => {
            try {
                await init;
                await handler(request, (response, transfer) => {
                    scope.postMessage(response, transfer);
                });
            } catch (error) {
                scope.postMessage({
                    id: request.id,
                    error: error instanceof Error ? error.message : String(error),
                } as TResponse);
            }
        })();
    };
}
