/**
 * 回归:积分 latest-only 必须**按任务**隔离(P0-4).
 *
 * 共用单个 executor 时,任务 A 的在飞请求会被"只刷新 A"的第二次 pass 顶掉,
 * 两次 A 都以 superseded 结算并被渲染层咽掉,A 永远没有结果(对象列表保留
 * 旧参数的积分值).这里用真实 `integrate` 路径 + Worker 桩验证:
 * - 不同任务各自派出请求,互不 superseded;
 * - 同一任务的新请求仍会真正跑并返回结果.
 *
 * 两个场景写在一个 it 里:`ComputeWorkerClient` 的 Worker 是模块级懒加载单例,
 * 跨测试无法重新创建(否则要显式 dispose 共享 worker).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IntegralWorkerRequest, IntegralWorkerResponse } from './IntegralWorker';
import type { IntegralSpec } from './IntegralCompute';
import { integrate } from './IntegralCompute';

type Stub = {
    onmessage: ((event: MessageEvent<IntegralWorkerResponse>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    postMessage: (message: IntegralWorkerRequest) => void;
    terminate: () => void;
};

const sent: number[] = [];
let worker: Stub | null = null;

function stubWorkerGlobal(): void {
    sent.length = 0;
    worker = null;
    vi.stubGlobal(
        'Worker',
        class {
            constructor() {
                const self = this as unknown as Stub;
                self.onmessage = null;
                self.onerror = null;
                self.terminate = () => {};
                self.postMessage = (message: IntegralWorkerRequest) => {
                    sent.push(message.id);
                };
                worker = self;
            }
        },
    );
}

function deliver(index: number, value: number): void {
    worker!.onmessage?.({
        data: { id: sent[index], value },
    } as MessageEvent<IntegralWorkerResponse>);
}

function spec(taskKey: string): IntegralSpec {
    return {
        taskKey,
        method: 'riemann:left',
        domainKind: 'interval',
        integrand: 'x',
        integrandCoeffs: {},
        range: [0, 1],
        segments: 4,
    };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const ignored = (promise: Promise<unknown>): void => {
    void promise.catch(() => {});
};

afterEach(() => {
    vi.unstubAllGlobals();
    sent.length = 0;
    worker = null;
});

describe('积分 latest-only 按任务隔离', () => {
    it('跨任务不互相顶掉;同任务刷新只顶掉自己的旧请求且最新请求仍返回结果', async () => {
        stubWorkerGlobal();

        // --- 跨任务:A 与 B 都必须被派出(共用 executor 时 B 只会在 A 之后)---
        const a = integrate(spec('A'));
        const b = integrate(spec('B'));
        ignored(a);
        ignored(b);
        await tick();
        expect(sent.length).toBe(2);

        // --- 同任务刷新:新 A 顶掉旧 A,但不影响 B ---
        const a2 = integrate(spec('A'));
        ignored(a2);
        await tick();
        expect(sent.length).toBe(2); // 旧 A 仍在飞,新 A 进 pending

        deliver(0, 1); // 旧 A -> superseded
        await tick();
        expect(sent.length).toBe(3); // 最新 A 被派发

        deliver(1, 22); // B 结算
        deliver(2, 33); // 最新 A 结算
        await tick();

        await expect(b).resolves.toMatchObject({ value: 22 });
        await expect(a2).resolves.toMatchObject({ value: 33 });
    });
});
