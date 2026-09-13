// ============================================================
// integral/area.test.ts - 一维面积几何的单元测试
//
// 覆盖三处纯构建逻辑:
//   - signedAreaPolygons: 按符号把梯形区间拆成不跨零的简单多边形;
//   - quadraticPoints:    Simpson 抛物线采样点的拉格朗日插值;
//   - createPrismAreaGroup: 多边形 -> 挤出棱柱组,空输入必须返回 null.
// 本文件不接触场景/渲染器,只校验几何结果本身.
// 注意: vitest 无法对 ESM 命名空间导出做 vi.spyOn(报
// "Module namespace is not configurable in ESM"),因此这里不守护
// "ExtrudeGeometry 只构造一次"的分配次数,只守护构建结果.
// ============================================================
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { createPrismAreaGroup, quadraticPoints, signedAreaPolygons } from './area';

/** 测试用固定颜色;具体色值不影响本文件的几何断言. */
const COLOR = new THREE.Color('#3b82f6');

describe('signedAreaPolygons 符号拆分', () => {
    it('两端点都为 0(含 1e-12 阈值内)时没有面积', () => {
        expect(signedAreaPolygons({ x0: 0, x1: 1, y0: 0, y1: 0 })).toEqual([]);
        expect(signedAreaPolygons({ x0: 0, x1: 1, y0: 1e-13, y1: -1e-13 })).toEqual([]);
    });

    it('仅左端点为 0 时退化为单个三角形', () => {
        expect(signedAreaPolygons({ x0: 1, x1: 3, y0: 0, y1: 2 }))
            .toEqual([[[1, 0], [3, 2], [3, 0]]]);
    });

    it('仅右端点为 0 时退化为单个三角形', () => {
        expect(signedAreaPolygons({ x0: 1, x1: 3, y0: 2, y1: 0 }))
            .toEqual([[[1, 0], [1, 2], [3, 0]]]);
    });

    it('y0*y1<0 时在零交点处拆成两个三角形', () => {
        // x0=0, x1=2, y0=1, y1=-1 -> 零交点 xc = 1.
        expect(signedAreaPolygons({ x0: 0, x1: 2, y0: 1, y1: -1 })).toEqual([
            [[0, 0], [0, 1], [1, 0]],
            [[1, 0], [2, -1], [2, 0]],
        ]);

        // 一般公式 xc = x0 - y0*(x1-x0)/(y1-y0),用非对称输入复核.
        const xc = 1 - (2 * (3 - 1)) / (-1 - 2);
        expect(signedAreaPolygons({ x0: 1, x1: 3, y0: 2, y1: -1 })[0][2][0])
            .toBeCloseTo(xc, 12);
    });

    it('同号区间(同正或同负)为单个四边形', () => {
        expect(signedAreaPolygons({ x0: 0, x1: 2, y0: 1, y1: 3 }))
            .toEqual([[[0, 0], [0, 1], [2, 3], [2, 0]]]);
        expect(signedAreaPolygons({ x0: 0, x1: 2, y0: -1, y1: -3 }))
            .toEqual([[[0, 0], [0, -1], [2, -3], [2, 0]]]);
    });

    it('端点非有限时返回空数组', () => {
        expect(signedAreaPolygons({ x0: 0, x1: 1, y0: Number.NaN, y1: 1 })).toEqual([]);
        expect(signedAreaPolygons({ x0: 0, x1: 1, y0: 1, y1: Number.POSITIVE_INFINITY }))
            .toEqual([]);
    });
});

describe('quadraticPoints 拉格朗日插值', () => {
    it('端点精确取到 (x0,y0) 与 (x2,y2)', () => {
        const points = quadraticPoints(0, 1, 2, 1, 5, 3, 4);
        expect(points[0].x).toBe(0);
        expect(points[0].y).toBeCloseTo(1, 12);
        expect(points[points.length - 1].x).toBe(2);
        expect(points[points.length - 1].y).toBeCloseTo(3, 12);
    });

    it('中点 x1 处取到 y1', () => {
        const points = quadraticPoints(0, 1, 2, 1, 5, 3, 2);
        expect(points[1].x).toBe(1);
        expect(points[1].y).toBeCloseTo(5, 12);
    });

    it('采样点数为 samples+1', () => {
        expect(quadraticPoints(0, 1, 2, 1, 5, 3, 5)).toHaveLength(6);
        expect(quadraticPoints(0, 1, 2, 1, 5, 3, 16)).toHaveLength(17);
    });

    it('节点值非有限时返回空数组', () => {
        expect(quadraticPoints(0, 1, 2, Number.NaN, 5, 3, 4)).toEqual([]);
        expect(quadraticPoints(0, 1, 2, 1, 5, Number.NEGATIVE_INFINITY, 4)).toEqual([]);
    });
});

describe('createPrismAreaGroup 挤出棱柱组', () => {
    it('空区间或零面积区间返回 null', () => {
        expect(createPrismAreaGroup([], COLOR, 0.5)).toBeNull();
        expect(createPrismAreaGroup([{ x0: 0, x1: 1, y0: 0, y1: 0 }], COLOR, 0.5)).toBeNull();
        expect(createPrismAreaGroup(
            [{ x0: 0, x1: 1, y0: Number.NaN, y1: 1 }],
            COLOR,
            0.5,
        )).toBeNull();
    });

    it('正常梯形区间产出 Mesh + LineSegments 两个子节点', () => {
        const group = createPrismAreaGroup([{ x0: 0, x1: 1, y0: 1, y1: 2 }], COLOR, 0.5);
        expect(group).not.toBeNull();
        expect(group).toBeInstanceOf(THREE.Group);
        expect(group!.children).toHaveLength(2);

        const [mesh, edges] = group!.children;
        expect(mesh).toBeInstanceOf(THREE.Mesh);
        expect(edges).toBeInstanceOf(THREE.LineSegments);
        expect((mesh as THREE.Mesh).geometry.attributes.position.count).toBeGreaterThan(0);
    });

    it('多区间跨零输入仍能构建出单块几何', () => {
        // 跨零区间会拆成两个三角形,连同两个同号四边形共 4 个多边形;
        // 这里只守卫"能构建",分配次数需靠 vi.spyOn,而 ESM 命名空间不支持.
        const group = createPrismAreaGroup(
            [
                { x0: 0, x1: 1, y0: 1, y1: 2 },
                { x0: 1, x1: 2, y0: 2, y1: 3 },
                { x0: 2, x1: 3, y0: 1, y1: -1 },
            ],
            COLOR,
            0.5,
        );
        expect(group).not.toBeNull();
        expect(group!.children).toHaveLength(2);
        const geometry = (group!.children[0] as THREE.Mesh).geometry;
        expect(geometry.attributes.position.count).toBeGreaterThan(0);
    });
});
