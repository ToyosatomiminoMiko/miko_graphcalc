import { describe, expect, it } from 'vitest';
import {
    cloneMat4,
    flattenMat4,
    invertMat4,
    mat4FromFlat,
} from './rowMajorMatrix';
import { translate4 } from './testBackend';

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

describe('invertMat4 奇异判据用相对尺度(202609 审查 P1-7)', () => {
    const diag = (values: number[]): number[][] => [
        [values[0], 0, 0, 0],
        [0, values[1], 0, 0],
        [0, 0, values[2], 0],
        [0, 0, 0, values[3]],
    ];

    it('整体缩小的合法变换不再被误判为奇异', () => {
        // 旧实现用绝对阈值 1e-12:diag(1e-13,1,1,1) 可逆却被拒,
        // 连带让求交静默跳过,体积积分误报"矩阵不可逆".
        for (const scale of [1e-13, 1e-9, 1e-30, 1e30]) {
            const inverse = invertMat4(diag([scale, 1, 1, 1]));
            expect(inverse, `scale=${scale} 应可逆`).not.toBeNull();
            // 首元素倒数是 1/scale,量级巨大但有限.
            expect(inverse![0][0]).toBeCloseTo(1 / scale, 0);
        }
    });

    it('真心奇异的矩阵仍然返回 null', () => {
        expect(invertMat4([[1, 2, 3, 4], [2, 4, 6, 8], [1, 0, 0, 0], [0, 0, 0, 1]])).toBeNull();
        expect(invertMat4(diag([1, 0, 1, 1]))).toBeNull();
    });
});
