import { describe, expect, it } from 'vitest';
import type { MatrixOps } from './MatrixOps';
import {
    identity4,
    jsMatrixOps,
    multiply4x4,
    rotate4,
    scale4,
    translate4,
} from './testBackend';

describe('MatrixOps', () => {
    it('keeps translation in the fourth column of a row-major matrix', () => {
        expect(translate4([2, 3, 4])).toEqual([
            [1, 0, 0, 2],
            [0, 1, 0, 3],
            [0, 0, 1, 4],
            [0, 0, 0, 1],
        ]);
    });

    it('applies a translation to a point as a homogeneous vector', () => {
        expect(jsMatrixOps.apply(translate4([1, -2, 3]), [4, 5, 6]))
            .toEqual([5, 3, 9]);
    });

    it('multiplies matrices in the documented a * b order', () => {
        const translatedThenScaled = multiply4x4(
            scale4([2, 2, 2]),
            translate4([1, 0, 0]),
        );
        expect(jsMatrixOps.apply(translatedThenScaled, [1, 1, 1]))
            .toEqual([4, 2, 2]);
    });

    it('multiplies 4x4 matrices in row-major order', () => {
        expect(multiply4x4(identity4(), translate4([1, 2, 3])))
            .toEqual(translate4([1, 2, 3]));
    });

    it('returns a 4x4 rotation matrix', () => {
        const matrix = rotate4([0, 0, Math.PI / 2]);
        expect(matrix).toHaveLength(4);
        expect(matrix.every((row) => row.length === 4)).toBe(true);
        expect(matrix[3]).toEqual([0, 0, 0, 1]);
    });

    it('exposes the injected ops as the plain MatrixOps contract', () => {
        // 曾经的 createMatrixOps 只是 `(args) => backend.method(args)` 的零逻辑
        // 包装,已删除:实现对象本身就是 MatrixOps,这里守住这个契约形状.
        const ops: MatrixOps = jsMatrixOps;

        expect(ops.translate([9, 8, 7])).toEqual(translate4([9, 8, 7]));
        expect(ops.apply(identity4(), [1, 2, 3])).toEqual([1, 2, 3]);
    });
});
