/**
 * WASM 矩阵运算后端.
 *
 * 位置:本目录(`wasm/`)是**手写 WASM 粘合层**,与 `generated/`(wasm-pack
 * 产物)配对.凡是必须直接调用 wasm-bindgen 导出,又在主线程或 Worker 里被
 * 复用的粘合代码都收敛在这里:主线程初始化 `wasm/init.ts`,Worker 侧消息壳
 * `wasm/workerRuntime.ts`,矩阵后端就是本文件.
 *
 * 为什么不在 `math/matrix/`:
 * - 纯接口 `MatrixOps` 与行主序矩阵留在 `math/matrix/`,那一层保持"零 WASM
 *   依赖",实现只通过注入进入编译器与动画播放器;
 * - 本文件是唯一实现(生产与测试注入同一份,见 `testing/matrixOps.ts`);
 *   调用方是 `app/CompileController.ts`(编译期折叠 transform/动画表达式)与
 *   `render/core/AnimationPlayer.ts`(每帧动画累乘),属跨编译/渲染共享的
 *   注入对象,因此不能挂在任何一侧的业务目录下;
 * - 放 `math/matrix/` 会让纯矩阵层反向依赖 `generated/math_rs` 绑定.
 */
import {
    mat4_apply_point as wasmMat4ApplyPoint,
    mat4_identity as wasmMat4Identity,
    mat4_multiply as wasmMat4Multiply,
    mat4_rotate as wasmMat4Rotate,
    mat4_scale as wasmMat4Scale,
    mat4_translate as wasmMat4Translate,
} from '@/generated/math_rs/math_rs';
import type { MatrixOps } from '@/math/matrix/MatrixOps';
import {
    flattenMat4,
    mat4FromFlat,
    type Mat4,
} from '@/math/matrix/rowMajorMatrix';

function toMat4(values: Float64Array): Mat4 {
    const matrix = mat4FromFlat(Array.from(values));
    if (!matrix) {
        throw new TypeError('WASM 矩阵后端返回了非法矩阵');
    }
    return matrix;
}

function flattenMat4ToWasm(matrix: Mat4): Float64Array {
    return new Float64Array(flattenMat4(matrix));
}

/**
 * 创建基于 WASM 的矩阵运算后端,调用方需先 `ensureWasmReady`.
 *
 * 直接返回 `MatrixOps`:后端实现与接口同名同形,不再经过一层零逻辑包装.
 */
export function createWasmMatrixOps(): MatrixOps {
    return {
        identity: () => toMat4(wasmMat4Identity()),
        translate: (values) => toMat4(wasmMat4Translate(values[0], values[1], values[2])),
        scale: (values) => toMat4(wasmMat4Scale(values[0], values[1], values[2])),
        rotate: (values) => toMat4(wasmMat4Rotate(values[0], values[1], values[2])),
        multiply: (a, b) => toMat4(
            wasmMat4Multiply(flattenMat4ToWasm(a), flattenMat4ToWasm(b)),
        ),
        apply: (matrix, point) => Array.from(
            wasmMat4ApplyPoint(
                flattenMat4ToWasm(matrix),
                point[0],
                point[1],
                point[2],
            ),
        ),
    };
}
