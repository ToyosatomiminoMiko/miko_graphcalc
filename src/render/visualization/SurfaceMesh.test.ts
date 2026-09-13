import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
// 版本锚定:这两个是 three 未在 package.json `exports` 暴露的内部路径,
// 只为复现 WebGLGeometries.getWireframeAttribute 的缓存失效规则而导入.
// three 升级时若路径/构造签名变化,需要同步更新本文件(见 RND-P3.12).
import { WebGLAttributes } from 'three/src/renderers/webgl/WebGLAttributes.js';
import { WebGLGeometries } from 'three/src/renderers/webgl/WebGLGeometries.js';

/**
 * 曲面采样走真实 Worker/WASM,这里只关心"结果回到主线程后 BufferGeometry
 * 是否让线框失效 / 索引对象是否稳定 / 包围体是否重算",因此把共享 client
 * 换成假实现.
 */
vi.mock('../../math/compute/workers/SurfaceComputeClient', () => ({
    surfaceComputeClient: {
        request: vi.fn(),
        dispose: vi.fn(),
    },
}));

import { surfaceComputeClient } from '../../math/compute/workers/SurfaceComputeClient';
import { SurfaceMesh } from './SurfaceMesh';
import type { SurfaceWorkerResponse } from '../../math/compute/workers/SurfaceWorker';

const COLS = 2;
const ROWS = 2;
const MAX_INDEX_COUNT = COLS * ROWS * 6;
const TRIANGLES = 8;
/** 每次 update 用的采样范围(值本身不影响本测试) */
const RANGE: [number, number, number, number] = [-1, 1, -1, 1];

/** 把顶点摆在 x ∈ [offset, offset + 2],用于验证包围球按真实顶点重算. */
function makeResponse(triangleCount = TRIANGLES, offset = 0): SurfaceWorkerResponse {
    const vertexCount = (COLS + 1) * (ROWS + 1);
    const positions = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
        positions[i * 3] = offset + (i % (COLS + 1));
        positions[i * 3 + 1] = 0;
        positions[i * 3 + 2] = i * 0.5;
    }
    const normals = new Float32Array(vertexCount * 3);
    // 2x2 网格 -> 最多 4 个单元 -> 8 个三角形
    const all = [
        0, 1, 4, 0, 4, 3,
        1, 2, 5, 1, 5, 4,
        3, 4, 7, 3, 7, 6,
        4, 5, 8, 4, 8, 7,
    ];
    return {
        id: 1,
        positions,
        normals,
        validIndices: new Uint32Array(all.slice(0, triangleCount * 3)),
        zMin: 0,
        zMax: 4,
        computeMs: 0,
    };
}

/**
 * 真实的 three.js 线框索引缓存.`getWireframeAttribute` 这条路径不触碰 GL,
 * 所以传最小桩即可复现渲染器每帧的取值行为.
 *
 * three.js 只在 `缓存 version < geometry.index.version` 时重建线框索引
 * (WebGLGeometries.getWireframeAttribute),这正是本文件要守住的不变量.
 */
function createWireframeCache() {
    const gl = {} as unknown as WebGLRenderingContext;
    const attributes = new WebGLAttributes(gl);
    // @types/three 的构造签名是 3 参(运行时另有第 4 参 bindingStates,本测试用不到)
    return new WebGLGeometries(gl, attributes, { memory: { geometries: 0 } } as never);
}

/** three 的线框展开:每个三角形 (a,b,c) -> (a,b, b,c, c,a). */
function expectedWireframe(indices: Uint32Array, count: number): number[] {
    const out: number[] = [];
    for (let i = 0; i + 2 < count; i += 3) {
        const a = indices[i];
        const b = indices[i + 1];
        const c = indices[i + 2];
        out.push(a, b, b, c, c, a);
    }
    return out;
}

function createMesh() {
    // 首帧:采样结果还没回来,几何体用预分配的全 0 索引 + drawRange(0,0);
    // three.js 会在这一帧为 wireframe 材质缓存一份基于占位索引的线框索引.
    const mesh = new SurfaceMesh(COLS, ROWS, '测试曲面', '#ffffff');
    const wireframeCache = createWireframeCache();
    expect(mesh.geometry.index?.count).toBe(MAX_INDEX_COUNT);
    expect(mesh.geometry.drawRange.count).toBe(0);
    return { mesh, wireframeCache };
}

async function runOnce(mesh: SurfaceMesh, expectedIndexCount: number): Promise<void> {
    mesh.update('x+y', [], RANGE[0], RANGE[1], RANGE[2], RANGE[3]);
    await vi.waitFor(() => {
        expect(mesh.geometry.drawRange.count).toBe(expectedIndexCount);
    });
}

describe('SurfaceMesh 线框网格与索引缓冲', () => {
    beforeEach(() => {
        vi.mocked(surfaceComputeClient.request).mockReset();
    });

    it('首次采样结果到达后线框缓存即失效,无需再运行一次', async () => {
        const response = makeResponse();
        vi.mocked(surfaceComputeClient.request).mockResolvedValue(response);

        const { mesh, wireframeCache } = createMesh();

        await runOnce(mesh, response.validIndices.length);

        // 关键断言:首帧那份占位线框缓存必须被判为过期并重建,
        // 否则线框会一直绑在占位索引上,表现为"首次运行看不到网格,
        // 必须再点一次运行才有网格".
        const index = mesh.geometry.index as THREE.BufferAttribute;
        expect(index.version).toBeGreaterThan(0);
        const wireframe = wireframeCache.getWireframeAttribute(mesh.geometry);
        expect(wireframe.version).toBe(index.version);
        // drawRange 之外的三角形不参与绘制,但前 validIndices.length / 3 个
        // 三角形的线框必须与有效索引一致.
        expect(Array.from(wireframe.array).slice(0, response.validIndices.length * 2))
            .toEqual(expectedWireframe(response.validIndices, response.validIndices.length));

        mesh.dispose();
    });

    it('索引长度变化时只改 drawRange,索引属性对象保持恒等(不泄漏 element buffer)', async () => {
        const full = makeResponse();
        const partial = makeResponse(2);
        vi.mocked(surfaceComputeClient.request)
            .mockResolvedValueOnce(full)
            .mockResolvedValueOnce(partial);

        const { mesh, wireframeCache } = createMesh();
        const indexBefore = mesh.geometry.index;

        await runOnce(mesh, full.validIndices.length);
        const versionAfterFull = (mesh.geometry.index as THREE.BufferAttribute).version;
        expect(wireframeCache.getWireframeAttribute(mesh.geometry).version)
            .toBe(versionAfterFull);

        await runOnce(mesh, partial.validIndices.length);
        const indexAfter = mesh.geometry.index as THREE.BufferAttribute;

        // 索引对象恒定:替换属性会让旧 element buffer 永久泄漏(见 RND-P1.2)
        expect(indexAfter).toBe(indexBefore);
        // 长度变化由 drawRange 表达
        expect(mesh.geometry.drawRange).toMatchObject({
            start: 0,
            count: partial.validIndices.length,
        });
        // 线框缓存随之失效并重建
        expect(indexAfter.version).toBeGreaterThan(versionAfterFull);
        expect(wireframeCache.getWireframeAttribute(mesh.geometry).version)
            .toBe(indexAfter.version);
        expect(Array.from(wireframeCache.getWireframeAttribute(mesh.geometry).array)
            .slice(0, partial.validIndices.length * 2))
            .toEqual(expectedWireframe(partial.validIndices, partial.validIndices.length));

        mesh.dispose();
    });

    it('采样结果写入后包围球按真实顶点重算(不冻结在半径 0)', async () => {
        // 首帧先用全 0 顶点把包围球惰性算出来(半径 0)
        const mesh = new SurfaceMesh(COLS, ROWS, '测试曲面', '#ffffff');
        const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
        camera.position.set(5, 0, 10);
        camera.lookAt(5, 0, 0);
        camera.updateMatrixWorld();
        const frustum = new THREE.Frustum().setFromProjectionMatrix(
            new THREE.Matrix4().multiplyMatrices(
                camera.projectionMatrix, camera.matrixWorldInverse),
        );
        mesh.mesh.updateMatrixWorld();
        expect(frustum.intersectsObject(mesh.mesh)).toBe(false);

        // 真实顶点落在 x ∈ [4,6]:相机对准 x=5,曲面不应再被整块剔除
        vi.mocked(surfaceComputeClient.request).mockResolvedValue(makeResponse(TRIANGLES, 4));
        await runOnce(mesh, TRIANGLES * 3);
        mesh.mesh.updateMatrixWorld();

        const sphere = mesh.geometry.boundingSphere as THREE.Sphere | null;
        expect(sphere).not.toBeNull();
        expect(sphere!.radius).toBeGreaterThan(0);
        expect(frustum.intersectsObject(mesh.mesh)).toBe(true);

        mesh.dispose();
    });
});
