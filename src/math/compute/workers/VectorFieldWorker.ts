import init, { sample_vector_field } from '../../../wasm/math_rs/math_rs';
import { createWasmWorker } from './wasmWorkerRuntime';

export type VectorFieldWorkerRequest = {
    id: number;
    pExpr: string;
    qExpr: string;
    rExpr: string;
    coeffNames: string[];
    coeffValues: number[];
    range: {
        x: [number, number];
        y: [number, number];
        z: [number, number];
    };
    gridSize: [number, number, number];
};

export type VectorFieldWorkerResponse = {
    id: number;
    vectors: Float32Array;
    error?: string;
};

/**
 * @cache
 * 缓存目的:Worker 内只初始化一次 math_rs WASM 实例,后续请求复用.
 * 键/失效策略:模块级 Promise;永不失效.
 * 生命周期:随 Worker 实例存活.
 */
const wasmInit = init();

createWasmWorker<VectorFieldWorkerRequest, VectorFieldWorkerResponse>(
    wasmInit,
    (req, post) => {
        const payload = JSON.stringify({
            p_expr: req.pExpr,
            q_expr: req.qExpr,
            r_expr: req.rExpr,
            coeff_names: req.coeffNames,
            coeff_values: [...req.coeffValues],
            x_min: req.range.x[0],
            x_max: req.range.x[1],
            y_min: req.range.y[0],
            y_max: req.range.y[1],
            z_min: req.range.z[0],
            z_max: req.range.z[1],
            nx: req.gridSize[0],
            ny: req.gridSize[1],
            nz: req.gridSize[2],
        });
        const vectors = sample_vector_field(payload);
        post({ id: req.id, vectors }, [vectors.buffer]);
    },
);
