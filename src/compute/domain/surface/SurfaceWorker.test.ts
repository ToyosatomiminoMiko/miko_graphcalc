/**
 * SurfaceWorker 回归:module Worker 里没有 `sessionStorage`.
 *
 * 原来的 `surfaceTimingEnabled()` 读 window 专有 API,在 Worker 全局里恒抛
 * ReferenceError 并被 catch 吞成 false,`if (profile)` 分支从未执行,是死
 * 代码.这里锁:即使把 `sessionStorage` 桩成"开关注记=1",handler 也不读它,
 * 不往 console 输出计时,同时 `computeMs` 仍是可用的观测值.
 *
 * WASM 用桩替代,只观察 handler 拼出来的响应;不创建 Worker/WASM.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceWorkerResponse } from './SurfaceWorker';

const wasm = vi.hoisted(() => ({
    sampleAndProcessSurface: vi.fn(),
}));

vi.mock('@/generated/render_rs/render_rs', () => ({
    default: vi.fn(() => Promise.resolve()),
    sample_and_process_surface: wasm.sampleAndProcessSurface,
}));

type Posted = { response: SurfaceWorkerResponse; transfer?: Transferable[] };

const posted: Posted[] = [];
const selfStub = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (response: unknown, transfer?: Transferable[]) => {
        posted.push({ response: response as SurfaceWorkerResponse, transfer });
    },
};
vi.stubGlobal('self', selfStub);

await import('./SurfaceWorker');

const HEADER_BYTES = 28;

/** 按 SurfaceWorker 的打包格式造一块 header + positions/normals/indices. */
function packSurface(
    positions: Float32Array,
    normals: Float32Array,
    validIndices: Uint32Array,
    zMin: number,
    zMax: number,
): Uint8Array {
    const buffer = new ArrayBuffer(
        HEADER_BYTES + positions.byteLength + normals.byteLength + validIndices.byteLength,
    );
    const dv = new DataView(buffer);
    dv.setUint32(0, positions.length, true);
    dv.setUint32(4, normals.length, true);
    dv.setUint32(8, validIndices.length, true);
    dv.setFloat64(12, zMin, true);
    dv.setFloat64(20, zMax, true);
    new Float32Array(buffer, HEADER_BYTES, positions.length).set(positions);
    new Float32Array(buffer, HEADER_BYTES + positions.byteLength, normals.length).set(normals);
    new Uint32Array(
        buffer,
        HEADER_BYTES + positions.byteLength + normals.byteLength,
        validIndices.length,
    ).set(validIndices);
    return new Uint8Array(buffer);
}

const getItem = vi.fn(() => '1');
const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});

afterAll(() => {
    consoleInfo.mockRestore();
});

beforeEach(() => {
    posted.length = 0;
    getItem.mockClear();
    consoleInfo.mockClear();
    wasm.sampleAndProcessSurface.mockReset().mockReturnValue(
        packSurface(
            new Float32Array([1, 2, 3]),
            new Float32Array([0, 1, 0]),
            new Uint32Array([0]),
            -1,
            2,
        ),
    );
    vi.stubGlobal('sessionStorage', { getItem });
});

describe('SurfaceWorker 不再使用 sessionStorage 计时开关', () => {
    it('不读取 sessionStorage,不输出计时,computeMs 仍可用', async () => {
        selfStub.onmessage?.({
            data: {
                id: 1,
                expr: 'x^2+y^2',
                coeffNames: [],
                coeffValues: [],
                xMin: -1,
                xMax: 1,
                yMin: -1,
                yMax: 1,
                cols: 1,
                rows: 1,
            },
        } as MessageEvent);

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getItem).not.toHaveBeenCalled();
        expect(consoleInfo).not.toHaveBeenCalled();

        expect(posted).toHaveLength(1);
        const { response, transfer } = posted[0];
        expect(response).toMatchObject({ id: 1, zMin: -1, zMax: 2 });
        expect(response.positions).toBeInstanceOf(Float32Array);
        expect(Array.from(response.positions)).toEqual([1, 2, 3]);
        expect(Number.isFinite(response.computeMs)).toBe(true);
        expect(response.computeMs).toBeGreaterThanOrEqual(0);
        expect(transfer).toEqual([expect.any(ArrayBuffer)]);
    });
});
