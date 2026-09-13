import * as THREE from 'three';
import type { AnimationClip } from '../../compiler/ir/types';
import {
    cloneMat4,
    type Mat4,
} from '../../math/tensor/rowMajorMatrix';
import type { MatrixOps } from '../../math/tensor/SceneTransform';

interface ObjectAnimationTimeline {
    base: Mat4 | null;
    clips: AnimationClip[];
}

function rowMajorToColumnMajor(matrix: Mat4): number[] {
    return [
        matrix[0][0], matrix[1][0], matrix[2][0], matrix[3][0],
        matrix[0][1], matrix[1][1], matrix[2][1], matrix[3][1],
        matrix[0][2], matrix[1][2], matrix[2][2], matrix[3][2],
        matrix[0][3], matrix[1][3], matrix[2][3], matrix[3][3],
    ];
}

function threeToRowMajor(matrix: THREE.Matrix4): Mat4 {
    const e = matrix.elements;
    return [
        [e[0], e[4], e[8], e[12]],
        [e[1], e[5], e[9], e[13]],
        [e[2], e[6], e[10], e[14]],
        [e[3], e[7], e[11], e[15]],
    ];
}

function interpolateMat4(start: Mat4, end: Mat4, t: number): Mat4 {
    if (t <= 0) return cloneMat4(start);
    if (t >= 1) return cloneMat4(end);

    const startMatrix = new THREE.Matrix4().fromArray(rowMajorToColumnMajor(start));
    const endMatrix = new THREE.Matrix4().fromArray(rowMajorToColumnMajor(end));
    const startPosition = new THREE.Vector3();
    const startQuaternion = new THREE.Quaternion();
    const startScale = new THREE.Vector3();
    const endPosition = new THREE.Vector3();
    const endQuaternion = new THREE.Quaternion();
    const endScale = new THREE.Vector3();

    startMatrix.decompose(startPosition, startQuaternion, startScale);
    endMatrix.decompose(endPosition, endQuaternion, endScale);

    startPosition.lerp(endPosition, t);
    startQuaternion.slerp(endQuaternion, t);
    startScale.lerp(endScale, t);

    return threeToRowMajor(
        new THREE.Matrix4().compose(startPosition, startQuaternion, startScale),
    );
}

/**
 * 按时间轴计算对象动画矩阵.
 *
 * 动画 clip 有序执行,每个 clip 都是基于"前一个 clip 结束后的矩阵"继续
 * 右乘一次;这对应 DSL 中多个 animation 串成复杂动画的语义.
 */
export class AnimationPlayer {
    private matrixOps: MatrixOps | null;

    /**
     * @cache
     * 缓存目的:保存每个对象的基础变换和动画 clip 时间线,供每帧插值快速查询.
     * 键/失效策略:对象 id -> ObjectAnimationTimeline;setScene 时整体重建.
     * 生命周期:跟随 AnimationPlayer 实例.
     */
    private timelines = new Map<number, ObjectAnimationTimeline>();

    constructor(matrixOps: MatrixOps | null = null) {
        this.matrixOps = matrixOps;
    }

    configure(matrixOps: MatrixOps | null): void {
        this.matrixOps = matrixOps;
    }

    /**
     * @cache_access
     * 用新的 SceneIR 重建动画时间线缓存.
     */
    setScene(
        objectTransforms: Record<number, Mat4>,
        animations: AnimationClip[],
        objectAnimations: Record<number, string[]>,
    ): void {
        this.timelines.clear();

        const clipByName = new Map<string, AnimationClip>();
        for (const clip of animations) {
            clipByName.set(clip.name, clip);
        }

        for (const [rawId, names] of Object.entries(objectAnimations)) {
            const id = Number(rawId);
            const clips = names
                .map((name) => clipByName.get(name))
                .filter((clip): clip is AnimationClip => clip !== undefined);
            this.timelines.set(id, {
                base: objectTransforms[id] ? cloneMat4(objectTransforms[id]) : null,
                clips: clips.map((clip) => ({
                    name: clip.name,
                    duration: clip.duration,
                    matrix: cloneMat4(clip.matrix),
                })),
            });
        }

        for (const [rawId, base] of Object.entries(objectTransforms)) {
            const id = Number(rawId);
            if (!this.timelines.has(id)) {
                this.timelines.set(id, { base: cloneMat4(base), clips: [] });
            }
        }
    }

    /**
     * @cache_access
     * 根据当前时间线缓存计算对象矩阵.
     */
    getObjectMatrix(id: number, elapsedSeconds: number): Mat4 | null {
        const timeline = this.timelines.get(id);
        if (!timeline) return null;

        let cumulative = timeline.base ? cloneMat4(timeline.base) : null;

        if (timeline.clips.length === 0) {
            return cumulative;
        }

        if (!cumulative) {
            cumulative = this.matrixOps?.identity() ?? null;
        }
        if (!cumulative || !this.matrixOps) {
            return null;
        }

        let cursor = 0;
        for (const clip of timeline.clips) {
            const next = this.matrixOps.multiply(cumulative, clip.matrix);
            if (elapsedSeconds < cursor + clip.duration) {
                const local = (elapsedSeconds - cursor) / clip.duration;
                return interpolateMat4(cumulative, next, Math.min(Math.max(local, 0), 1));
            }
            cursor += clip.duration;
            cumulative = next;
        }

        return cumulative;
    }
}
