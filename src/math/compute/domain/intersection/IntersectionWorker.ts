/**
 * 求交计算 Worker.
 *
 * 接收已经由 TS 适配层序列化好的对象描述符,在 Worker 内调用 Rust
 * `intersect_pair`;表达式只在 Rust 侧编译一次,后续网格/二分都复用上下文.
 */
import init, { intersect_pair } from '../../../../wasm/math_rs/math_rs';
import type { IntersectionComputeSide } from '../../../adapters/IntersectionMath';
import { createWasmWorker } from '../../wasm/wasmWorkerRuntime';

export type IntersectionWorkerRequest = {
    id: number;
    a: IntersectionComputeSide;
    b: IntersectionComputeSide;
    segments: number;
};

export type IntersectionWorkerResponse = {
    id: number;
    points?: Float64Array;
    curvePoints?: Float64Array;
    curveOffsets?: Uint32Array;
    error?: string;
};

/**
 * @cache
 * 缓存目的:Worker 内只初始化一次 math_rs WASM 实例,后续请求复用.
 * 键/失效策略:模块级 Promise;永不失效.
 * 生命周期:随 Worker 实例存活.
 */
const wasmInit = init();

/**
 * 把一侧对象描述符展开成 Rust `IntersectPairPayload` 的 JSON 键(前缀区分两侧).
 *
 * `IntersectionComputeSide` 的六个字段在类型契约上就是普通数组
 * (`describeSide` 里分别来自 `splitCoefficients` / `flattenOptionalMat4` /
 * 各 `*Params`),JSON.stringify 直接序列化成数组字面量,不需要再 `[...]`
 * 拷贝一份.这里依赖该契约:若哪天某个字段变成 Float64Array,序列化会变成
 * `{"0":..}`,必须改回显式 `Array.from`.
 */
function sidePayload(prefix: 'a' | 'b', side: IntersectionComputeSide): Record<string, unknown> {
    return {
        [`kind_${prefix}`]: side.kind,
        [`expr_${prefix}`]: side.expr,
        [`coeff_names_${prefix}`]: side.coefficientNames,
        [`coeff_values_${prefix}`]: side.coefficientValues,
        [`params_${prefix}`]: side.params,
        [`matrix_${prefix}`]: side.matrix,
        [`inverse_${prefix}`]: side.inverse,
    };
}

createWasmWorker<IntersectionWorkerRequest, IntersectionWorkerResponse>(
    wasmInit,
    (request, post) => {
        const payload = JSON.stringify({
            ...sidePayload('a', request.a),
            ...sidePayload('b', request.b),
            segments: request.segments,
        });
        const output = intersect_pair(payload);
        const points = output.points;
        const curvePoints = output.curve_points;
        const curveOffsets = output.curve_offsets;
        post(
            {
                id: request.id,
                points,
                curvePoints,
                curveOffsets,
            },
            [points.buffer, curvePoints.buffer, curveOffsets.buffer],
        );
    },
);
