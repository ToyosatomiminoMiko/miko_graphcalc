/**
 * 矩阵运算接口.
 *
 * 编译层与渲染层都只通过 `MatrixOps` 调用外部注入的矩阵后端,不直接 import
 * 任何具体实现,避免模块级可变全局状态:
 * - 唯一的实现是 `compiler/matrixOps.ts` 的 `createWasmMatrixOps`(生产);
 * - 测试注入的也是同一个 WASM 后端(`test/matrixOps.ts`),矩阵公式只有 Rust
 *   `math_rs::transform_core` 一份真值,单测在 `transform_core.rs` 内.
 *   202609 删除了纯 JS 参考实现 `math/matrix/testBackend.ts`:JS/Rust 两套
 *   公式都要维护,还有悄悄分叉的风险.
 *
 * 这里只有**一个**接口:后端实现直接就是 `MatrixOps`.202609 重构前还存在一个
 * 形状逐字相同,仅多一层 `(args) => backend.method(args)` 零逻辑包装的
 * `MatrixWasmBackend` + `createMatrixOps`,已删除.
 */
import type { Mat4 } from './rowMajorMatrix';

/** 供编译/渲染层显式注入的矩阵运算接口,避免模块级可变全局状态. */
export interface MatrixOps {
    identity(): Mat4;
    translate(values: number[]): Mat4;
    scale(values: number[]): Mat4;
    rotate(values: number[]): Mat4;
    multiply(a: Mat4, b: Mat4): Mat4;
    apply(matrix: Mat4, point: number[]): number[];
}
