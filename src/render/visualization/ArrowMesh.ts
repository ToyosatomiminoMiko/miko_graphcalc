import * as THREE from 'three';
import { RENDER_CONFIG } from '../../config/renderConfig';

/**
 * ArrowMesh — 3D 箭头封装
 *
 * 内部由圆柱体(杆)和圆锥体(头)组成,统一挂在一个 Group 下
 * 外部通过 setTransform 设置起点和方向,自动计算缩放/旋转
 *
 * 默认参数:
 *   杆半径   0.08
 *   头部半径 0.2
 *   头部长度 0.4
 *   默认颜色 #ffffff
 */
export class ArrowMesh {
    group: THREE.Group;
    private _shaft: THREE.Mesh;
    private _head: THREE.Mesh;
    private _shaftMaterial: THREE.MeshPhongMaterial;
    private _headMaterial: THREE.MeshPhongMaterial;

    // 预分配的向量,避免在 setTransform 循环中 new
    private _tempDir: THREE.Vector3;
    private _tempUp: THREE.Vector3;

    constructor(color: string = '#ffffff') {
        this.group = new THREE.Group();

        // ---------- 杆 ----------
        const shaftGeo = new THREE.CylinderGeometry(
            RENDER_CONFIG.arrowMesh.shaftRadius,
            RENDER_CONFIG.arrowMesh.shaftRadius,
            1,
            RENDER_CONFIG.arrowMesh.radialSegments,
        );
        this._shaftMaterial = new THREE.MeshPhongMaterial({
            color,
            emissive: 0x000000,
            specular: 0x222222,
            shininess: 30,
        });
        this._shaft = new THREE.Mesh(shaftGeo, this._shaftMaterial);
        // 默认 CylinderGeometry 中心在原点,高度为 1,Y 轴方向
        this.group.add(this._shaft);

        // ---------- 头 ----------
        const headGeo = new THREE.ConeGeometry(
            RENDER_CONFIG.arrowMesh.headRadius,
            RENDER_CONFIG.arrowMesh.headLength,
            RENDER_CONFIG.arrowMesh.radialSegments,
        );
        this._headMaterial = new THREE.MeshPhongMaterial({
            color,
            emissive: 0x000000,
            specular: 0x222222,
            shininess: 30,
        });
        this._head = new THREE.Mesh(headGeo, this._headMaterial);
        // 默认 ConeGeometry 尖端在 +Y,底部中心在 -Y/2
        this.group.add(this._head);

        // 预分配
        this._tempDir = new THREE.Vector3();
        this._tempUp = new THREE.Vector3(0, 1, 0);
    }

    /**
     * 核心方法:设置箭头的起点和方向
     * @param origin    起点世界坐标
     * @param direction 方向向量(同时决定长度)
     */
    setTransform(origin: THREE.Vector3, direction: THREE.Vector3): void {
        const length = direction.length();
        if (length < RENDER_CONFIG.arrowMesh.zeroLengthThreshold) {
            // 零长度:隐藏箭头
            this.group.visible = false;
            return;
        }
        this.group.visible = true;

        const headLength = RENDER_CONFIG.arrowMesh.headLength;       // 头部高度(沿箭头方向)
        const shaftLength = Math.max(0, length - headLength);

        // 1. 杆缩放:Y 轴方向拉伸到 shaftLength
        this._shaft.scale.set(1, shaftLength, 1);
        // 杆中心偏移到 shaftLength/2 处(沿局部 Y 轴)
        this._shaft.position.set(0, shaftLength / 2, 0);

        // 2. 头部放在方向末端
        // 圆锥尖端在 +Y,底部在 -Y,默认长度 0.4,中心在 -0.2
        // 我们要把圆锥尖端放在 direction 末端,即底部在 length - headLength 处
        this._head.position.set(0, shaftLength + headLength / 2, 0);

        // 3. 旋转整个 Group 使局部 Y 轴对齐 direction
        this._tempDir.copy(direction).normalize();
        const quaternion = new THREE.Quaternion().setFromUnitVectors(
            this._tempUp,
            this._tempDir,
        );
        this.group.quaternion.copy(quaternion);

        // 4. 设置位置
        this.group.position.copy(origin);
    }

    /** 设置颜色 */
    setColor(color: string): void {
        this._shaftMaterial.color.set(color);
        this._headMaterial.color.set(color);
    }

    /** 设置自发光强度(用于选中高亮,0 为无发光,通常 0.3-0.5) */
    setEmissive(intensity: number): void {
        const emissive = new THREE.Color().setScalar(intensity);
        this._shaftMaterial.emissive.copy(emissive);
        this._headMaterial.emissive.copy(emissive);
    }

    /** 释放 GPU 资源 */
    dispose(): void {
        this._shaft.geometry.dispose();
        this._head.geometry.dispose();
        this._shaftMaterial.dispose();
        this._headMaterial.dispose();
        this.group.remove(this._shaft);
        this.group.remove(this._head);
    }
}
