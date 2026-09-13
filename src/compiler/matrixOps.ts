/**
 * WASM 矩阵运算后端.
 *
 * 为什么放在 `compiler/` 下:
 * - 编译期需要真正求值:`dsl/staticScene.ts` 折叠 transform/动画表达式时经
 *   `parseTransformExpression(expr, matrices, transforms, matrixOps)` 得到
 *   具体 Mat4(transforms 表支持声明体内的引用),编译管线以
 *   `compileScene(ast, params, matrixOps)` 显式注入本模块产物,
 *   生产 WASM 实现必须与编译需求方同侧,调用方为 `app/CompileController.ts`.
 * - 与 DSL 解析无关,独立成模块:避免 `parser` 包同时承担解析与矩阵后端职责.
 * - 分层约定:纯接口 `MatrixOps`/`createMatrixOps` 在 `math/tensor/SceneTransform.ts`,
 *   纯 JS 参考实现只保留在 `math/tensor/testMatrixOps.ts`(供单测,避免 JS/Rust
 *   两套公式同时成为运行真相),生产 WASM 后端即本文件.放 `math/tensor/` 会令
 *   纯张量层反向依赖 `wasm/math_rs` 绑定,放 `parser/` 又混入解析之外职责.
 *
 * 注意:matrixOps 并非编译期专属--SceneStore 保存后 `render/core/AnimationPlayer.ts`
 * 每帧动画累乘也调用同一实例,属跨编译/渲染共享的注入对象.本目录归属以"编译期
 * 变换求值"为主要理由;若日后迁移位置,需同步 `math/tensor/SceneTransform.ts`
 * 头注释与 `app/CompileController.ts` 的导入路径.
 */
import {
    mat4_apply_point as wasmMat4ApplyPoint,
    mat4_identity as wasmMat4Identity,
    mat4_multiply as wasmMat4Multiply,
    mat4_rotate as wasmMat4Rotate,
    mat4_scale as wasmMat4Scale,
    mat4_translate as wasmMat4Translate,
} from '../wasm/math_rs/math_rs';
import {
    createMatrixOps,
    type MatrixWasmBackend,
    type MatrixOps,
} from '../math/tensor/SceneTransform';
import {
    flattenMat4,
    mat4FromFlat,
    type Mat4,
} from '../math/tensor/rowMajorMatrix';

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

/** 创建基于 WASM 的矩阵运算后端,调用方需先 `ensureWasmReady`. */
export function createWasmMatrixOps(): MatrixOps {
    const backend: MatrixWasmBackend = {
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

    return createMatrixOps(backend);
}
