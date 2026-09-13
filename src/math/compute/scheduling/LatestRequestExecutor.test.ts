/**
 * LatestRequestExecutor dispose 终态回归.
 *
 * dispose 只清自己的 pending,不销毁共享 client;但修复前 request 没有
 * `_disposed` 检查,dispose 之后的新请求仍会走 `_run` 派发给已销毁的
 * client(对 integral/intersection 这些模块级单例来说就是"释放后又复活").
 */
import { describe, expect, it, vi } from 'vitest';
import {
    LatestRequestExecutor,
    type RequestClient,
} from './LatestRequestExecutor';

type TestRequest = { id: number; value: number };
type TestResponse = { value: number };

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

describe('LatestRequestExecutor', () => {
    it('dispose 后 request 直接 reject("disposed"),不再派发给 client', async () => {
        const request = vi.fn();
        const client: RequestClient<TestRequest, TestResponse> = {
            request,
            dispose: vi.fn(),
        };
        const executor = new LatestRequestExecutor<TestRequest, TestResponse>(client);

        executor.dispose();

        await expect(executor.request({ value: 1 })).rejects.toThrow('disposed');
        expect(request).not.toHaveBeenCalled();
    });

    it('dispose 会拒绝排队中的 pending,在飞请求结算后也不再派发', async () => {
        const first = deferred<TestResponse>();
        const request = vi.fn(() => first.promise);
        const client: RequestClient<TestRequest, TestResponse> = {
            request,
            dispose: vi.fn(),
        };
        const executor = new LatestRequestExecutor<TestRequest, TestResponse>(client);

        const inFlight = executor.request({ value: 1 });
        const inFlightRejects = expect(inFlight).rejects.toThrow('superseded');
        const queued = executor.request({ value: 2 });
        const queuedRejects = expect(queued).rejects.toThrow(
            'LatestRequestExecutor disposed',
        );

        executor.dispose();
        await queuedRejects;

        first.resolve({ value: 1 });
        await inFlightRejects;
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('dispose 前的 latest-only 行为不变:在飞请求被顶掉,最新请求返回结果', async () => {
        const first = deferred<TestResponse>();
        const second = deferred<TestResponse>();
        const request = vi.fn()
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise);
        const client: RequestClient<TestRequest, TestResponse> = {
            request,
            dispose: vi.fn(),
        };
        const executor = new LatestRequestExecutor<TestRequest, TestResponse>(client);

        const stale = executor.request({ value: 1 });
        const staleRejects = expect(stale).rejects.toThrow('superseded');
        const latest = executor.request({ value: 2 });

        first.resolve({ value: 1 });
        await staleRejects;

        second.resolve({ value: 2 });
        await expect(latest).resolves.toEqual({ value: 2 });
        expect(request).toHaveBeenCalledTimes(2);
    });
});
