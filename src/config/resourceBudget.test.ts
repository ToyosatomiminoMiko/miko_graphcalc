import { describe, expect, it } from 'vitest';
import {
    clampIntegral2DVisualization,
    clampLebesgue2DVisualization,
    formatMiB,
    integral2DSampleBytes,
    surfaceGeometryBytes,
    vectorFieldInstanceBytes,
} from './resourceBudget';

describe('resourceBudget', () => {
    it('separates 2D visualization resolution from numerical segments', () => {
        const visual = clampIntegral2DVisualization(300);

        expect(visual.segments).toBeLessThan(300);
        expect(visual.decimated).toBe(true);
    });

    it('caps Lebesgue 2D visualization by total bars, not only resolution', () => {
        const visual = clampLebesgue2DVisualization(1024, 128);
        const maxPossibleBars = (visual.res + 1) * (visual.res + 1) * visual.layers;

        expect(visual.decimated).toBe(true);
        expect(maxPossibleBars).toBeLessThanOrEqual(100_000);
    });

    it('keeps the byte estimators deterministic and positive', () => {
        expect(surfaceGeometryBytes(32)).toBeGreaterThan(0);
        expect(integral2DSampleBytes(32, 4)).toBeGreaterThan(0);
        expect(vectorFieldInstanceBytes(8 * 8 * 8)).toBeGreaterThan(0);
        expect(formatMiB(1048576)).toBe('1.0 MiB');
    });
});
