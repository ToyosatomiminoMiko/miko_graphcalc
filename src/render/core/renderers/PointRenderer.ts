import * as THREE from 'three';
import type { IRenderer } from './IRenderer';
import type { PointObject } from '../../../compiler/ir/types';

/** 点对象的全局渲染样式,由右侧"点"面板控制. */
export interface PointStyle {
    radius: number;
    visible: boolean;
}

/**
 * 空间点渲染器 -- 小球
 * - 使用单位球,半径通过 scale 控制,避免每次改值重建几何体
 * - draw() 更新 position/color/尺寸,并组合对象与全局可见性
 */
export class PointRenderer implements IRenderer {
    readonly group = new THREE.Group();
    private sphere: THREE.Mesh;
    private material: THREE.MeshPhongMaterial;
    private style: PointStyle;
    /**
     * 对象列表控制的可见性.
     *
     * 可见性只以本字段 + `style.visible` 为准,不再回读 `this.point.enabled`:
     * 对象列表的隐藏是记住在这里的,而 `point` 引用可能指向已过期的对象实例
     * (见 RND-P2.4),回读它会让已隐藏的点在调整"点"面板后复活.
     */
    private userVisible = true;

    constructor(
        private point: PointObject,
        style?: PointStyle,
    ) {
        this.style = style ?? { radius: 0.2, visible: true };
        const geo = new THREE.SphereGeometry(1, 16, 16);
        this.material = new THREE.MeshPhongMaterial({
            color: point.color,
            emissive: 0x000000,
            specular: 0x333333,
            shininess: 40,
        });
        this.sphere = new THREE.Mesh(geo, this.material);
        this.group.add(this.sphere);
        this.userVisible = point.enabled;
    }

    get visible(): boolean {
        return this.userVisible && this.style.visible;
    }

    draw(): void {
        this.sphere.position.set(this.point.x, this.point.y, this.point.z);
        this.material.color.set(this.point.color);
        this.sphere.scale.setScalar(this.style.radius);
        // draw 由对象列表/完整运行驱动,此时 point 引用是最新的,可以采信
        this.userVisible = this.point.enabled;
        this.group.visible = this.visible;
    }

    setVisible(v: boolean): void {
        // 对象列表控制 enabled,这里同步;全局隐藏仍要生效
        this.userVisible = v;
        this.group.visible = this.visible;
    }

    /** 应用全局点样式(尺寸/可见性)并立即刷新 */
    setStyle(style: PointStyle): void {
        this.style = style;
        this.sphere.scale.setScalar(style.radius);
        // 复用同一份 userVisible,不重新从 this.point 推导(否则隐藏态丢失)
        this.group.visible = this.visible;
    }

    updateRef(point: PointObject): void {
        this.point = point;
    }

    dispose(): void {
        this.sphere.geometry.dispose();
        this.material.dispose();
    }
}
