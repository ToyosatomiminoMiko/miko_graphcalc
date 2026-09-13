import { describe, expect, it } from 'vitest';
import { makeFn1D, makeFn2D } from './sampleLookup';
import type { IntegralResult } from '../../../math/compute/workers/IntegralCompute';

/** 单元采样结果:samples[i] = i,便于直接看出取到的是哪个单元. */
function cellResult(n: number, m: number = n): IntegralResult {
    return {
        value: 0,
        samples: Float64Array.from({ length: n * m }, (_, i) => i),
        sampleShape: '2d-corner',
        n,
        m,
    };
}

describe('makeFn2D 单元定位(RND-P2.1)', () => {
    it('查询点落在网格节点上时取到该单元,而不是左邻单元', () => {
        const n = 12;
        const fn = makeFn2D(-4, 4, -4, 4, cellResult(n));

        const wrong: Array<{ k: number; x: number; got: number; want: number }> = [];
        for (let k = 0; k < n; k++) {
            const x = -4 + (k * 8) / n;
            const got = fn(x, -4);
            if (got !== k) wrong.push({ k, x, got, want: k });
        }
        expect(wrong).toEqual([]);
    });

    it('range [-4,4] 的常见 segments 在节点查询下全部正确', () => {
        for (const n of [8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128]) {
            const fn = makeFn2D(-4, 4, -4, 4, cellResult(n));
            for (let k = 0; k < n; k++) {
                expect(fn(-4 + (k * 8) / n, -4)).toBe(k);
            }
        }
    });

    it('查询点取单元中心时同样正确', () => {
        const n = 12;
        const fn = makeFn2D(-4, 4, -4, 4, cellResult(n));
        for (let k = 0; k < n; k++) {
            expect(fn(-4 + ((k + 0.5) * 8) / n, -4)).toBe(k);
        }
    });

    it('y 方向节点同样被吸附到该行', () => {
        const n = 8;
        const fn = makeFn2D(-1, 1, -1, 1, cellResult(n));
        for (let j = 0; j < n; j++) {
            expect(fn(-1, -1 + (j * 2) / n)).toBe(j * n);
        }
    });

    it('越界查询被钳到边缘单元', () => {
        const n = 8;
        const fn = makeFn2D(-4, 4, -4, 4, cellResult(n));
        expect(fn(4, -4)).toBe(n - 1);
        expect(fn(4.0001, -4)).toBe(n - 1);
        expect(fn(-4.0001, -4)).toBe(0);
    });

    it('2d-grid 走四舍五入分支,节点查询正确', () => {
        const n = 4;
        const result: IntegralResult = {
            value: 0,
            samples: Float64Array.from({ length: (n + 1) * (n + 1) }, (_, i) => i),
            sampleShape: '2d-grid',
            n,
            m: n,
        };
        const fn = makeFn2D(-1, 1, -1, 1, result);
        expect(fn(-1, -1)).toBe(0);
        expect(fn(0, 0)).toBe(2 * 5 + 2);
        expect(fn(1, 1)).toBe(24);
    });

    it('n/m 为 0 或无样本时返回 NaN', () => {
        const fn = makeFn2D(-1, 1, -1, 1, { value: 0, n: 0, m: 0 });
        expect(fn(0, 0)).toBeNaN();
        const noSamples = makeFn2D(-1, 1, -1, 1, { value: 0, n: 4, m: 4 });
        expect(noSamples(0, 0)).toBeNaN();
    });
});

describe('makeFn1D', () => {
    it('1d-mid 按单元中点定位', () => {
        const fn = makeFn1D(0, 4, {
            value: 0,
            samples: Float64Array.from([10, 20, 30, 40]),
            sampleShape: '1d-mid',
        });
        expect(fn(0.5)).toBe(10);
        expect(fn(1.5)).toBe(20);
        expect(fn(3.5)).toBe(40);
        // 越界钳位
        expect(fn(4)).toBe(40);
        expect(fn(-1)).toBe(10);
    });

    it('1d-grid 按节点取样本', () => {
        const fn = makeFn1D(0, 4, {
            value: 0,
            samples: Float64Array.from([0, 1, 2, 3, 4]),
            sampleShape: '1d-grid',
        });
        expect(fn(0)).toBe(0);
        expect(fn(2)).toBe(2);
        expect(fn(4)).toBe(4);
    });

    it('无样本返回 NaN', () => {
        expect(makeFn1D(0, 1, { value: 0 })(0.5)).toBeNaN();
    });
});
