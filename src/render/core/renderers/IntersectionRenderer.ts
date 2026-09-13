/**
 * 求交结果渲染与计算编排.
 *
 * 编译器现在只产出 `IntersectionTask`,本类负责:
 * - 用"任务名 -> 输入指纹"做增量缓存:参数没变,源对象没变的任务不重算;
 * - 求交结果是独立求值对象:隐藏源对象不隐藏交线,只有隐藏求交本身才移除;
 * - Worker 结果回来后只重建对应任务的 geometry,不整组 clear/recreate;
 * - 结果同步给对象列表回调.
 */
import * as THREE from 'three';
import type {
    IntersectionOutput,
    IntersectionTask,
    SceneObject,
} from '../../../compiler/ir/types';
import type { Mat4 } from '../../../math/tensor/rowMajorMatrix';
import {
    buildIntersectionInput,
    decodeIntersectionOutput,
} from '../../../math/adapters/IntersectionMath';
import {
    requestIntersection,
} from '../../../math/compute/workers/IntersectionComputeClient';
import { RENDER_CONFIG } from '../../../config/renderConfig';

export type IntersectionResultCallback = (
    name: string,
    output: IntersectionOutput,
) => void;
export type IntersectionErrorCallback = (name: string, message: string) => void;

export class IntersectionRenderer {
    readonly group = new THREE.Group();

    /**
     * @cache
     * 缓存目的:按求交任务名保存已计算输出与当前 geometry,参数无关的
     * 刷新不销毁/重建.
     * 键/失效策略:任务名;任务输入变化/任务消失时替换.
     * 生命周期:跟随 IntersectionRenderer 实例.
     */
    private readonly visuals = new Map<string, THREE.Group>();
    private readonly outputs = new Map<string, IntersectionOutput>();
    private readonly inputKeys = new Map<string, string>();
    private readonly taskSequences = new Map<string, number>();
    private sequence = 0;
    private disposed = false;

    /**
     * @cache_access
     * 比较上一轮任务输入,只调度真正变化的任务.
     *
     * @param force 完整 Run 时传 true:即使指纹相同也重算一次;
     *              参数刷新/显隐切换传 false.
     */
    sync(
        tasks: IntersectionTask[],
        objects: readonly SceneObject[],
        transforms: Readonly<Record<number, Mat4>>,
        force: boolean,
        onResult?: IntersectionResultCallback,
        onError?: IntersectionErrorCallback,
    ): void {
        if (this.disposed) return;

        const nextNames = new Set(tasks.map((task) => task.name));
        for (const name of this.inputKeys.keys()) {
            if (!nextNames.has(name)) this._removeTask(name);
        }

        if (force) {
            this.sequence += 1;
            this.outputs.clear();
            for (const name of [...this.visuals.keys()]) {
                this._disposeVisual(name);
            }
            for (const name of this.inputKeys.keys()) {
                this.taskSequences.set(name, this.sequence);
            }
        }

        const toCompute: IntersectionTask[] = [];
        for (const task of tasks) {
            if (!task.enabled) {
                this._removeTask(task.name);
                continue;
            }

            const input = buildIntersectionInput(task, objects, transforms);
            // 指纹只放几何/参数:颜色不是求交输入,混进来会让"纯换色"触发
            // 一次完整重算(并让结果短暂闪空).换色走 _showCached 的轻路径.
            const key = input
                ? JSON.stringify(input)
                : `disabled:${task.name}`;

            if (
                force
                || this.inputKeys.get(task.name) !== key
                || !this.outputs.has(task.name)
            ) {
                if (!force) {
                    this._disposeVisual(task.name);
                    this.outputs.delete(task.name);
                }
                this.inputKeys.set(task.name, key);
                this.taskSequences.set(task.name, ++this.sequence);
                toCompute.push(task);
            } else {
                this._showCached(task);
            }
        }

        if (toCompute.length > 0) {
            void this._runAll(toCompute, objects, transforms, onResult, onError);
        }
    }

    /** 只清当前任务结果缓存与可见几何,不销毁共享 Worker. */
    clearAll(): void {
        this.sequence += 1;
        for (const name of [...this.inputKeys.keys()]) {
            this._removeTask(name);
        }
    }

    dispose(): void {
        this.disposed = true;
        this.clearAll();
    }

    private _showCached(task: IntersectionTask): void {
        const output = this.outputs.get(task.name);
        if (!output) return;
        const existing = this.visuals.get(task.name);
        if (!existing) {
            if (output.points.length === 0 && output.curves.length === 0) {
                return;
            }
            this._buildVisual(task.name, task.color, output);
            return;
        }
        // 指纹未变但颜色变了:只按缓存结果重建可视对象(不再发求交请求).
        if (existing.userData.color !== task.color) {
            this._disposeVisual(task.name);
            this._buildVisual(task.name, task.color, output);
        }
    }

    private async _runAll(
        tasks: IntersectionTask[],
        objects: readonly SceneObject[],
        transforms: Readonly<Record<number, Mat4>>,
        onResult?: IntersectionResultCallback,
        onError?: IntersectionErrorCallback,
    ): Promise<void> {
        for (const task of tasks) {
            if (this.disposed) return;
            const taskSequence = this.taskSequences.get(task.name);
            if (taskSequence === undefined) continue;

            const input = buildIntersectionInput(task, objects, transforms);
            if (!input) {
                this._disposeVisual(task.name);
                continue;
            }

            try {
                const result = await requestIntersection(input);
                if (
                    this.disposed
                    || this.taskSequences.get(task.name) !== taskSequence
                ) {
                    return;
                }
                const output = decodeIntersectionOutput(
                    result.points,
                    result.curvePoints,
                    result.curveOffsets,
                );
                this.outputs.set(task.name, output);
                this._disposeVisual(task.name);
                if (output.points.length > 0 || output.curves.length > 0) {
                    this._buildVisual(task.name, task.color, output);
                }
                onResult?.(task.name, output);
            } catch (error) {
                if (
                    this.disposed
                    || this.taskSequences.get(task.name) !== taskSequence
                ) {
                    return;
                }
                onError?.(
                    task.name,
                    error instanceof Error ? error.message : String(error),
                );
            }
        }
    }

    private _removeTask(name: string): void {
        this._disposeVisual(name);
        this.outputs.delete(name);
        this.inputKeys.delete(name);
        this.taskSequences.delete(name);
    }

    private _disposeVisual(name: string): void {
        const child = this.visuals.get(name);
        if (!child) return;
        this.group.remove(child);
        child.traverse((node) => {
            if (node instanceof THREE.Points || node instanceof THREE.Line) {
                node.geometry?.dispose();
                const material = node.material;
                if (Array.isArray(material)) {
                    material.forEach((entry) => entry.dispose());
                } else {
                    material?.dispose();
                }
            }
        });
        this.visuals.delete(name);
    }

    private _buildVisual(
        name: string,
        color: string,
        output: IntersectionOutput,
    ): void {
        const child = new THREE.Group();
        if (output.points.length > 0) {
            child.add(this._buildPoints(output.points, color));
        }
        for (const curve of output.curves) {
            child.add(this._buildCurve(curve, color));
        }
        this.group.add(child);
        // 记住当前颜色,供 _showCached 判断"只是换色"时轻量重建
        child.userData.color = color;
        this.visuals.set(name, child);
    }

    private _buildPoints(points: IntersectionOutput['points'], color: string): THREE.Points {
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(points.length * 3);
        points.forEach((point, index) => {
            positions[index * 3] = point.x;
            positions[index * 3 + 1] = point.y;
            positions[index * 3 + 2] = point.z;
        });
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const material = new THREE.PointsMaterial({
            color,
            size: RENDER_CONFIG.intersection.pointSize,
            sizeAttenuation: true,
            transparent: true,
            opacity: 0.95,
            depthWrite: false,
        });
        return new THREE.Points(geometry, material);
    }

    private _buildCurve(
        curve: readonly { x: number; y: number; z: number }[],
        color: string,
    ): THREE.Line {
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(curve.length * 3);
        curve.forEach((point, index) => {
            positions[index * 3] = point.x;
            positions[index * 3 + 1] = point.y;
            positions[index * 3 + 2] = point.z;
        });
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const material = new THREE.LineBasicMaterial({
            color,
            linewidth: RENDER_CONFIG.intersection.lineWidth,
            transparent: true,
            opacity: 0.95,
        });
        return new THREE.Line(geometry, material);
    }
}
