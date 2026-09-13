import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { IntegralVisualizer } from './IntegralVisualizer';
import type { CurveObject } from '../../../compiler/ir/types';

function curve(): CurveObject {
    return {
        kind: 'curve',
        id: 1,
        name: 'c',
        expr: 'x',
        coefficients: [],
        color: '#ffffff',
        enabled: true,
    };
}

describe('IntegralVisualizer._register 防御(RND-P3.13)', () => {
    it('同一缓存键被再次登记时释放旧 group,不留下孤儿', () => {
        const visualizer = new IntegralVisualizer(new THREE.Scene());
        const object = curve();
        const triangles = 4;

        visualizer.visualize2DRiemann(object, () => 1, 0, 1, triangles, 'K');
        expect(visualizer.group.children).toHaveLength(1);
        const first = visualizer.group.children[0] as THREE.Group;

        // 记录旧 group 内材质的释放次数(柱条几何是模块级共享几何,
        // disposeObjectGroup 有意不释放它,所以只断言材质).
        let materialDisposals = 0;
        first.traverse((node) => {
            const mesh = node as THREE.Mesh;
            const material = mesh.material;
            const list = Array.isArray(material) ? material : [material];
            list.forEach((entry) => entry?.addEventListener('dispose', () => {
                materialDisposals += 1;
            }));
        });

        visualizer.visualize2DRiemann(object, () => 1, 0, 1, triangles, 'K');

        // 场景里只剩新 group,旧 group 既被摘除也被释放
        expect(visualizer.group.children).toHaveLength(1);
        expect(visualizer.group.children[0]).not.toBe(first);
        expect(visualizer.cache.size).toBe(1);
        expect(materialDisposals).toBeGreaterThan(0);

        visualizer.dispose();
    });

    it('不同键各自保留', () => {
        const visualizer = new IntegralVisualizer(new THREE.Scene());
        const object = curve();
        visualizer.visualize2DRiemann(object, () => 1, 0, 1, 4, 'A');
        visualizer.visualize2DRiemann(object, () => 1, 0, 1, 4, 'B');
        expect(visualizer.group.children).toHaveLength(2);
        expect(visualizer.cache.size).toBe(2);
        visualizer.dispose();
    });
});

describe('IntegralVisualizer.clear/dispose', () => {
    it('dispose 后场景与缓存都清空', () => {
        const scene = new THREE.Scene();
        const visualizer = new IntegralVisualizer(scene);
        const disposeSpy = vi.spyOn(visualizer.group, 'remove');
        visualizer.visualize2DRiemann(curve(), () => 1, 0, 1, 4, 'A');

        visualizer.dispose();

        expect(visualizer.group.children).toHaveLength(0);
        expect(visualizer.cache.size).toBe(0);
        expect(scene.children).not.toContain(visualizer.group);
        disposeSpy.mockRestore();
    });
});
