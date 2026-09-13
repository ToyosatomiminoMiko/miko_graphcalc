import { describe, expect, it } from 'vitest';
import {
    cloneMat4,
    flattenMat4,
    invertMat4,
    mat4FromFlat,
} from './rowMajorMatrix';
import { translate4 } from './testMatrixOps';

describe('rowMajorMatrix', () => {
    it('round-trips between nested and flat row-major layouts', () => {
        const matrix = translate4([2, -3, 5]);
        expect(mat4FromFlat(flattenMat4(matrix))).toEqual(matrix);
    });

    it('rejects flat arrays whose length is not 16', () => {
        expect(mat4FromFlat([1, 2, 3])).toBeNull();
    });

    it('inverts a translation so applying both keeps the point', () => {
        const matrix = translate4([1, 2, 3]);
        const inverse = invertMat4(matrix)!;
        expect(inverse).not.toBeNull();

        const point = [4, 5, 6];
        const moved = matrix.map((row) =>
            row[0] * point[0] + row[1] * point[1] + row[2] * point[2] + row[3]
        );
        const restored = inverse.map((row) =>
            row[0] * moved[0] + row[1] * moved[1] + row[2] * moved[2] + row[3]
        );
        expect(restored[0]).toBeCloseTo(point[0], 10);
        expect(restored[1]).toBeCloseTo(point[1], 10);
        expect(restored[2]).toBeCloseTo(point[2], 10);
    });

    it('clone does not share rows with the source', () => {
        const matrix = translate4([1, 0, 0]);
        const clone = cloneMat4(matrix);
        clone[0][3] = 99;
        expect(matrix[0][3]).toBe(1);
    });
});
