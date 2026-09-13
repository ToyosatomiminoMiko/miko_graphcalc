import init, { sample_and_process_surface } from '../../../wasm/render_rs/render_rs';
import { createWasmWorker } from './wasmWorkerRuntime';

// ================================================================
// SurfaceWorker - 曲面采样 Worker
//
// 架构流程:
//   DOM slider input
//     -> rAF dirty draw
//     -> SurfaceRenderer.draw()
//     -> SurfaceMesh.requestUpdate()
//     -> SurfaceComputeClient
//     -> SurfaceWorker (本文件)
//     -> Rust/WASM sample_and_process_surface
//     -> Transferable 数组
//     -> SurfaceMesh.applyResult()
//     -> Three.js BufferGeometry
//
// 注意:顶点配色(HSL 伪彩色)已从 CPU 侧移除,改由渲染侧的顶点
// 着色器依据 position.z 与 zMin/zMax 实时计算,因此这里不再传递 colors.
//
// 注意(跨模块依赖):本文件从 `wasm/render_rs/render_rs` 导入,而非
// `wasm/math_rs/math_rs`.原因:曲面采样输出的是"渲染可直接消费的网格"
// (positions/normals/validIndices),属渲染职责,由 render_rs 的
// sample_and_process_surface 统一完成采样+后处理;math/core 的其它采样
// (曲线/向量场/求交/积分)则走 math_rs.刻意为之,勿为了"math 只用 math_rs"
// 而把它搬回 math_rs.
// ================================================================

export type SurfaceWorkerRequest = {
    /** 请求序号,由主线程递增,用来丢弃过期结果 */
    id: number;
    expr: string;
    coeffNames: string[];
    coeffValues: number[];
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    cols: number;
    rows: number;
};

export type SurfaceWorkerResponse = {
    id: number;
    positions: Float32Array;
    normals: Float32Array;
    validIndices: Uint32Array;
    zMin: number;
    zMax: number;
    /** Rust/WASM 采样+后处理整段耗时(ms).仅用于性能观测,不参与渲染逻辑. */
    computeMs: number;
    error?: string;
};

/**
 * @cache
 * 缓存目的:Worker 内只初始化一次 render_rs WASM 实例,后续请求复用.
 * 键/失效策略:模块级 Promise;永不失效.
 * 生命周期:随 Worker 实例存活.
 */
const wasmReady = init();

/**
 * 性能观测开关:在控制台执行 `sessionStorage.setItem('surfaceTiming','1')`
 * 后,每次采样请求会把整段 Rust/WASM 耗时打到 worker console.
 * 默认关闭,零额外输出(仅多两次 performance.now,可忽略).
 */
function surfaceTimingEnabled(): boolean {
    try {
        return sessionStorage.getItem('surfaceTiming') === '1';
    } catch {
        return false;
    }
}

createWasmWorker<SurfaceWorkerRequest, SurfaceWorkerResponse>(
    wasmReady,
    (req, post) => {
        const profile = surfaceTimingEnabled();
        const t0 = profile ? performance.now() : 0;

        // Worker 收到的普通数组先转成 WASM 期望的 Float64Array
        const coeffValues = new Float64Array(req.coeffValues);
        // 方案 A(曲面,多数组打包):Rust 现在直接返回一块打包好的 `Vec<u8>`
        // (glue 只做一次 `.slice()`,已消除 wasm-bindgen 结构体 getter 的 wasm 内
        // 克隆),不再是一个带 getter 的结构体对象.见
        // prompt/JS_WASM_BOUNDARY_COPY_REPORT.md.
        const packed = sample_and_process_surface(
            req.expr,
            req.coeffNames,
            coeffValues,
            req.xMin,
            req.xMax,
            req.yMin,
            req.yMax,
            req.cols,
            req.rows,
        );

        const computeMs = profile ? performance.now() - t0 : 0;
        if (profile) {
            console.info(
                `[surfaceTiming] ${req.cols}x${req.rows} "${req.expr}" = ${computeMs.toFixed(2)} ms`,
            );
        }

        // 拆包:头部元数据 + 零拷贝 subarray 视图.三个视图共享同一块
        // ArrayBuffer,后续整体 transfer 这一块 buffer,零额外拷贝.
        const dv = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
        const positionsLen = dv.getUint32(0, true);
        const normalsLen = dv.getUint32(4, true);
        const validIndicesLen = dv.getUint32(8, true);
        const zMin = dv.getFloat64(12, true);
        const zMax = dv.getFloat64(20, true);

        const headerBytes = 28;
        const base = packed.byteOffset + headerBytes;
        const positions = new Float32Array(packed.buffer, base, positionsLen);
        const normals = new Float32Array(packed.buffer, base + positionsLen * 4, normalsLen);
        const validIndices = new Uint32Array(
            packed.buffer,
            base + (positionsLen + normalsLen) * 4,
            validIndicesLen,
        );

        const response: SurfaceWorkerResponse = {
            id: req.id,
            positions,
            normals,
            validIndices,
            zMin,
            zMax,
            computeMs,
        };

        // 三个视图共享 `packed.buffer`,只需把它 transfer 一次(对同一块 buffer
        // 重复列出会抛错),避免结构化克隆再复制一遍大数组.
        post(response, [packed.buffer]);
    },
);
