/**
 * `MatrixOps` 契约与 TS<->WASM 边界.
 *
 * 公式本身的真值在 Rust `math_rs::transform_core`(单测见 `transform_core.rs`),
 * 这里只守两件 Rust 侧测不到的事:
 * 1. 生产后端对象与 `MatrixOps` 接口同名同形,后端实现本身就是契约;
 * 2. 行主序 `Mat4` <-> WASM 扁平 `Float64Array` 的往返转换不改变语义.
 */
import { describe, expect, it } from 'vitest';
import type { MatrixOps } from './MatrixOps';
import { testMatrixOps } from '../../testing/matrixOps';

// 曾经的 createMatrixOps 只是 `(args) => backend.method(args)` 的零逻辑包装,
// 已删除:实现对象本身就是 MatrixOps,这行类型标注守住这个契约形状.
const ops: MatrixOps = testMatrixOps;

const TRANSLATION = [
    [1, 0, 0, 2],
    [0, 1, 0, 3],
    [0, 0, 1, 4],
    [0, 0, 0, 1],
];

describe('MatrixOps(WASM 后端)', () => {
    it('keeps translation in the fourth column of a row-major matrix', () => {
        expect(ops.translate([2, 3, 4])).toEqual(TRANSLATION);
    });

    it('applies a translation to a point as a homogeneous vector', () => {
        expect(ops.apply(ops.translate([1, -2, 3]), [4, 5, 6])).toEqual([5, 3, 9]);
    });

    it('multiplies matrices in the documented a * b order', () => {
        // a * b 表示"先 b 后 a":先平移 (1,0,0) 再放大 2 倍,(1,1,1) -> (4,2,2).
        const translatedThenScaled = ops.multiply(
            ops.scale([2, 2, 2]),
            ops.translate([1, 0, 0]),
        );

        expect(ops.apply(translatedThenScaled, [1, 1, 1])).toEqual([4, 2, 2]);
    });

    it('round-trips matrices through the flat WASM boundary unchanged', () => {
        expect(ops.multiply(ops.identity(), TRANSLATION)).toEqual(TRANSLATION);
        expect(ops.apply(ops.identity(), [1, 2, 3])).toEqual([1, 2, 3]);
    });

    it('returns a 4x4 rotation matrix', () => {
        const matrix = ops.rotate([0, 0, Math.PI / 2]);

        expect(matrix).toHaveLength(4);
        expect(matrix.every((row) => row.length === 4)).toBe(true);
        expect(matrix[3]).toEqual([0, 0, 0, 1]);
    });
});
