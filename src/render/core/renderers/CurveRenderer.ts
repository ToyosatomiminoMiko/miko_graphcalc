/**
 * 曲线渲染器.
 * 数值采样统一走 MathComputeEngine,渲染层不再自行解析表达式.
 *
 * 采样层(`sample_curve`)会在定义域空洞/竖直渐近线处把曲线切成多段,
 * 返回 `{ points, offsets }`.渲染层据此为每段创建一条独立折线(THREE.Line),
 * 而不是把整条曲线串成一条连续折线--否则像 `(1 + 1/x)^x` 这种在 x=0 附近
 * 存在定义域空洞的函数,会被一条横跨空洞的伪连接线错误地连起来.
 */
import * as THREE from 'three';
import { NUMERIC_CONFIG } from '../../../config/numericConfig';
import type { IRenderer } from './IRenderer';
import type { CurveObject } from '../../../compiler/ir/types';
import { splitCoefficients } from '../../../math/adapters/coefficientUtils';
import { sharedCurveSamplingEngine as curveComputeEngine } from '../../../math/compute/MathComputeEngine';
import type { CurveSampleResult } from '../../../math/compute/workers/CurveComputeClient';
import {
    LatestRequestExecutor,
    type RequestClient,
} from '../../../math/compute/workers/LatestRequestExecutor';
import { reportSamplingFailure } from '../samplingErrors';

type CurveRendererRequest = {
    id: number;
    expr: string;
    coeffNames: string[];
    coeffValues: number[];
    range: [number, number];
    segments: number;
};

// CurveRenderer 的请求形状与 MathComputeEngine 直接一致.
// 每个曲线 renderer 都有一个 executor,拖动滑块时不会向共享 worker 堆积旧请求.
const curveRequestClient: RequestClient<CurveRendererRequest, CurveSampleResult> = {
    request(request) {
        return curveComputeEngine.sampleCurve(request);
    },
};

export class CurveRenderer implements IRenderer {
    readonly group = new THREE.Group();
    /** 当前已创建的逐段折线;每次采样结果落地后重建. */
    private lines: THREE.Line[] = [];
    private material: THREE.LineBasicMaterial | null = null;
    private userVisible = true;
    private xRange: [number, number];
    private steps: number;
    private disposed = false;
    /**
     * @cache
     * 缓存目的:把曲线采样请求收敛为 latest-only,避免高频参数刷新积压旧任务.
     * 键/失效策略:单飞队列;新请求会取代 pending 请求.
     * 生命周期:跟随 CurveRenderer 实例.
     */
    private readonly executor = new LatestRequestExecutor<
        CurveRendererRequest,
        CurveSampleResult
    >(curveRequestClient);

    constructor(public curve: CurveObject) {
        this.xRange = curve.range ?? ([...NUMERIC_CONFIG.curve.defaultRange] as [number, number]);
        this.steps = curve.segments ?? NUMERIC_CONFIG.curve.defaultSegments;
    }

    get visible(): boolean {
        return this.userVisible;
    }

    draw(): void {
        const { names, values } = splitCoefficients(this.curve.coefficients);

        void this.executor
            .request({
                expr: this.curve.expr,
                coeffNames: names,
                coeffValues: values,
                range: this.xRange,
                segments: this.steps,
            })
            .then((sampled) => {
                if (this.disposed) return;
                this._renderSegments(sampled);
            })
            .catch((error: Error) => {
                if (this.disposed || error.message === 'superseded') return;
                reportSamplingFailure({
                    kind: 'curve',
                    name: this.curve.name,
                    message: error.message,
                });
                this.group.visible = false;
            });
    }

    setVisible(v: boolean): void {
        this.userVisible = v;
        this.group.visible = this.visible;
    }

    updateRef(curve: CurveObject): void {
        this.curve = curve;
        this.xRange = curve.range ?? ([...NUMERIC_CONFIG.curve.defaultRange] as [number, number]);
        this.steps = curve.segments ?? NUMERIC_CONFIG.curve.defaultSegments;
    }

    dispose(): void {
        this.disposed = true;
        this.executor.dispose();
        this._clearLines();
        this.material?.dispose();
        this.material = null;
    }

    /**
     * @cache_access
     * 把采样结果里的各段折线落地为一个个独立的 THREE.Line;
     * 上一帧的折线先释放.单顶点段不绘制(一条只有一个顶点的 Line 画不出
     * 任何线段),因此极值处的隔离采样点会自然隐去.
     */
    private _renderSegments(sampled: CurveSampleResult): void {
        this._clearLines();

        const { points, offsets } = sampled;
        // 顶点总量不足以画出任何线段时整条曲线隐藏.
        if (points.length < 6 || offsets.length < 2) {
            this.group.visible = false;
            return;
        }

        const material = this._getMaterial();
        for (let k = 0; k + 1 < offsets.length; k += 1) {
            const start = offsets[k];
            const end = offsets[k + 1];
            const count = end - start;
            if (count < 2) continue; // 单点段不画

            // points 是与 Worker 转移过来的缓冲,直接用 subarray 视图避免拷贝.
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
                'position',
                new THREE.BufferAttribute(points.subarray(start * 3, end * 3), 3),
            );
            const line = new THREE.Line(geometry, material);
            this.lines.push(line);
            this.group.add(line);
        }

        this.group.visible = this.lines.length > 0 && this.visible;
    }

    /**
     * @cache_access
     * 复用同一份材质;颜色在每次采样落地时同步,避免换色后仍显示旧颜色.
     */
    private _getMaterial(): THREE.LineBasicMaterial {
        if (!this.material) {
            this.material = new THREE.LineBasicMaterial({
                color: this.curve.color || '#ffffff',
                linewidth: 1,
                transparent: true,
                opacity: 0.95,
            });
            return this.material;
        }
        this.material.color.set(this.curve.color || '#ffffff');
        return this.material;
    }

    /**
     * @cache_access
     * 释放当前全部折线的几何体并把折线列表清空;跨段复用的材质不在此释放,
     * 由 `dispose()` 单独处理.
     */
    private _clearLines(): void {
        for (const line of this.lines) {
            this.group.remove(line);
            line.geometry?.dispose();
        }
        this.lines = [];
    }
}
