/**
 * 区域(region)渲染器.
 *
 * 把两条边界曲线在 region x 区间上采成折线,并绘制二者围成的带状填充面:
 * - 填充面:相邻两采样站的四边形三角形带(z=0,半透明双面);
 * - 边界描边:两条折线,颜色取各自边界曲线的颜色.
 *
 * 数值采样统一走 MathComputeEngine 的曲线 Worker(与 CurveRenderer 同源),
 * 渲染层不自行解析表达式;RegionRenderer 每次 draw() 对两条边界各发起一次
 * latest-only 采样,都返回后再重建几何.两曲线在采样站非有限值会被跳过,
 * 填充面在缺口两侧自动断开,避免画出越界的假带.
 *
 * 后续规划(roadmap):y 型区域 / 极坐标 r-θ 区域 / 三条以上曲线边界 /
 * 区域参与求交,见 compiler/ir/types.ts RegionObject 注释.
 */
import * as THREE from 'three';
import type { IRenderer } from '../renderers/IRenderer';
import type { CurveObject, RegionObject } from '../../../compiler/ir/types';
import { sharedCurveSamplingEngine as regionComputeEngine } from '../../../math/compute/MathComputeEngine';
import {
    LatestRequestExecutor,
    type RequestClient,
} from '../../../math/compute/workers/LatestRequestExecutor';
import { splitCoefficients } from '../../../math/adapters/coefficientUtils';
import type { CurveSampleResult } from '../../../math/compute/workers/CurveComputeClient';
import { reportSamplingFailure } from '../samplingErrors';

type RegionSampleRequest = {
    id: number;
    expr: string;
    coeffNames: string[];
    coeffValues: number[];
    range: [number, number];
    segments: number;
};

// @cache 与 CurveRenderer 共享同一采样门面(共享模块级 worker client).
const regionRequestClient: RequestClient<RegionSampleRequest, CurveSampleResult> = {
    request(request) {
        return regionComputeEngine.sampleCurve(request);
    },
};

interface BoundaryState {
    curve: CurveObject;
    executor: LatestRequestExecutor<RegionSampleRequest, CurveSampleResult>;
    /** 最近一次采样结果(扁平 [x, y, 0, ...] 三元组). */
    points: Float32Array;
    /** 每段起始顶点下标:定义域空洞/渐近线把边界切成多段. */
    offsets: Uint32Array;
    /** 采样站点数(非有限值被跳过后的实际点数). */
    count: number;
}

export class RegionRenderer implements IRenderer {
    readonly group = new THREE.Group();

    private fill: THREE.Mesh | null = null;
    /** 两条边界各用一个容器承载"逐段折线",每段一条 THREE.Line. */
    private readonly edgeGroups: [THREE.Group, THREE.Group] = [
        new THREE.Group(),
        new THREE.Group(),
    ];
    private readonly boundaries: [BoundaryState, BoundaryState];
    private userVisible = true;
    private disposed = false;
    private xRange: [number, number];
    private steps: number;

    constructor(
        private region: RegionObject,
        curveA: CurveObject,
        curveB: CurveObject,
    ) {
        this.xRange = region.range;
        this.steps = region.segments;
        this.boundaries = [
            {
                curve: curveA,
                executor: this._createExecutor(),
                points: new Float32Array(0),
                offsets: new Uint32Array(0),
                count: 0,
            },
            {
                curve: curveB,
                executor: this._createExecutor(),
                points: new Float32Array(0),
                offsets: new Uint32Array(0),
                count: 0,
            },
        ];
    }

    get visible(): boolean {
        return this.userVisible;
    }

    updateRef(region: RegionObject, curves?: [CurveObject, CurveObject]): void {
        this.region = region;
        this.xRange = region.range;
        this.steps = region.segments;
        if (curves) {
            this.boundaries[0].curve = curves[0];
            this.boundaries[1].curve = curves[1];
        }
    }

    draw(): void {
        const requests = this.boundaries.map((boundary) => {
            const { names, values } = splitCoefficients(boundary.curve.coefficients);
            return boundary.executor.request({
                expr: boundary.curve.expr,
                coeffNames: names,
                coeffValues: values,
                range: this.xRange,
                segments: this.steps,
            });
        });

        void Promise.all(requests)
            .then(([resultA, resultB]) => {
                if (this.disposed) return;
                // 区域填充只按 x 有序的扁平顶点配对;边界描边按 offsets 分段,
                // 避免在定义域空洞/竖直渐近线处画出横跨空洞的伪连接线.
                this.boundaries[0].points = resultA.points;
                this.boundaries[0].offsets = resultA.offsets;
                this.boundaries[0].count = resultA.points.length / 3;
                this.boundaries[1].points = resultB.points;
                this.boundaries[1].offsets = resultB.offsets;
                this.boundaries[1].count = resultB.points.length / 3;
                this._rebuild();
            })
            .catch((error: Error) => {
                if (this.disposed || error.message === 'superseded') return;
                reportSamplingFailure({
                    kind: 'curve',
                    name: this.region.name,
                    message: error.message,
                });
                this.group.visible = false;
            });
    }

    setVisible(v: boolean): void {
        this.userVisible = v;
        this.group.visible = this.visible;
    }

    dispose(): void {
        this.disposed = true;
        for (const boundary of this.boundaries) {
            boundary.executor.dispose();
        }
        this._disposeGeometry();
    }

    private _createExecutor(): LatestRequestExecutor<RegionSampleRequest, CurveSampleResult> {
        return new LatestRequestExecutor(regionRequestClient);
    }

    /**
     * @cache_access
     * 用最新采样重建填充面与两条边界线;只有部分站存在缺口时,
     * 以"x 对齐配对"方式跳过不成对的列.
     */
    private _rebuild(): void {
        const columns: Array<{ x: number; ya: number; yb: number }> = [];
        const a = this.boundaries[0];
        const b = this.boundaries[1];
        const [xa, xb] = this.xRange;
        const h = (xb - xa) / Math.max(1, this.steps);
        const tolerance = h * 0.75;

        let ia = 0;
        let ib = 0;
        while (ia < a.count && ib < b.count) {
            const xA = a.points[ia * 3];
            const xB = b.points[ib * 3];
            if (Math.abs(xA - xB) <= tolerance) {
                columns.push({ x: xA, ya: a.points[ia * 3 + 1], yb: b.points[ib * 3 + 1] });
                ia += 1;
                ib += 1;
            } else if (xA < xB) {
                ia += 1;
            } else {
                ib += 1;
            }
        }

        this._rebuildFill(columns);
        this._rebuildEdge(0);
        this._rebuildEdge(1);
    }

    private _rebuildFill(columns: Array<{ x: number; ya: number; yb: number }>): void {
        if (this.fill) {
            this._releaseObject(this.fill);
            this.fill = null;
        }
        if (columns.length < 2) return;

        const h = (this.xRange[1] - this.xRange[0]) / Math.max(1, this.steps);
        const positions: number[] = [];
        for (let i = 0; i + 1 < columns.length; i++) {
            const p0 = columns[i];
            const p1 = columns[i + 1];
            // 相邻列间距明显超过一档(中间整列缺失)时断开,不拉斜边.
            if (p1.x - p0.x > h * 1.75) continue;
            positions.push(p0.x, p0.ya, 0, p1.x, p1.ya, 0, p0.x, p0.yb, 0);
            positions.push(p1.x, p1.ya, 0, p1.x, p1.yb, 0, p0.x, p0.yb, 0);
        }
        if (positions.length === 0) return;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
        const material = new THREE.MeshBasicMaterial({
            color: this.region.color,
            transparent: true,
            opacity: this.region.opacity,
            side: THREE.DoubleSide,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -1,
        });
        this.fill = new THREE.Mesh(geometry, material);
        this.fill.renderOrder = 2;
        this.group.add(this.fill);
    }

    /**
     * 重建一条边界的逐段折线.
     *
     * 采样层在定义域空洞/竖直渐近线处把曲线切成多段并回传 offsets;必须
     * 逐段建线,否则会画出一条横跨空洞的伪连接线(CurveRenderer 已按此处理).
     * 重建路径必须同时释放上一轮的 geometry **与 material**.
     */
    private _rebuildEdge(index: 0 | 1): void {
        const container = this.edgeGroups[index];
        const { points, offsets, curve } = this.boundaries[index];
        // 释放上一轮各段的 geometry/material,并清空容器(容器自身会被
        // _releaseObject 从 group 摘除,有内容时再重新挂回).
        this._releaseObject(container);
        container.clear();
        if (points.length < 6 || offsets.length < 2) return;

        // 同一条边界的所有段共用一份材质,重建时统一释放.
        const material = new THREE.LineBasicMaterial({
            color: curve.color || this.region.color,
            transparent: true,
            opacity: 0.9,
            depthWrite: false,
        });
        let segments = 0;
        for (let k = 0; k + 1 < offsets.length; k += 1) {
            const start = offsets[k];
            const end = offsets[k + 1];
            const count = end - start;
            if (count < 2) continue; // 单点段画不出线段

            // points 是 Worker 转移过来的缓冲区,用 subarray 视图避免拷贝.
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
                'position',
                new THREE.BufferAttribute(points.subarray(start * 3, end * 3), 3),
            );
            const line = new THREE.Line(geometry, material);
            line.renderOrder = 3;
            container.add(line);
            segments += 1;
        }

        if (segments === 0) {
            material.dispose();
            return;
        }
        this.group.add(container);
    }

    /** 释放对象自身及其子节点的 GPU 资源,并从 group 摘除. */
    private _releaseObject(object: THREE.Object3D | null): void {
        if (!object) return;
        this.group.remove(object);
        object.traverse((node) => {
            const renderable = node as THREE.Mesh;
            renderable.geometry?.dispose();
            const material = renderable.material;
            if (Array.isArray(material)) {
                material.forEach((entry) => entry?.dispose());
            } else {
                material?.dispose();
            }
        });
    }

    private _disposeGeometry(): void {
        if (this.fill) {
            this._releaseObject(this.fill);
            this.fill = null;
        }
        for (const container of this.edgeGroups) {
            this._releaseObject(container);
            container.clear();
        }
    }
}
