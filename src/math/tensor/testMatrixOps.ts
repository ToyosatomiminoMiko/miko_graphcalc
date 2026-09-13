/**
 * 纯 JS 矩阵参考实现,仅供单元测试和离线工具使用.
 *
 * 运行时的唯一真值是 Rust `math_rs::transform_core`(通过 WASM 注入);
 * 本文件不再被 DslCompiler/AnimationPlayer 作为默认后端引用.
 */
import { assertMat4, type Mat4 } from './rowMajorMatrix';
import type { MatrixOps } from './SceneTransform';

/** 单位 4x4 矩阵. */
export function identity4(): Mat4 {
    return [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
    ];
}

/** 平移矩阵. */
export function translate4(values: number[]): Mat4 {
    return [
        [1, 0, 0, values[0] ?? 0],
        [0, 1, 0, values[1] ?? 0],
        [0, 0, 1, values[2] ?? 0],
        [0, 0, 0, 1],
    ];
}

/** 缩放矩阵. */
export function scale4(values: number[]): Mat4 {
    return [
        [values[0] ?? 1, 0, 0, 0],
        [0, values[1] ?? 1, 0, 0],
        [0, 0, values[2] ?? 1, 0],
        [0, 0, 0, 1],
    ];
}

/** 旋转矩阵,顺序与 Rust 实现一致: Rz * Ry * Rx. */
export function rotate4(values: number[]): Mat4 {
    const rx = values[0] ?? 0;
    const ry = values[1] ?? 0;
    const rz = values[2] ?? 0;
    const cx = Math.cos(rx);
    const sx = Math.sin(rx);
    const cy = Math.cos(ry);
    const sy = Math.sin(ry);
    const cz = Math.cos(rz);
    const sz = Math.sin(rz);

    const rxM: Mat4 = [
        [1, 0, 0, 0],
        [0, cx, -sx, 0],
        [0, sx, cx, 0],
        [0, 0, 0, 1],
    ];
    const ryM: Mat4 = [
        [cy, 0, sy, 0],
        [0, 1, 0, 0],
        [-sy, 0, cy, 0],
        [0, 0, 0, 1],
    ];
    const rzM: Mat4 = [
        [cz, -sz, 0, 0],
        [sz, cz, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
    ];

    return multiply4x4(multiply4x4(rzM, ryM), rxM);
}

/** 两个 4x4 矩阵相乘,结果仍为行主序 4x4. */
export function multiply4x4(a: Mat4, b: Mat4): Mat4 {
    assertMat4(a);
    assertMat4(b);

    const out: Mat4 = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    for (let i = 0; i < 4; i += 1) {
        for (let j = 0; j < 4; j += 1) {
            let sum = 0;
            for (let k = 0; k < 4; k += 1) {
                sum += a[i][k] * b[k][j];
            }
            out[i][j] = sum;
        }
    }
    return out;
}

function applyMatrix(matrix: Mat4, point: number[]): number[] {
    assertMat4(matrix);
    if (point.length !== 3) {
        throw new TypeError('apply(matrix, point) 需要 3 分量向量');
    }

    const v = [point[0], point[1], point[2], 1];
    const out = [0, 0, 0, 0];
    for (let i = 0; i < 4; i += 1) {
        out[i] =
            matrix[i][0] * v[0] +
            matrix[i][1] * v[1] +
            matrix[i][2] * v[2] +
            matrix[i][3] * v[3];
    }
    return [out[0], out[1], out[2]];
}

/** 测试用矩阵后端. */
export const jsMatrixOps: MatrixOps = {
    identity: () => identity4(),
    translate: (values) => translate4(values),
    scale: (values) => scale4(values),
    rotate: (values) => rotate4(values),
    multiply: (a, b) => multiply4x4(a, b),
    apply: (matrix, point) => applyMatrix(matrix, point),
};
