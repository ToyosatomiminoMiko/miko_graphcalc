import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntersectionComputeInput } from '../../../math/adapters/IntersectionMath';

vi.mock('../../../math/compute/workers/IntersectionComputeClient', () => ({
    requestIntersection: vi.fn(),
}));

import { requestIntersection } from '../../../math/compute/workers/IntersectionComputeClient';
import { IntersectionRenderer } from './IntersectionRenderer';
import type { IntersectionTask, SceneObject, SphereObject } from '../../../compiler/ir/types';

function sphere(id: number, name: string, x: number): SphereObject {
    return {
        kind: 'sphere',
        id,
        name,
        expr: `[${x}, 0, 0]`,
        position: { x, y: 0, z: 0 },
        radius: 1,
        coefficients: [],
        color: '#ffffff',
        opacity: 1,
        segments: 16,
        enabled: true,
    };
}

function task(color: string): IntersectionTask {
    return {
        name: 'I',
        aName: 'a',
        bName: 'b',
        aId: 1,
        bId: 2,
        segments: 8,
        color,
        enabled: true,
    };
}

const RESPONSE = {
    points: Float64Array.from([0, 0, 0]),
    curvePoints: new Float64Array(0),
    curveOffsets: new Uint32Array(0),
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('IntersectionRenderer 输入指纹(RND-P3.8)', () => {
    beforeEach(() => {
        vi.mocked(requestIntersection).mockReset();
    });

    it('只改颜色不重新求交,但仍按新颜色重建可视对象', async () => {
        vi.mocked(requestIntersection).mockResolvedValue(RESPONSE);
        const renderer = new IntersectionRenderer();
        const objects: SceneObject[] = [sphere(1, 'a', -0.5), sphere(2, 'b', 0.5)];

        renderer.sync([task('#ff0000')], objects, {}, false);
        await tick();
        expect(vi.mocked(requestIntersection)).toHaveBeenCalledTimes(1);
        const firstVisual = renderer.group.children[0];
        const firstColor = (firstVisual.children[0] as unknown as {
            material: { color: { getHexString(): string } };
        }).material.color.getHexString();
        expect(firstColor).toBe('ff0000');

        // 只换色:指纹不变 -> 不发新请求,但可视对象按新颜色重建
        renderer.sync([task('#00ff00')], objects, {}, false);
        await tick();
        expect(vi.mocked(requestIntersection)).toHaveBeenCalledTimes(1);
        expect(renderer.group.children).toHaveLength(1);
        const recolored = (renderer.group.children[0].children[0] as unknown as {
            material: { color: { getHexString(): string } };
        }).material.color.getHexString();
        expect(recolored).toBe('00ff00');

        renderer.dispose();
    });

    it('几何输入变化时会重新求交', async () => {
        vi.mocked(requestIntersection).mockResolvedValue(RESPONSE);
        const renderer = new IntersectionRenderer();

        renderer.sync(
            [task('#ff0000')],
            [sphere(1, 'a', -0.5), sphere(2, 'b', 0.5)],
            {},
            false,
        );
        await tick();
        expect(vi.mocked(requestIntersection)).toHaveBeenCalledTimes(1);

        const moved = [sphere(1, 'a', -0.9), sphere(2, 'b', 0.9)];
        renderer.sync([task('#ff0000')], moved, {}, false);
        await tick();
        expect(vi.mocked(requestIntersection)).toHaveBeenCalledTimes(2);

        // 两次请求的输入确实不同(位置变了)
        const calls = vi.mocked(requestIntersection).mock.calls;
        expect(JSON.stringify(calls[0][0])).not.toBe(JSON.stringify(calls[1][0]));
        expect((calls[1][0] as IntersectionComputeInput).a).toBeDefined();

        renderer.dispose();
    });
});
