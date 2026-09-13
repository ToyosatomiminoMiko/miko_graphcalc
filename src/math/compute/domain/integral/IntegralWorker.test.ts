/**
 * IntegralWorker 请求载荷回归.
 *
 * 锁两件事:
 * 1. 请求不再携带死字段 `dim`(compute 只按 domainKind 路由,从不读它);
 * 2. 所有 `Float64Array` 在 JSON.stringify 前都被显式数组化
 *    (`JSON.stringify(new Float64Array([1,2]))` 得到的是 `{"0":1,"1":2}`
 *    对象而不是数组,Rust serde 按 Vec<f64> 反序列化会失败),普通数组字段
 *    则直接传引用,不再多拷一份.
 *
 * WASM 用桩替代,只观察 handler 拼出来的 JSON;不创建 Worker/WASM.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    IntegralWorkerRequest,
    IntegralWorkerResponse,
} from './IntegralWorker';

const wasm = vi.hoisted(() => ({
    integrate1d: vi.fn(),
    integrate2d: vi.fn(),
    integrateRegion: vi.fn(),
    integrateSolid: vi.fn(),
}));

vi.mock('../../../../wasm/math_rs/math_rs', () => ({
    default: vi.fn(() => Promise.resolve()),
    integrate1d: wasm.integrate1d,
    integrate2d: wasm.integrate2d,
    integrate_region: wasm.integrateRegion,
    integrate_solid: wasm.integrateSolid,
}));

type Posted = { response: IntegralWorkerResponse; transfer?: Transferable[] };

const posted: Posted[] = [];
const selfStub = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (response: unknown, transfer?: Transferable[]) => {
        posted.push({ response: response as IntegralWorkerResponse, transfer });
    },
};
vi.stubGlobal('self', selfStub);

await import('./IntegralWorker');

function result(sampleShape: string, n = 2, m?: number): Record<string, unknown> {
    return {
        value: 1,
        samples: new Float64Array([0, 1]),
        sample_shape: sampleShape,
        n,
        m,
    };
}

/** 派发一条请求并等 handler 的 `await init` + 同步计算跑完. */
async function dispatch(request: IntegralWorkerRequest): Promise<Record<string, unknown>> {
    selfStub.onmessage?.({ data: request } as MessageEvent<IntegralWorkerRequest>);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const call = [
        wasm.integrate1d,
        wasm.integrate2d,
        wasm.integrateRegion,
        wasm.integrateSolid,
    ].find((mock) => mock.mock.calls.length > 0);
    return JSON.parse(call!.mock.calls[0][0] as string) as Record<string, unknown>;
}

beforeEach(() => {
    posted.length = 0;
    wasm.integrate1d.mockReset().mockReturnValue(result('1d-grid'));
    wasm.integrate2d.mockReset().mockReturnValue(result('2d-grid', 2, 2));
    wasm.integrateRegion.mockReset().mockReturnValue(result('2d-cell', 2, 2));
    wasm.integrateSolid.mockReset().mockReturnValue(result('3d-cells', 2, 2));
});

describe('IntegralWorker 载荷', () => {
    it('interval:无 dim 字段,Float64Array 系数序列化成真数组', async () => {
        const payload = await dispatch({
            id: 7,
            method: 'riemann:left',
            domainKind: 'interval',
            integrandExpr: 'x*y',
            integrandCoeffs: { b: 2, a: 1 },
            a: 0,
            b: 1,
            n: 4,
        });

        expect(payload).not.toHaveProperty('dim');
        expect(Object.keys(payload).sort()).toEqual([
            'a',
            'b',
            'coeff_names',
            'coeff_values',
            'expr',
            'layers',
            'method',
            'n',
        ]);
        // 名字有序(a,b)是 math_rs 系数约定;值来自 Float64Array,必须是数组.
        expect(payload.coeff_names).toEqual(['a', 'b']);
        expect(Array.isArray(payload.coeff_values)).toBe(true);
        expect(payload.coeff_values).toEqual([1, 2]);

        expect(posted).toHaveLength(1);
        expect(posted[0].response.value).toBe(1);
        expect(posted[0].transfer).toEqual([expect.any(ArrayBuffer)]);
    });

    it('region:integrand 与两条边界的 Float64Array 都数组化', async () => {
        const payload = await dispatch({
            id: 8,
            method: 'riemann:left',
            domainKind: 'region',
            integrandExpr: '1',
            integrandCoeffs: { k: 3 },
            xa: -1,
            xb: 1,
            boundaryA: { expr: 'x', coeffs: { a: 1 } },
            boundaryB: { expr: '-x', coeffs: {} },
            n: 4,
        });

        expect(payload).not.toHaveProperty('dim');
        expect(Array.isArray(payload.integrand_values)).toBe(true);
        expect(payload.integrand_values).toEqual([3]);
        expect(Array.isArray(payload.boundary_a_values)).toBe(true);
        expect(payload.boundary_a_values).toEqual([1]);
        expect(Array.isArray(payload.boundary_b_values)).toBe(true);
        expect(payload.boundary_b_values).toEqual([]);
    });

    it('solid:params/matrix/inverse 本就是普通数组,直接按数组序列化', async () => {
        const payload = await dispatch({
            id: 9,
            method: 'riemann:left',
            domainKind: 'solid',
            integrandExpr: '1',
            integrandCoeffs: { k: 5 },
            solid: {
                kind: 'sphere',
                params: [1, 2, 3, 4],
                matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                inverse: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            },
            n: 4,
        });

        expect(payload).not.toHaveProperty('dim');
        expect(payload.params).toEqual([1, 2, 3, 4]);
        expect(Array.isArray(payload.params)).toBe(true);
        expect(Array.isArray(payload.matrix_values)).toBe(true);
        expect(payload.matrix_values).toEqual([
            1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
        ]);
        expect(Array.isArray(payload.inverse_values)).toBe(true);
        expect(Array.isArray(payload.integrand_values)).toBe(true);
        expect(payload.integrand_values).toEqual([5]);
    });
});
