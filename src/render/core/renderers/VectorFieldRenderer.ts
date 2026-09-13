import * as THREE from 'three';
import type { IRenderer } from './IRenderer';
import type { VectorFieldObject } from '../../../compiler/ir/types';
import { splitCoefficients } from '../../../math/adapters/coefficientUtils';
import { VectorFieldMesh } from '../../visualization/VectorFieldMesh';
import { vectorFieldComputeClient } from '../../../math/compute/workers/VectorFieldComputeClient';
import type { VectorFieldWorkerRequest } from '../../../math/compute/workers/VectorFieldWorker';
import { LatestRequestExecutor } from '../../../math/compute/workers/LatestRequestExecutor';
import { reportSamplingFailure } from '../samplingErrors';

/**
 * 向量场渲染器
 * - 桥接数据层 VectorFieldExpr 和可视化层 VectorFieldMesh
 * - 实现 IRenderer,纳入 Plotter 路由体系
 */
export class VectorFieldRenderer implements IRenderer {
    readonly group: THREE.Group;
    private _mesh: VectorFieldMesh | null = null;

    /**
     * @cache
     * 缓存目的:保存网格点世界坐标,避免 range/gridSize 未变化时重复生成.
     * 键/失效策略:_positionsKey 由 range+gridSize 序列化得到;变化时重建.
     * 生命周期:跟随 VectorFieldRenderer 实例.
     */
    private _positions: Float32Array | null = null;
    private _positionsKey = '';
    private _disposed = false;

    /**
     * @cache
     * 缓存目的:把向量场采样请求收敛为 latest-only.
     * 键/失效策略:单飞队列;新请求取代 pending 请求.
     * 生命周期:跟随 VectorFieldRenderer 实例.
     */
    private readonly executor = new LatestRequestExecutor<
        VectorFieldWorkerRequest,
        Float32Array
    >(vectorFieldComputeClient);

    constructor(private _data: VectorFieldObject) {
        this.group = new THREE.Group();
    }

    get visible(): boolean {
        return this._data.enabled;
    }

    /**
     * @cache_access
     * 命中或重建网格坐标缓存,并通过 latest-only executor 更新向量值.
     */
    draw(): void {
        const { components, coefficients, range, gridSize, glyphScale, color } = this._data;

        // 网格点世界坐标(仅 range/gridSize 变化时重建)
        const key = this.getPositionsKey(range, gridSize);
        if (!this._positions || this._positionsKey !== key) {
            this._positions = this.buildPositions(range, gridSize);
            this._positionsKey = key;
            if (this._mesh) {
                this._mesh.dispose();
                this.group.remove(this._mesh.group);
                this._mesh = null;
            }
        }
        const positions = this._positions as Float32Array;
        const { names, values } = splitCoefficients(coefficients);

        // 表达式求值在 Worker 中完成,主线程只负责发请求和更新 mesh.
        this.executor
            .request({
                pExpr: components[0],
                qExpr: components[1],
                rExpr: components[2],
                coeffNames: names,
                coeffValues: values,
                range,
                gridSize,
            })
            .then((vectors) => {
                if (this._disposed) return;

                if (!this._mesh) {
                    this._mesh = new VectorFieldMesh(positions, vectors, color, glyphScale);
                    this.group.add(this._mesh.group);
                } else {
                    this._mesh.update(positions, vectors, glyphScale);
                    this._mesh.setColor(color);
                }

                this.group.visible = this.visible;
            })
            .catch((error: Error) => {
                if (this._disposed || error.message === 'superseded') return;
                reportSamplingFailure({
                    kind: 'vector_field',
                    name: this._data.name,
                    message: error.message,
                });
            });

        this.group.visible = this._data.enabled;
    }

    /** 根据当前 range 和 gridSize 生成网格点世界坐标 */
    private buildPositions(
        range: VectorFieldObject['range'],
        gridSize: VectorFieldObject['gridSize'],
    ): Float32Array {
        const [gx, gy, gz] = gridSize;
        const total = gx * gy * gz;
        const positions = new Float32Array(total * 3);

        // 保留原来的防除零处理:某维为 1 时步长应为 0.
        // 注意不能写成 (n - 1 || 1),否则 n === 1 时分母会变成 1,
        // 与 Rust/WASM 采样端的行为不一致.
        const dx = gx > 1 ? (range.x[1] - range.x[0]) / (gx - 1) : 0;
        const dy = gy > 1 ? (range.y[1] - range.y[0]) / (gy - 1) : 0;
        const dz = gz > 1 ? (range.z[1] - range.z[0]) / (gz - 1) : 0;

        let i = 0;
        for (let iz = 0; iz < gz; iz++) {
            const z = range.z[0] + iz * dz;
            for (let iy = 0; iy < gy; iy++) {
                const y = range.y[0] + iy * dy;
                for (let ix = 0; ix < gx; ix++) {
                    const x = range.x[0] + ix * dx;
                    positions[i] = x;
                    positions[i + 1] = y;
                    positions[i + 2] = z;
                    i += 3;
                }
            }
        }

        return positions;
    }

    /** 生成 range + gridSize 的缓存 key */
    private getPositionsKey(
        range: VectorFieldObject['range'],
        gridSize: VectorFieldObject['gridSize'],
    ): string {
        return JSON.stringify([range, gridSize]);
    }

    setVisible(v: boolean): void {
        this.group.visible = v;
    }

    updateRef(data: VectorFieldObject): void {
        this._data = data;
    }

    dispose(): void {
        this._disposed = true;
        this.executor.dispose();
        this._mesh?.dispose();
        this._mesh = null;
    }
}
