/**
 * 矩阵运算后端接口.
 *
 * 生产代码只通过 `MatrixOps` 调用外部注入的后端;WASM 后端见
 * `compiler/matrixOps.ts` 的 `createWasmMatrixOps`.纯 JS 参考实现只保留在
 * `math/tensor/testMatrixOps.ts`,供单元测试使用,避免 JS/Rust 两套矩阵公式
 * 同时成为运行真相.
 */
import type { Mat4 } from './rowMajorMatrix';

/** 矩阵运算后端,可由 WASM 实现,也可由测试 JS 实现. */
export interface MatrixWasmBackend {
    identity(): Mat4;
    translate(values: number[]): Mat4;
    scale(values: number[]): Mat4;
    rotate(values: number[]): Mat4;
    multiply(a: Mat4, b: Mat4): Mat4;
    apply(matrix: Mat4, point: number[]): number[];
}

/** 供编译/渲染层显式注入的矩阵运算接口,避免模块级可变全局状态. */
export interface MatrixOps {
    identity(): Mat4;
    translate(values: number[]): Mat4;
    scale(values: number[]): Mat4;
    rotate(values: number[]): Mat4;
    multiply(a: Mat4, b: Mat4): Mat4;
    apply(matrix: Mat4, point: number[]): number[];
}

/** 根据后端创建矩阵运算对象;生产路径必须显式传入后端. */
export function createMatrixOps(backend: MatrixWasmBackend): MatrixOps {
    return {
        identity: () => backend.identity(),
        translate: (values) => backend.translate(values),
        scale: (values) => backend.scale(values),
        rotate: (values) => backend.rotate(values),
        multiply: (a, b) => backend.multiply(a, b),
        apply: (matrix, point) => backend.apply(matrix, point),
    };
}
