/**
 * 矩阵运算接口.
 *
 * 编译层与渲染层都只通过 `MatrixOps` 调用外部注入的矩阵后端,不直接 import
 * 任何具体实现,避免模块级可变全局状态:
 * - 生产 WASM 后端见 `compiler/matrixOps.ts` 的 `createWasmMatrixOps`;
 * - 纯 JS 参考实现只保留在 `math/matrix/testBackend.ts`,供单元测试使用,
 *   避免 JS/Rust 两套矩阵公式同时成为运行真相.
 *
 * 这里只有**一个**接口:后端实现直接就是 `MatrixOps`.202609 重构前还存在一个
 * 形状逐字相同,仅多一层 `(args) => backend.method(args)` 零逻辑包装的
 * `MatrixWasmBackend` + `createMatrixOps`,已删除(见
 * prompt/refactor-and-rust-migration.md §2.1).
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
