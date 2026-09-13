import { describe, expect, it } from 'vitest';
import {
    positiveStepPositions,
    resolveGridSteps,
    stepCount,
} from './axisSteps';
import { RENDER_CONFIG } from '../../config/renderConfig';
import { formatTickLabel } from './tickLabel';

const grid = RENDER_CONFIG.scene.grid;
const AXIS_LENGTH = RENDER_CONFIG.scene.axesLength;

describe('resolveGridSteps', () => {
    it('普通模式沿用整数步长', () => {
        expect(resolveGridSteps(grid, false)).toEqual({
            minorStep: grid.minorStep,
            majorEvery: Math.round(grid.majorStep / grid.minorStep),
        });
    });

    it('π 单位模式:小刻度 π/2,每两个小刻度一个大刻度(即 π 的整数倍)', () => {
        const steps = resolveGridSteps(grid, true);
        expect(steps.minorStep).toBeCloseTo(Math.PI / 2, 12);
        expect(steps.majorEvery).toBe(2);
    });
});

describe('positiveStepPositions', () => {
    it('普通模式给出 1..10 的整数刻度', () => {
        expect(positiveStepPositions(1, AXIS_LENGTH)).toEqual([
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
        ]);
    });

    it('π 单位模式的刻度落在 π/2 的整数倍上,大刻度正好是 π 的整数倍', () => {
        const { minorStep, majorEvery } = resolveGridSteps(grid, true);
        const positions = positiveStepPositions(minorStep, AXIS_LENGTH);

        // 序列本身:π/2,π,3π/2 ...(不超过轴长 10,末尾 3π ≈ 9.42)
        expect(positions).toHaveLength(stepCount(minorStep, AXIS_LENGTH));
        positions.forEach((position, index) => {
            expect(position).toBeCloseTo(((index + 1) * Math.PI) / 2, 12);
        });

        // 大刻度(索引能被 majorEvery 整除)必须正好落在 π 的整数倍上
        const majorPositions = positions.filter((_, index) => (index + 1) % majorEvery === 0);
        expect(majorPositions.length).toBeGreaterThan(0);
        majorPositions.forEach((position) => {
            const multiple = position / Math.PI;
            expect(Math.abs(multiple - Math.round(multiple))).toBeLessThan(1e-9);
        });
    });
});

describe('π 单位刻度标签', () => {
    it('刻度值与标签一一对应(π/2,π,3π/2 ...)', () => {
        const { minorStep } = resolveGridSteps(grid, true);
        const labels = positiveStepPositions(minorStep, AXIS_LENGTH)
            .map((position) => formatTickLabel(position, true));

        expect(labels).toEqual(['π/2', 'π', '3π/2', '2π', '5π/2', '3π']);
    });

    it('普通模式的标签仍是整数', () => {
        const { minorStep } = resolveGridSteps(grid, false);
        const labels = positiveStepPositions(minorStep, AXIS_LENGTH)
            .map((position) => formatTickLabel(position, false));

        expect(labels).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    });
});
