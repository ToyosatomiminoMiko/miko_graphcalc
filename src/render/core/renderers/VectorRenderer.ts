import * as THREE from 'three';
import type { IRenderer } from './IRenderer';
import type { VectorObject } from '../../../compiler/ir/types';
import { ArrowMesh } from '../../visualization/ArrowMesh';

/**
 * 空间向量渲染器
 * - ArrowMesh 内部管理圆柱+圆锥子物体
 * - draw() 仅更新 transform 和颜色
 */
export class VectorRenderer implements IRenderer {
    readonly group: THREE.Group;
    private arrow: ArrowMesh;

    constructor(private vector: VectorObject) {
        this.arrow = new ArrowMesh(vector.color);
        this.group = this.arrow.group;
    }

    get visible(): boolean {
        return this.vector.enabled;
    }

    draw(): void {
        const origin = new THREE.Vector3(
            this.vector.origin.x,
            this.vector.origin.y,
            this.vector.origin.z,
        );
        const direction = new THREE.Vector3(
            this.vector.direction.x,
            this.vector.direction.y,
            this.vector.direction.z,
        );

        this.arrow.setTransform(origin, direction);
        this.arrow.setColor(this.vector.color);
        this.group.visible = this.visible;
    }

    setVisible(v: boolean): void {
        this.group.visible = v;
    }

    updateRef(vector: VectorObject): void {
        this.vector = vector;
    }

    dispose(): void {
        this.arrow.dispose();
    }
}
