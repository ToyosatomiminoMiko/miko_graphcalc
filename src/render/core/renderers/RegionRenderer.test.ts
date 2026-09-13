import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { RegionRenderer } from './RegionRenderer';
import { sharedCurveSamplingEngine } from '../../../math/compute/MathComputeEngine';
import type { CurveSampleResult } from '../../../math/compute/workers/CurveComputeClient';
import type { CurveObject, RegionObject } from '../../../compiler/ir/types';

function boundary(id: number, name: string): CurveObject {
    return {
        kind: 'curve',
        id,
        name,
        expr: 'x',
        coefficients: [],
        color: '#ff0000',
        enabled: true,
    };
}

function region(): RegionObject {
    return {
        kind: 'region',
        id: 9,
        name: 'R',
        curveAName: 'a',
        curveBName: 'b',
        range: [-1, 1],
        coefficients: [],
        color: '#00ff00',
        opacity: 0.3,
        segments: 4,
        enabled: true,
    };
}

/** 5 个站点的均匀采样(步长 0.5 = 一档,不会被"整列缺失"判断断开). */
function sampled(offsets: number[] = [0, 5]): CurveSampleResult {
    return {
        points: Float32Array.from([
            -1, 0, 0, -0.5, 0.2, 0, 0, 0.3, 0, 0.5, 0.2, 0, 1, 0, 0,
        ]),
        offsets: Uint32Array.from(offsets),
    };
}

function createRenderer(): RegionRenderer {
    return new RegionRenderer(region(), boundary(1, 'a'), boundary(2, 'b'));
}

/** 收集 group 内所有材质(fill 的 mesh + 两条边界各段共用的 line 材质). */
function materialsOf(renderer: RegionRenderer): THREE.Material[] {
    const out: THREE.Material[] = [];
    renderer.group.traverse((node) => {
        const material = (node as THREE.Mesh).material;
        if (!material) return;
        if (Array.isArray(material)) out.push(...material);
        else out.push(material);
    });
    return out;
}

/** 给材质装一个只统计调用次数的 dispose 包装. */
function countDispose(material: THREE.Material): () => number {
    let count = 0;
    const original = material.dispose.bind(material);
    material.dispose = () => {
        count += 1;
        original();
    };
    return () => count;
}

async function drawOnce(renderer: RegionRenderer): Promise<void> {
    renderer.draw();
    await vi.waitFor(() => expect(renderer.group.children.length).toBe(3));
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('RegionRenderer 边界分段(RND-P3.7)', () => {
    it('采样 offsets 只有一段时,每条边界一条折线', async () => {
        vi.spyOn(sharedCurveSamplingEngine, 'sampleCurve').mockResolvedValue(sampled());
        const renderer = createRenderer();
        await drawOnce(renderer);

        const [fill, edgeA, edgeB] = renderer.group.children;
        expect((fill as THREE.Mesh).isMesh).toBe(true);
        expect(edgeA.children).toHaveLength(1);
        expect(edgeB.children).toHaveLength(1);

        renderer.dispose();
    });

    it('offsets 有多段时逐段建线,不画横跨空洞的伪连接线', async () => {
        // 3 + 2 两段
        vi.spyOn(sharedCurveSamplingEngine, 'sampleCurve')
            .mockResolvedValue(sampled([0, 3, 5]));
        const renderer = createRenderer();
        renderer.draw();
        await vi.waitFor(() => {
            expect(renderer.group.children[1]?.children.length).toBe(2);
        });

        const [, edgeA, edgeB] = renderer.group.children;
        expect(edgeA.children).toHaveLength(2);
        expect(edgeB.children).toHaveLength(2);
        // 每段顶点数与 offsets 对应
        expect((edgeA.children[0] as THREE.Line).geometry.attributes.position.count).toBe(3);
        expect((edgeA.children[1] as THREE.Line).geometry.attributes.position.count).toBe(2);

        renderer.dispose();
    });
});

describe('RegionRenderer 材质释放(RND-P2.5)', () => {
    it('重建填充面与边界线时释放上一轮材质', async () => {
        vi.spyOn(sharedCurveSamplingEngine, 'sampleCurve').mockResolvedValue(sampled());
        const renderer = createRenderer();
        await drawOnce(renderer);

        // 给第一轮的 fill + 两条边界材质装计数器
        const firstBatch = materialsOf(renderer);
        expect(firstBatch).toHaveLength(3);
        const disposeCounts = firstBatch.map(countDispose);

        await drawOnce(renderer);
        await drawOnce(renderer);

        // fill + 两条边界的材质都必须被释放(旧实现只释放 geometry)
        expect(disposeCounts.map((read) => read())).toEqual([1, 1, 1]);

        renderer.dispose();
    });

    it('dispose 释放最后一轮材质', async () => {
        vi.spyOn(sharedCurveSamplingEngine, 'sampleCurve').mockResolvedValue(sampled());
        const renderer = createRenderer();
        await drawOnce(renderer);

        const disposeCounts = materialsOf(renderer).map(countDispose);

        renderer.dispose();
        expect(disposeCounts.map((read) => read())).toEqual([1, 1, 1]);
    });
});
