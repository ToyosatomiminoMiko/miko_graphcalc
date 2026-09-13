// ============================================================
// integral/grids.ts - 二维网格域(矩形 / 区域)的实体几何
//
// 被积函数在 nx×ny 网格上采样,生成两类可视化几何:
//   - createTrapezoidGridGroup: 梯形法,每个单元是一根下底贴 xy 平面的
//     六面体柱阵(四角取被积值,侧面随角点高度成斜平面);
//   - createSurfaceGridGroup:   辛普森法,顶部曲面 + 底部平面 + 四周围裙,
//     四角都有限(带内)的单元才生成顶面三角形.
// 两函数均为纯构建,共用 solidPrimitives 的 wrapSolid 收尾;
// 返回 null 表示没有可绘制单元,调用方不应登记缓存.
// ============================================================
import * as THREE from 'three';
import { wrapSolid } from '../solidPrimitives';

/**
 * 生成二维梯形可视化的"实体柱阵"组:每个网格单元是一根下底贴 xy 平面,
 * 上盖取四角被积值的六面体(侧面随角点高度成斜平面).
 * 返回 null 表示没有可绘制单元(调用方不应登记缓存).
 */
export function createTrapezoidGridGroup(
    fn: (x: number, y: number) => number,
    xRange: [number, number],
    yRange: [number, number],
    nx: number,
    ny: number,
    color: THREE.Color,
    opacity: number,
): THREE.Group | null {
    const [xMin, xMax] = xRange;
    const [yMin, yMax] = yRange;
    const hx = (xMax - xMin) / nx;
    const hy = (yMax - yMin) / ny;
    const positions: number[] = [];
    const indices: number[] = [];

    const addVertex = (x: number, y: number, z: number): number => {
        positions.push(x, y, z);
        return positions.length / 3 - 1;
    };
    const addQuad = (a: number, b: number, c: number, d: number): void => {
        indices.push(a, b, c, a, c, d);
    };

    for (let j = 0; j < ny; j += 1) {
        const y0 = yMin + j * hy;
        const y1 = yMin + (j + 1) * hy;
        for (let i = 0; i < nx; i += 1) {
            const x0 = xMin + i * hx;
            const x1 = xMin + (i + 1) * hx;
            const z00 = fn(x0, y0);
            const z10 = fn(x1, y0);
            const z01 = fn(x0, y1);
            const z11 = fn(x1, y1);
            if (!isFinite(z00) || !isFinite(z10) || !isFinite(z01) || !isFinite(z11)) {
                continue;
            }

            const b00 = addVertex(x0, y0, 0);
            const b10 = addVertex(x1, y0, 0);
            const b01 = addVertex(x0, y1, 0);
            const b11 = addVertex(x1, y1, 0);
            const t00 = addVertex(x0, y0, z00);
            const t10 = addVertex(x1, y0, z10);
            const t01 = addVertex(x0, y1, z01);
            const t11 = addVertex(x1, y1, z11);

            addQuad(t00, t10, t11, t01);
            addQuad(b00, b10, b11, b01);
            addQuad(b00, t00, t10, b10);
            addQuad(b10, t10, t11, b11);
            addQuad(b11, t11, t01, b01);
            addQuad(b01, t01, t00, b00);
        }
    }

    if (indices.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    return wrapSolid(geometry, color, opacity, 0.3);
}

/**
 * 生成二维辛普森可视化的"积分曲面"组:顶部曲面 + 底部平面 + 四周围裙,
 * 只有四角都有限(带内)的单元才生成顶面三角形.
 * 返回 null 表示没有可绘制单元(调用方不应登记缓存).
 */
export function createSurfaceGridGroup(
    fn: (x: number, y: number) => number,
    xRange: [number, number],
    yRange: [number, number],
    nx: number,
    ny: number,
    color: THREE.Color,
    opacity: number,
): THREE.Group | null {
    const [xMin, xMax] = xRange;
    const [yMin, yMax] = yRange;
    const stride = nx + 1;
    const xs = new Float64Array(stride);
    const ys = new Float64Array(stride);
    const zs = new Float64Array(stride * stride);
    let hasFinite = false;

    for (let i = 0; i <= nx; i += 1) xs[i] = xMin + ((xMax - xMin) * i) / nx;
    for (let j = 0; j <= ny; j += 1) ys[j] = yMin + ((yMax - yMin) * j) / ny;
    for (let j = 0; j <= ny; j += 1) {
        for (let i = 0; i <= nx; i += 1) {
            const z = fn(xs[i], ys[j]);
            if (isFinite(z)) {
                zs[j * stride + i] = z;
                hasFinite = true;
            } else {
                zs[j * stride + i] = NaN;
            }
        }
    }
    if (!hasFinite) return null;

    const positions: number[] = [];
    const indices: number[] = [];
    const topIndex = new Int32Array(stride * stride);
    topIndex.fill(-1);

    for (let j = 0; j <= ny; j += 1) {
        for (let i = 0; i <= nx; i += 1) {
            const idx = j * stride + i;
            topIndex[idx] = positions.length / 3;
            positions.push(xs[i], ys[j], isFinite(zs[idx]) ? zs[idx] : 0);
        }
    }

    for (let j = 0; j < ny; j += 1) {
        for (let i = 0; i < nx; i += 1) {
            const i00 = j * stride + i;
            const i10 = i00 + 1;
            const i01 = i00 + stride;
            const i11 = i01 + 1;
            if (
                !isFinite(zs[i00])
                || !isFinite(zs[i10])
                || !isFinite(zs[i01])
                || !isFinite(zs[i11])
            ) {
                continue;
            }

            const a = topIndex[i00];
            const b = topIndex[i10];
            const c = topIndex[i01];
            const d = topIndex[i11];
            indices.push(a, b, d, a, d, c);
        }
    }

    const addVerticalQuad = (
        i0: number,
        j0: number,
        i1: number,
        j1: number,
    ): void => {
        const idx0 = j0 * stride + i0;
        const idx1 = j1 * stride + i1;
        if (!isFinite(zs[idx0]) || !isFinite(zs[idx1])) return;
        if (Math.max(Math.abs(zs[idx0]), Math.abs(zs[idx1])) < 1e-12) return;

        const top0 = topIndex[idx0];
        const top1 = topIndex[idx1];
        const bottom0 = positions.length / 3;
        positions.push(xs[i0], ys[j0], 0);
        const bottom1 = positions.length / 3;
        positions.push(xs[i1], ys[j1], 0);
        indices.push(top0, bottom0, bottom1, top0, bottom1, top1);
    };

    for (let j = 0; j < ny; j += 1) {
        addVerticalQuad(0, j, 0, j + 1);
        addVerticalQuad(nx, j, nx, j + 1);
    }
    for (let i = 0; i < nx; i += 1) {
        addVerticalQuad(i, 0, i + 1, 0);
        addVerticalQuad(i, ny, i + 1, ny);
    }

    if (indices.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    return wrapSolid(geometry, color, opacity, 0.3);
}
