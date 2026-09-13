import init, { sample_curve } from '../../../wasm/math_rs/math_rs';
import { createWasmWorker } from './wasmWorkerRuntime';

export type CurveWorkerRequest = {
    id: number;
    expr: string;
    coeffNames: string[];
    coeffValues: number[];
    range: [number, number];
    segments: number;
};

export type CurveWorkerResponse = {
    id: number;
    points: Float32Array;
    /** 每段在 `points` 里的起始顶点下标;末项等于顶点总数. */
    offsets: Uint32Array;
    error?: string;
};

/**
 * @cache
 * 缓存目的:Worker 内只初始化一次 math_rs WASM 实例,后续请求复用.
 * 键/失效策略:模块级 Promise;永不失效.
 * 生命周期:随 Worker 实例存活.
 */
const wasmInit = init();

createWasmWorker<CurveWorkerRequest, CurveWorkerResponse>(
    wasmInit,
    (req, post) => {
        const result = sample_curve(
            req.expr,
            req.coeffNames,
            new Float64Array(req.coeffValues),
            req.range[0],
            req.range[1],
            req.segments,
        );
        // 曲线在定义域空洞/竖直渐近线处被切成多段:points 是扁平顶点数组,
        // offsets 是每段的起始顶点下标.两张缓冲都随响应转移,避免主线程再复制.
        post(
            { id: req.id, points: result.points, offsets: result.offsets },
            [result.points.buffer, result.offsets.buffer],
        );
    },
);
