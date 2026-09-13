import * as THREE from 'three';
import { RENDER_CONFIG } from '../../config/renderConfig';

export class VectorFieldMesh {
    public group: THREE.Group;

    private shaftInstanced: THREE.InstancedMesh;
    private headInstanced: THREE.InstancedMesh;
    private count: number;
    private readonly threshold = RENDER_CONFIG.vectorFieldMesh.threshold; // 模长小于此值则隐藏该箭头

    // 固定几何参数
    private readonly shaftRadius = RENDER_CONFIG.vectorFieldMesh.shaftRadius;
    private readonly headRadius = RENDER_CONFIG.vectorFieldMesh.headRadius;
    private readonly headLengthRatio = RENDER_CONFIG.vectorFieldMesh.headLengthRatio; // 头部占总长度的比例

    // 临时向量/矩阵/四元数,减少GC
    private readonly direction = new THREE.Vector3();
    private readonly quaternion = new THREE.Quaternion();
    private readonly matrix = new THREE.Matrix4();
    private readonly headMatrix = new THREE.Matrix4();
    private readonly position = new THREE.Vector3();
    private readonly scale = new THREE.Vector3();
    private readonly up = new THREE.Vector3(0, 1, 0);

    constructor(
        positions: Float32Array, // [px0, py0, pz0, ...]
        vectors: Float32Array,   // [vx0, vy0, vz0, ...]
        color: string,
        scale: number
    ) {
        this.count = positions.length / 3;
        if (this.count !== vectors.length / 3) {
            throw new Error('positions and vectors must have the same number of points');
        }

        this.group = new THREE.Group();

        // ---------- 创建几何体(底部在原点,沿 +Y 方向延伸)----------
        // 杆:高为1,半径为 shaftRadius
        const shaftGeo = new THREE.CylinderGeometry(
            1,
            1,
            1,
            RENDER_CONFIG.vectorFieldMesh.radialSegments,
        );
        shaftGeo.translate(0, 0.5, 0); // 底部在原点,顶部在 (0,1,0)

        // 头:高为1,底部半径为 headRadius
        const headGeo = new THREE.ConeGeometry(1, 1, RENDER_CONFIG.vectorFieldMesh.radialSegments);
        headGeo.translate(0, 0.5, 0); // 底部在原点,尖端在 (0,1,0)

        // ---------- 材质 ----------
        const material = new THREE.MeshStandardMaterial({
            color: color,
            roughness: RENDER_CONFIG.vectorFieldMesh.roughness,
            metalness: RENDER_CONFIG.vectorFieldMesh.metalness,
        });

        // ---------- 实例化网格 ----------
        this.shaftInstanced = new THREE.InstancedMesh(shaftGeo, material, this.count);
        this.headInstanced = new THREE.InstancedMesh(headGeo, material, this.count);

        this.group.add(this.shaftInstanced);
        this.group.add(this.headInstanced);

        // 第一次更新
        this.update(positions, vectors, scale);
    }

    /**
     * 更新所有箭头
     * @param positions 网格点坐标
     * @param vectors   向量值
     * @param scale     全局缩放因子(总长度 = 向量模长 × scale)
     */
    public update(positions: Float32Array, vectors: Float32Array, scale: number): void {
        const count = positions.length / 3;
        if (count !== this.count) {
            throw new Error('Number of points cannot change after construction');
        }

        const shaftMatrix = this.matrix;
        const headMatrix = this.headMatrix;
        const dir = this.direction;
        const quat = this.quaternion;
        const pos = this.position;
        const scl = this.scale;

        for (let i = 0; i < count; i++) {
            const i3 = i * 3;
            const vx = vectors[i3];
            const vy = vectors[i3 + 1];
            const vz = vectors[i3 + 2];
            const len = Math.sqrt(vx * vx + vy * vy + vz * vz);

            // 网格点位置
            const px = positions[i3];
            const py = positions[i3 + 1];
            const pz = positions[i3 + 2];

            // 判断是否隐藏(模长 < 阈值)
            const hidden = len < this.threshold;

            // 计算方向(归一化)
            dir.set(vx, vy, vz);
            if (!hidden) {
                dir.divideScalar(len);
                quat.setFromUnitVectors(this.up, dir);
            } else {
                // 隐藏时方向任意,但缩放为0即可
                quat.identity();
            }

            // ---------- 杆 ----------
            const totalLen = len * scale;
            const shaftLen = hidden ? 0 : totalLen * (1 - this.headLengthRatio);
            const headLen = hidden ? 0 : totalLen * this.headLengthRatio;

            // 杆的位置:网格点
            pos.set(px, py, pz);
            // 杆的缩放:(半径, 长度, 半径)
            scl.set(this.shaftRadius, shaftLen, this.shaftRadius);
            shaftMatrix.compose(pos, quat, scl);
            this.shaftInstanced.setMatrixAt(i, shaftMatrix);

            // ---------- 头 ----------
            if (!hidden) {
                // 头的位置:网格点 + 方向 × 杆长
                pos.set(px + dir.x * shaftLen, py + dir.y * shaftLen, pz + dir.z * shaftLen);
                // 头的缩放:(半径, 长度, 半径)
                scl.set(this.headRadius, headLen, this.headRadius);
                headMatrix.compose(pos, quat, scl);
            } else {
                // 隐藏:缩放为0
                scl.set(0, 0, 0);
                pos.set(px, py, pz); // 位置任意
                headMatrix.compose(pos, quat, scl);
            }
            this.headInstanced.setMatrixAt(i, headMatrix);
        }

        // 标记矩阵更新
        this.shaftInstanced.instanceMatrix.needsUpdate = true;
        this.headInstanced.instanceMatrix.needsUpdate = true;
    }

    /**
     * 修改所有箭头的颜色
     */
    public setColor(color: string): void {
        const col = new THREE.Color(color);
        const shaftMat = this.shaftInstanced.material as THREE.MeshStandardMaterial;
        const headMat = this.headInstanced.material as THREE.MeshStandardMaterial;
        shaftMat.color.copy(col);
        headMat.color.copy(col);
    }

    /**
     * 释放GPU资源
     */
    public dispose(): void {
        // 触发 'dispose' 事件,释放 instanceMatrix 对应的 GPU buffer
        this.shaftInstanced.dispose();
        this.headInstanced.dispose();

        // 释放几何体
        this.shaftInstanced.geometry.dispose();
        this.headInstanced.geometry.dispose();

        // 两个实例网格共用同一个 material,只释放一次即可
        (this.shaftInstanced.material as THREE.MeshStandardMaterial).dispose();

        this.group.remove(this.shaftInstanced);
        this.group.remove(this.headInstanced);
    }
}
