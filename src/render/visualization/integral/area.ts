// ============================================================
// integral/area.ts - 一维面积(梯形 / 辛普森)的可视化几何
//
// 把被积曲线下的有向面积建成实体棱柱:先按符号把每个区间拆成不跨零的
// 简单多边形(signedAreaPolygons),再一次性挤出为单块几何(createPrismAreaGroup).
// Simpson 需要的抛物线细分点由 quadraticPoints(拉格朗日插值)给出.
// 实体与线框的收尾统一走 solidPrimitives 的 wrapSolid,grids.ts 也复用它.
// 本文件不触碰场景与缓存,构建结果返回 null 表示无可绘制内容.
// ============================================================
import * as THREE from 'three';
import { RENDER_CONFIG } from '../../../config/renderConfig';
import { wrapSolid } from '../solidPrimitives';

const { depth2D: DEPTH_2D } = RENDER_CONFIG.integralVisualizer;

/** 一维积分的一个梯形区间(两端点被积值). */
export interface Segment2D {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
}

/** 把单个梯形区间拆成不跨零的简单多边形. */
export function signedAreaPolygons(segment: Segment2D): number[][][] {
    const { x0, x1, y0, y1 } = segment;
    if (!isFinite(y0) || !isFinite(y1)) return [];
    if (Math.abs(y0) < 1e-12 && Math.abs(y1) < 1e-12) return [];

    if (Math.abs(y0) < 1e-12) {
        return [[[x0, 0], [x1, y1], [x1, 0]]];
    }
    if (Math.abs(y1) < 1e-12) {
        return [[[x0, 0], [x0, y0], [x1, 0]]];
    }
    if (y0 * y1 < 0) {
        const xc = x0 - (y0 * (x1 - x0)) / (y1 - y0);
        return [
            [[x0, 0], [x0, y0], [xc, 0]],
            [[xc, 0], [x1, y1], [x1, 0]],
        ];
    }

    return [[[x0, 0], [x0, y0], [x1, y1], [x1, 0]]];
}

/** 通过拉格朗日插值生成 Simpson 抛物线采样点. */
export function quadraticPoints(
    x0: number,
    x1: number,
    x2: number,
    y0: number,
    y1: number,
    y2: number,
    samples: number,
): Array<{ x: number; y: number }> {
    if (!isFinite(y0) || !isFinite(y1) || !isFinite(y2)) return [];

    const l0 = (x: number): number => ((x - x1) * (x - x2)) / ((x0 - x1) * (x0 - x2));
    const l1 = (x: number): number => ((x - x0) * (x - x2)) / ((x1 - x0) * (x1 - x2));
    const l2 = (x: number): number => ((x - x0) * (x - x1)) / ((x2 - x0) * (x2 - x1));
    const points: Array<{ x: number; y: number }> = [];

    for (let i = 0; i <= samples; i += 1) {
        const x = x0 + ((x2 - x0) * i) / samples;
        points.push({ x, y: y0 * l0(x) + y1 * l1(x) + y2 * l2(x) });
    }
    return points;
}

/**
 * 生成一维面积的挤出棱柱组(梯形/辛普森可视化的实体柱).
 * 区间按符号拆成不跨零的多边形,汇总后一次性挤出为单块几何,避免逐块
 * 挤出再合并带来的大量临时几何分配.
 * 返回 null 表示没有可绘制面积(调用方不应登记缓存).
 */
export function createPrismAreaGroup(
    segments: Segment2D[],
    color: THREE.Color,
    opacity: number,
): THREE.Group | null {
    const shapes: THREE.Shape[] = [];

    for (const segment of segments) {
        for (const polygon of signedAreaPolygons(segment)) {
            shapes.push(new THREE.Shape(polygon.map(([x, y]) => new THREE.Vector2(x, y))));
        }
    }

    if (shapes.length === 0) return null;
    const geometry = new THREE.ExtrudeGeometry(shapes, {
        depth: DEPTH_2D,
        bevelEnabled: false,
    });
    geometry.translate(0, 0, -DEPTH_2D / 2);

    return wrapSolid(geometry, color, opacity, 0.35);
}
