import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { DslIntegralRenderer } from './DslIntegralRenderer';
import type { MathComputeEngine } from '../../math/compute/MathComputeEngine';
import type { IntegralResult } from '../../math/compute/workers/IntegralCompute';
import type { CurveObject, IntegralTask, SceneObject } from '../../compiler/ir/types';

type Deferred = { resolve: (r: IntegralResult) => void; reject: (e: Error) => void };

/** 桩计算引擎:每次 integrate 记录任务名并返回一个手动结算的 Promise. */
function deferredEngine() {
    const pending: Deferred[] = [];
    const calls: string[] = [];
    const engine = {
        integrate: (task: IntegralTask): Promise<IntegralResult> => {
            calls.push(task.name);
            return new Promise<IntegralResult>((resolve, reject) => {
                pending.push({ resolve, reject });
            });
        },
    };
    return { engine, pending, calls };
}

function makeRenderer(engine: unknown): DslIntegralRenderer {
    return new DslIntegralRenderer(new THREE.Scene(), engine as MathComputeEngine);
}

function curveObject(id: number): CurveObject {
    return {
        kind: 'curve',
        id,
        name: `c${id}`,
        expr: 'x',
        coefficients: [],
        color: '#ffffff',
        enabled: true,
    };
}

function integralTask(
    name: string,
    objectId: number,
    patch: Partial<IntegralTask> = {},
): IntegralTask {
    return {
        name,
        objectId,
        sourceKind: 'curve',
        dim: 1,
        domainKind: 'interval',
        method: 'riemann:left',
        integrand: 'x',
        integrandCoefficients: [],
        countCoefficients: [],
        range: [0, 1],
        segments: 4,
        show: false,
        enabled: true,
        ...patch,
    } as IntegralTask;
}

const OK: IntegralResult = { value: 1 };
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('DslIntegralRenderer 调度(RND-P2.2 / RND-P2.3)', () => {
    it('过期任务只跳过自己,同批后续积分照常计算', async () => {
        const { engine, pending, calls } = deferredEngine();
        const renderer = makeRenderer(engine);
        const objects: SceneObject[] = [curveObject(1), curveObject(2), curveObject(3)];
        const tasks = [
            integralTask('A', 1),
            integralTask('B', 2),
            integralTask('C', 3),
        ];

        renderer.sync(tasks, objects, {}, vi.fn());
        expect(calls).toEqual(['A']);

        // 局部刷新只影响 A:A 拿到新序号,第二个 pass 启动
        renderer.sync([tasks[0]], objects, {}, vi.fn(), new Set([1]));
        expect(calls).toEqual(['A', 'A']);

        // 第一个 pass 的 A 结算 -> 序号过期,只跳过 A,继续 B
        pending[0].resolve(OK);
        await tick();
        expect(calls).toEqual(['A', 'A', 'B']);

        // B 结算后 C 继续被计算(旧实现会在 A 处 return,整批丢弃)
        pending[2].resolve(OK);
        await tick();
        expect(calls).toEqual(['A', 'A', 'B', 'C']);

        renderer.dispose();
    });

    it('superseded 不是计算失败:不触发 onError/diagnostics', async () => {
        const { engine, pending } = deferredEngine();
        const renderer = makeRenderer(engine);
        const errors: Array<[string, string]> = [];
        const diagnostics: string[] = [];

        renderer.sync(
            [integralTask('B', 1)],
            [curveObject(1)],
            {},
            (level, message) => diagnostics.push(`${level}:${message}`),
            null,
            null,
            undefined,
            (name, message) => errors.push([name, message]),
        );

        pending[0].reject(new Error('superseded'));
        await tick();

        expect(errors).toEqual([]);
        expect(diagnostics).toEqual([]);
        renderer.dispose();
    });

    it('其他错误仍然上报', async () => {
        const { engine, pending } = deferredEngine();
        const renderer = makeRenderer(engine);
        const errors: string[] = [];

        renderer.sync(
            [integralTask('B', 1)],
            [curveObject(1)],
            {},
            vi.fn(),
            null,
            null,
            undefined,
            (name, message) => errors.push(`${name}:${message}`),
        );

        pending[0].reject(new Error('worker boom'));
        await tick();

        expect(errors).toEqual(['B:积分 B 计算失败: worker boom']);
        renderer.dispose();
    });
});

describe('DslIntegralRenderer.sync overlayOnly(RND-P3.9)', () => {
    it('仅显隐变化时不重算已有积分,禁用的清除,重新启用的补算', async () => {
        const { engine, pending, calls } = deferredEngine();
        const renderer = makeRenderer(engine);
        const visualizer = (renderer as unknown as {
            visualizer: { clear: (name: string) => void };
        }).visualizer;
        const clearSpy = vi.spyOn(visualizer, 'clear').mockImplementation(() => {});

        const objects: SceneObject[] = [curveObject(1), curveObject(2)];
        const enabledTasks = [integralTask('A', 1), integralTask('B', 2)];

        // 全量运行:两个任务都算出来
        renderer.sync(enabledTasks, objects, {}, vi.fn());
        pending[0].resolve(OK);
        await tick();
        pending[1].resolve(OK);
        await tick();
        expect(calls).toEqual(['A', 'B']);

        // overlayOnly:两个任务都还在且启用 -> 一个都不重算
        renderer.sync(enabledTasks, objects, {}, vi.fn(), null, null, undefined, undefined, true);
        await tick();
        expect(calls).toEqual(['A', 'B']);
        expect(clearSpy).not.toHaveBeenCalled();

        // 禁用 B -> 清掉 B 的可视化,不重算任何任务
        const disabled = [enabledTasks[0], { ...enabledTasks[1], enabled: false }];
        renderer.sync(disabled, objects, {}, vi.fn(), null, null, undefined, undefined, true);
        await tick();
        expect(calls).toEqual(['A', 'B']);
        expect(clearSpy).toHaveBeenCalledWith('B');

        // 重新启用 B -> 只有 B 被补算
        renderer.sync(enabledTasks, objects, {}, vi.fn(), null, null, undefined, undefined, true);
        expect(calls).toEqual(['A', 'B', 'B']);
        pending[2].resolve(OK);
        await tick();

        clearSpy.mockRestore();
        renderer.dispose();
    });
});

describe('DslIntegralRenderer 实体域边界校验(RND-P3.16)', () => {
    function solidTask(): IntegralTask {
        return integralTask('V', 1, {
            domainKind: 'solid',
            dim: 3,
            sourceKind: 'sphere',
        });
    }

    const sphere = {
        kind: 'sphere',
        id: 1,
        name: 's',
        center: { x: 0, y: 0, z: 0 },
        radius: 1,
        color: '#ffffff',
        enabled: true,
    } as unknown as SceneObject;

    it('六个边界不全有限时直接早返回', () => {
        const renderer = makeRenderer({ integrate: vi.fn() });
        const visualizer = (renderer as unknown as {
            visualizer: { visualize3DSolid: (...args: unknown[]) => void };
        }).visualizer;
        const spy = vi.spyOn(visualizer, 'visualize3DSolid').mockImplementation(() => {});

        const incomplete: IntegralResult = {
            value: 1,
            samples: Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
            n: 2,
            xa: 0,
            xb: undefined,
            ya: 0,
            yb: 1,
            za: 0,
            zb: 1,
        };
        (renderer as unknown as {
            _visualize3DSolid(
                t: IntegralTask, s: SceneObject, r: IntegralResult, d: () => void,
            ): void;
        })._visualize3DSolid(solidTask(), sphere, incomplete, () => {});

        expect(spy).not.toHaveBeenCalled();

        // 六个边界齐全时正常进入可视化
        const complete: IntegralResult = { ...incomplete, xb: 1 };
        (renderer as unknown as {
            _visualize3DSolid(
                t: IntegralTask, s: SceneObject, r: IntegralResult, d: () => void,
            ): void;
        })._visualize3DSolid(solidTask(), sphere, complete, () => {});
        expect(spy).toHaveBeenCalledTimes(1);

        spy.mockRestore();
        renderer.dispose();
    });
});
