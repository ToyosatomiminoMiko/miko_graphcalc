import * as THREE from 'three';
import type { IRenderer } from './IRenderer';
import type {
    BoxObject,
    ConicSolidObject,
    SphereObject,
} from '../../../compiler/ir/types';
import {
    buildBoxGeometry,
    buildConicGeometry,
    buildSphereGeometry,
    disposeSolidGroup,
    wrapSolid,
} from '../../visualization/solidPrimitives';

/**
 * 球体 / 方块 / 旋转体的统一渲染器.
 *
 * 圆柱/圆锥/圆台在 IR 中都收敛成 `ConicSolidObject`,因此这里只用一种
 * `conic` 分支;三种形体的区别完全由 baseRadius/topRadius/height 决定.
 */
export type SolidObject = SphereObject | BoxObject | ConicSolidObject;

export class SolidRenderer implements IRenderer {
    readonly group = new THREE.Group();

    private content: THREE.Group | null = null;
    private userVisible = true;

    constructor(private solid: SolidObject) {
        this.rebuild();
    }

    get visible(): boolean {
        return this.userVisible && this.solid.enabled;
    }

    draw(): void {
        this.rebuild();
        this.group.visible = this.visible;
    }

    setVisible(value: boolean): void {
        this.userVisible = value;
        this.group.visible = this.visible;
    }

    updateRef(solid: SolidObject): void {
        this.solid = solid;
    }

    dispose(): void {
        this.clearContent();
    }

    private clearContent(): void {
        if (!this.content) return;
        this.group.remove(this.content);
        disposeSolidGroup(this.content);
        this.content = null;
    }

    private rebuild(): void {
        this.clearContent();

        const solid = this.solid;
        let geometry: THREE.BufferGeometry;

        switch (solid.kind) {
            case 'sphere':
                geometry = buildSphereGeometry(solid.radius, solid.segments);
                break;
            case 'box':
                geometry = buildBoxGeometry(solid.size);
                break;
            case 'conic':
                geometry = buildConicGeometry(
                    solid.baseRadius,
                    solid.topRadius,
                    solid.height,
                    solid.segments,
                );
                break;
        }

        const content = wrapSolid(geometry, solid.color, solid.opacity);
        content.position.set(solid.position.x, solid.position.y, solid.position.z);
        this.group.add(content);
        this.content = content;
    }
}
