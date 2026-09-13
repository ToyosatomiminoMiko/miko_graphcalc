/**
 * TS/IR 层的行主序 4x4 矩阵表示与基础工具.
 *
 * 项目里存在三种“矩阵”形态,本文件只负责其中一种:
 * 1. TS/IR 内部:嵌套 `number[][]`,行主序 —— 本文件的 `Mat4`;
 * 2. WASM 边界:扁平 16 个数值 —— 见 `flattenMat4`/`mat4FromFlat`;
 * 3. Three.js:`THREE.Matrix4`,列主序 —— 只在渲染边界转换,不进本文件.
 *
 * Rust `math_rs::transform_core::Mat4` 是扁平 `[f64; 16]`,与 WASM 边界一致,
 * 同样不是本文件类型.
 *
 * 矩阵“运算”由运行时注入的 WASM 后端提供;纯 JS 参考实现只在测试目录
 * (`testMatrixOps.ts`)出现.这里只放表示层共用的基础操作(克隆/校验/求逆/
 * 扁平转换),避免每个调用方各自定义一套 `type Mat4 = number[][]`.
 */

export type Mat4 = number[][];

/** 校验嵌套数组确实是 4x4 矩阵. */
export function assertMat4(matrix: number[][]): void {
    if (matrix.length !== 4 || matrix.some((row) => row.length !== 4)) {
        throw new TypeError('rowMajorMatrix 需要 4x4 行主序矩阵');
    }
}

/** 深拷贝一个行主序矩阵. */
export function cloneMat4(matrix: Mat4): Mat4 {
    return matrix.map((row) => [...row]);
}

/** 把行主序矩阵压平成 WASM/Worker 边界的 16 元素数组. */
export function flattenMat4(matrix: Mat4): number[] {
    assertMat4(matrix);
    return matrix.flat();
}

/** 可空矩阵的扁平化:null 表示“没有静态 transform”,对应空数组. */
export function flattenOptionalMat4(matrix: Mat4 | null): number[] {
    return matrix ? flattenMat4(matrix) : [];
}

/**
 * 把扁平 16 元素还原成行主序嵌套矩阵.
 *
 * 长度错误或含非有限值返回 null;调用方(如 DSL 矩阵解析)按自身语义报错.
 */
export function mat4FromFlat(values: readonly number[]): Mat4 | null {
    if (
        values.length !== 16
        || values.some((value) => !Number.isFinite(value))
    ) {
        return null;
    }
    return [
        [...values.slice(0, 4)],
        [...values.slice(4, 8)],
        [...values.slice(8, 12)],
        [...values.slice(12, 16)],
    ];
}

/** 4x4 行主序矩阵求逆;不可逆时返回 null. */
export function invertMat4(m: Mat4): Mat4 | null {
    assertMat4(m);
    const a = m.map((row) => [...row]);
    const inv: Mat4 = [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
    ];

    for (let col = 0; col < 4; col += 1) {
        let pivot = col;
        for (let row = col + 1; row < 4; row += 1) {
            if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) {
                pivot = row;
            }
        }
        if (Math.abs(a[pivot][col]) < 1e-12) return null;
        if (pivot !== col) {
            [a[pivot], a[col]] = [a[col], a[pivot]];
            [inv[pivot], inv[col]] = [inv[col], inv[pivot]];
        }

        const scale = a[col][col];
        for (let k = 0; k < 4; k += 1) {
            a[col][k] /= scale;
            inv[col][k] /= scale;
        }
        for (let row = 0; row < 4; row += 1) {
            if (row === col) continue;
            const factor = a[row][col];
            if (factor === 0) continue;
            for (let k = 0; k < 4; k += 1) {
                a[row][k] -= factor * a[col][k];
                inv[row][k] -= factor * inv[col][k];
            }
        }
    }
    return inv;
}
