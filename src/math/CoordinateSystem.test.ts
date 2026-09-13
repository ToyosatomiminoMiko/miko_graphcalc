import { describe, expect, it } from 'vitest';
import { CoordinateSystem } from './CoordinateSystem';

const PI = Math.PI;

describe('CoordinateSystem 笛卡尔', () => {
    it('三维是恒等换算', () => {
        const system = CoordinateSystem.cartesian(3);
        expect(system.toCartesian([1, 2, 3])).toEqual([1, 2, 3]);
        expect(system.fromCartesian([1, 2, 3])).toEqual([1, 2, 3]);
        expect(system.kind).toBe('cartesian');
        expect(system.isPolar).toBe(false);
    });

    it('二维把第三分量钉在 0', () => {
        const system = CoordinateSystem.cartesian(2);
        expect(system.toCartesian([4, 5, 6])).toEqual([4, 5, 0]);
        expect(system.fromCartesian([4, 5, 6])).toEqual([4, 5, 0]);
    });

    it('值不足三位时按 0 补', () => {
        expect(CoordinateSystem.cartesian(3).toCartesian([1, 2])).toEqual([1, 2, 0]);
    });
});

describe('CoordinateSystem 球坐标(三维)', () => {
    it('physics 约定:θ 从 +Z 量起,φ 是 xy 平面方位角', () => {
        const system = CoordinateSystem.spherical(3, 'physics');
        const plusX = system.toCartesian([2, PI / 2, 0]);
        expect(plusX[0]).toBeCloseTo(2, 12);
        expect(plusX[1]).toBeCloseTo(0, 12);
        expect(plusX[2]).toBeCloseTo(0, 12);

        const plusY = system.toCartesian([2, PI / 2, PI / 2]);
        expect(plusY[0]).toBeCloseTo(0, 12);
        expect(plusY[1]).toBeCloseTo(2, 12);
        expect(plusY[2]).toBeCloseTo(0, 12);

        // θ = 0 是 +Z 极点,方位角此时不改变结果.
        const north = system.toCartesian([2, 0, PI / 2]);
        expect(north[0]).toBeCloseTo(0, 12);
        expect(north[1]).toBeCloseTo(0, 12);
        expect(north[2]).toBeCloseTo(2, 12);
    });

    it('math 约定:θ/φ 与 physics 互换', () => {
        const system = CoordinateSystem.spherical(3, 'math');
        const plusX = system.toCartesian([2, 0, PI / 2]);
        expect(plusX[0]).toBeCloseTo(2, 12);
        expect(plusX[1]).toBeCloseTo(0, 12);
        expect(plusX[2]).toBeCloseTo(0, 12);

        // 同一个三元组在两种约定下是不同方向(方位角放到了 φ).
        const swapped = system.toCartesian([2, PI / 2, 0]);
        expect(swapped[0]).toBeCloseTo(0, 12);
        expect(swapped[1]).toBeCloseTo(0, 12);
        expect(swapped[2]).toBeCloseTo(2, 12);
    });

    it('fromCartesian 用量词正确的反三角', () => {
        const physics = CoordinateSystem.spherical(3, 'physics');
        const plusX = physics.fromCartesian([2, 0, 0]);
        expect(plusX[0]).toBeCloseTo(2, 12);
        expect(plusX[1]).toBeCloseTo(PI / 2, 12);
        expect(plusX[2]).toBeCloseTo(0, 12);

        // 负 y 必须落在第四象限(atan2 而不是 atan).
        const minusY = physics.fromCartesian([0, -3, 0]);
        expect(minusY[1]).toBeCloseTo(PI / 2, 12);
        expect(minusY[2]).toBeCloseTo(-PI / 2, 12);

        const math = CoordinateSystem.spherical(3, 'math');
        const mathPlusY = math.fromCartesian([0, 1, 0]);
        expect(mathPlusY[1]).toBeCloseTo(PI / 2, 12);
        expect(mathPlusY[2]).toBeCloseTo(PI / 2, 12);
    });

    it('原点处角度未定义,返回全 0 而不是 NaN', () => {
        for (const convention of ['physics', 'math'] as const) {
            expect(
                CoordinateSystem.spherical(3, convention).fromCartesian([0, 0, 0]),
            ).toEqual([0, 0, 0]);
        }
    });
});

describe('CoordinateSystem 二维球坐标 = 极坐标', () => {
    it('被识别为极坐标,θ 是 xy 平面方位角', () => {
        const polar = CoordinateSystem.spherical(2);
        expect(polar.isPolar).toBe(true);

        const plusX = polar.toCartesian([2, 0]);
        expect(plusX[0]).toBeCloseTo(2, 12);
        expect(plusX[1]).toBeCloseTo(0, 12);
        expect(plusX[2]).toBe(0);

        const plusY = polar.toCartesian([2, PI / 2]);
        expect(plusY[0]).toBeCloseTo(0, 12);
        expect(plusY[1]).toBeCloseTo(2, 12);
        expect(plusY[2]).toBe(0);
    });

    it('fromCartesian 只取 xy 分量,第三位恒为 0', () => {
        const polar = CoordinateSystem.spherical(2);
        const result = polar.fromCartesian([3, 4, 99]);
        expect(result[0]).toBeCloseTo(5, 12);
        expect(result[1]).toBeCloseTo(Math.atan2(4, 3), 12);
        expect(result[2]).toBe(0);
        expect(polar.fromCartesian([0, 0, 7])).toEqual([0, 0, 0]);
    });
});

describe('CoordinateSystem 坐标系之间换算', () => {
    it('经笛卡尔中转,两跳完成', () => {
        const cartesian = CoordinateSystem.cartesian(3);
        const sphere = CoordinateSystem.spherical(3, 'physics');

        const spherical = cartesian.convertTo(sphere, [0, 2, 0]);
        expect(spherical[0]).toBeCloseTo(2, 12);
        expect(spherical[1]).toBeCloseTo(PI / 2, 12);
        expect(spherical[2]).toBeCloseTo(PI / 2, 12);

        const back = sphere.convertTo(cartesian, spherical);
        expect(back[0]).toBeCloseTo(0, 12);
        expect(back[1]).toBeCloseTo(2, 12);
        expect(back[2]).toBeCloseTo(0, 12);
    });

    it('两种球坐标约定之间可以直接互换', () => {
        const physics = CoordinateSystem.spherical(3, 'physics');
        const math = CoordinateSystem.spherical(3, 'math');
        // physics 的 (r, θ, φ) 换成 math 就是 θ/φ 对调.
        const converted = physics.convertTo(math, [1.7, 0.9, -2.1]);
        expect(converted[0]).toBeCloseTo(1.7, 10);
        expect(converted[1]).toBeCloseTo(-2.1, 10);
        expect(converted[2]).toBeCloseTo(0.9, 10);
    });

    it('往返(球 -> 笛卡尔 -> 球)在各自值域内成立', () => {
        const inputs = {
            physics: { r: 1.7, theta: 0.9, phi: -2.1 },
            math: { r: 1.7, theta: -2.1, phi: 0.9 },
        } as const;
        for (const convention of ['physics', 'math'] as const) {
            const system = CoordinateSystem.spherical(3, convention);
            const { r, theta, phi } = inputs[convention];
            const cartesian = system.toCartesian([r, theta, phi]);
            const back = system.fromCartesian(cartesian);
            expect(back[0]).toBeCloseTo(r, 10);
            expect(back[1]).toBeCloseTo(theta, 10);
            expect(back[2]).toBeCloseTo(phi, 10);
        }
    });
});
