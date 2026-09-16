/**
 * IntersectionWorker 载荷契约回归.
 *
 * 锁:sidePayload 输出的 JSON 键名与 Rust
 * `math_rs::wasm_payloads::IntersectPairPayload` 的 snake_case(前缀 a/b)
 * 完全一致,且两侧数组直接按数组字面量序列化(Float64Array 会变成
 * `{"0":..}`,Rust serde 无法按 Vec<f64> 反序列化).
 *
 * WASM 用桩替代,只观察 handler 拼出来的 JSON;不创建 Worker/WASM.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntersectionComputeSide } from '../../../math/adapters/IntersectionMath';
import type {
    IntersectionWorkerRequest,
    IntersectionWorkerResponse,
} from './IntersectionWorker';

const wasm = vi.hoisted(() => ({
    intersectPair: vi.fn(),
}));

vi.mock('../../../generated/math_rs/math_rs', () => ({
    default: vi.fn(() => Promise.resolve()),
    intersect_pair: wasm.intersectPair,
}));

type Posted = { response: IntersectionWorkerResponse; transfer?: Transferable[] };

const posted: Posted[] = [];
const selfStub = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (response: unknown, transfer?: Transferable[]) => {
        posted.push({ response: response as IntersectionWorkerResponse, transfer });
    },
};
vi.stubGlobal('self', selfStub);

await import('./IntersectionWorker');

const sideA: IntersectionComputeSide = {
    kind: 'curve',
    expr: 'x^2',
    coefficientNames: ['a'],
    coefficientValues: [1],
    params: [-1, 1],
    matrix: [],
    inverse: [],
};

const sideB: IntersectionComputeSide = {
    kind: 'sphere',
    expr: '',
    coefficientNames: [],
    coefficientValues: [],
    params: [0, 0, 0, 2],
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    inverse: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
};

/** 与 Rust `IntersectPairPayload` 字段一一对应的键集合. */
const EXPECTED_KEYS = [
    'coeff_names_a',
    'coeff_names_b',
    'coeff_values_a',
    'coeff_values_b',
    'expr_a',
    'expr_b',
    'inverse_a',
    'inverse_b',
    'kind_a',
    'kind_b',
    'matrix_a',
    'matrix_b',
    'params_a',
    'params_b',
    'segments',
];

async function dispatch(request: IntersectionWorkerRequest): Promise<Record<string, unknown>> {
    selfStub.onmessage?.({ data: request } as MessageEvent<IntersectionWorkerRequest>);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return JSON.parse(wasm.intersectPair.mock.calls[0][0] as string) as Record<string, unknown>;
}

beforeEach(() => {
    posted.length = 0;
    wasm.intersectPair.mockReset().mockReturnValue({
        points: new Float64Array([0, 0, 1]),
        curve_points: new Float64Array([0, 0, 0]),
        curve_offsets: new Uint32Array([0, 1]),
    });
});

describe('IntersectionWorker 载荷', () => {
    it('键名与 Rust IntersectPairPayload 完全一致(snake_case,前缀 a/b)', async () => {
        const payload = await dispatch({ id: 1, a: sideA, b: sideB, segments: 64 });

        expect(Object.keys(payload).sort()).toEqual(EXPECTED_KEYS);
        expect(payload.kind_a).toBe('curve');
        expect(payload.kind_b).toBe('sphere');
        expect(payload.expr_a).toBe('x^2');
        expect(payload.segments).toBe(64);
    });

    it('两侧数组按数组字面量序列化,值原样透传', async () => {
        const payload = await dispatch({ id: 2, a: sideA, b: sideB, segments: 128 });

        expect(payload.coeff_values_a).toEqual([1]);
        expect(payload.params_a).toEqual([-1, 1]);
        expect(payload.matrix_a).toEqual([]);
        expect(payload.inverse_a).toEqual([]);
        expect(payload.params_b).toEqual([0, 0, 0, 2]);
        expect(payload.matrix_b).toHaveLength(16);
        expect(payload.inverse_b).toHaveLength(16);
        // 关键:JSON 里每个数组字段都必须是数组,而不是 {"0":..} 对象.
        for (const key of EXPECTED_KEYS) {
            if (key === 'kind_a' || key === 'kind_b' || key === 'expr_a'
                || key === 'expr_b' || key === 'segments') {
                continue;
            }
            expect(Array.isArray(payload[key])).toBe(true);
        }
    });

    it('结果数组按 Transferable 转回主线程', async () => {
        await dispatch({ id: 3, a: sideA, b: sideB, segments: 32 });

        expect(posted).toHaveLength(1);
        expect(posted[0].response.points).toBeInstanceOf(Float64Array);
        expect(posted[0].response.curvePoints).toBeInstanceOf(Float64Array);
        expect(posted[0].response.curveOffsets).toBeInstanceOf(Uint32Array);
        expect(posted[0].transfer).toHaveLength(3);
    });
});
