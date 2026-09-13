/**
 * ComputeWorkerClient 生命周期回归.
 *
 * 两条都是实测出来的泄漏/挂死:
 * 1. dispose 只置空 _worker,没有终态标志 -> 之后 request 会再 fork 一个
 *    不受跟踪的 Worker(创建次数 1 -> 2),调用方以为已经释放,实际泄漏
 *    一个线程 + WASM 实例;
 * 2. postMessage 走结构化克隆,DataCloneError 等同步异常不触发 onerror ->
 *    _pending 里的条目永不删除,连续失败 N 次就残留 N 条(请求既不 resolve
 *    也不 reject).
 *
 * Worker 全部用 vi.fn() 桩替代,不真的创建 Worker/WASM.
 */
import { describe, expect, it, vi } from 'vitest';
import {
    ComputeWorkerClient,
    type ComputeWorkerMessage,
} from './ComputeWorkerClient';

type TestRequest = { id: number; value: number };
type TestResponse = { id: number; value?: number; error?: string };

type WorkerStub = {
    onmessage: ((event: MessageEvent<ComputeWorkerMessage<TestResponse>>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
};

function workerStub(): WorkerStub {
    return {
        onmessage: null,
        onerror: null,
        postMessage: vi.fn(),
        terminate: vi.fn(),
    };
}

function clientWith(stub: WorkerStub): {
    client: ComputeWorkerClient<TestRequest, TestResponse>;
    factory: ReturnType<typeof vi.fn>;
} {
    const factory = vi.fn(() => stub as unknown as Worker);
    return { client: new ComputeWorkerClient<TestRequest, TestResponse>(factory), factory };
}

/** 白盒读取 pending 缓存大小:修复前 postMessage 抛错会让这里持续增长. */
function pendingSize(client: ComputeWorkerClient<TestRequest, TestResponse>): number {
    return (client as unknown as { _pending: Map<number, unknown> })._pending.size;
}

function message(
    data: ComputeWorkerMessage<TestResponse>,
): MessageEvent<ComputeWorkerMessage<TestResponse>> {
    return { data } as MessageEvent<ComputeWorkerMessage<TestResponse>>;
}

describe('ComputeWorkerClient', () => {
    it('正常请求:按 id 命中 pending 并 resolve,随后清空缓存', async () => {
        const stub = workerStub();
        const { client } = clientWith(stub);

        const promise = client.request({ value: 5 });
        expect(pendingSize(client)).toBe(1);

        const sent = stub.postMessage.mock.calls[0][0] as ComputeWorkerMessage<TestResponse>;
        expect(sent).toMatchObject({ id: 1, value: 5 });

        stub.onmessage?.(message({ id: sent.id, value: 10 }));
        await expect(promise).resolves.toMatchObject({ value: 10 });
        expect(pendingSize(client)).toBe(0);
    });

    it('dispose 后 request 直接 reject,不再 fork Worker', async () => {
        const stub = workerStub();
        const { client, factory } = clientWith(stub);

        const inFlight = client.request({ value: 1 });
        expect(factory).toHaveBeenCalledTimes(1);

        client.dispose();
        await expect(inFlight).rejects.toThrow('Compute worker disposed');

        await expect(client.request({ value: 2 })).rejects.toThrow(
            'Compute worker disposed',
        );
        // 关键:没有再创建第二个 Worker.
        expect(factory).toHaveBeenCalledTimes(1);
        expect(stub.terminate).toHaveBeenCalledTimes(1);
        expect(pendingSize(client)).toBe(0);
    });

    it('postMessage 同步抛错:删除 pending 并 reject,连续 5 次不残留', async () => {
        const stub = workerStub();
        const { client } = clientWith(stub);

        const cloneError = new Error('DataCloneError: value could not be cloned');
        stub.postMessage.mockImplementation(() => {
            throw cloneError;
        });

        const promises = Array.from({ length: 5 }, () => client.request({ value: 1 }));
        const results = await Promise.allSettled(promises);

        expect(results.map((result) => result.status)).toEqual([
            'rejected',
            'rejected',
            'rejected',
            'rejected',
            'rejected',
        ]);
        for (const result of results) {
            if (result.status === 'rejected') expect(result.reason).toBe(cloneError);
        }
        // 关键:修复前这里是 5.
        expect(pendingSize(client)).toBe(0);
    });

    it('单次同步抛错不污染后续请求', async () => {
        const stub = workerStub();
        const { client } = clientWith(stub);

        stub.postMessage.mockImplementationOnce(() => {
            throw new Error('boom');
        });

        await expect(client.request({ value: 1 })).rejects.toThrow('boom');
        expect(pendingSize(client)).toBe(0);

        const ok = client.request({ value: 2 });
        const sent = stub.postMessage.mock.calls[1][0] as ComputeWorkerMessage<TestResponse>;
        stub.onmessage?.(message({ id: sent.id, value: 42 }));
        await expect(ok).resolves.toMatchObject({ value: 42 });
        expect(pendingSize(client)).toBe(0);
    });
});
