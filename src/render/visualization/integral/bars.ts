// ============================================================
// integral/bars.ts - 积分可视化柱条的无状态构建工具
//
// 柱条(BarDef)是黎曼 / 勒贝格 / 3D 实体体元共用的最小渲染单元,
// 本文件只承载与场景,缓存无关的纯构建逻辑:
//   - createInstancedBarGroup: 用 InstancedMesh 批量渲染柱条(+ 可选线框)
//   - layerLoop:              勒贝格分层扫描的公共循环(正部从 0 向上,负部向下)
//   - disposeObjectGroup:     本簇各类 group 的统一 GPU 资源释放
// 共享单位立方体/线框几何(只读,随页面存活)也收在这里.
// 不依赖 IntegralVisualizer,仅由它调用.
// ============================================================
import * as THREE from 'three';
import {
    createSolidEdgeMaterial,
    createSolidMaterial,
} from '../solidPrimitives';

/**
 * @cache
 * 缓存目的:所有积分柱条共享同一个单位立方体及其线框几何体,避免重复分配.
 * 键/失效策略:只读共享资源,不失效.
 * 生命周期:模块级,随页面存活.
 */
const SHARED_BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);
const SHARED_EDGE_GEOMETRY = new THREE.EdgesGeometry(SHARED_BOX_GEOMETRY);

/** 单个柱条的实例数据. */
export interface BarDef {
    pos: [number, number, number];
    scale: [number, number, number];
    color: THREE.Color;
}

export interface BarOptions {
    opacity?: number;
    color?: THREE.Color;
    edgeOpacity?: number;
    edgeColor?: THREE.Color;
}

/** 分层循环中每一层的柱条生成回调. */
export type LayerCallback = (
    threshold: number,
    centerY: number,
    k: number,
    color: THREE.Color,
    dy: number,
) => BarDef[] | undefined;

/**
 * 用 InstancedMesh 批量渲染柱条(减少 draw call).
 * 纯函数:不触碰场景/缓存,结果由调用方挂载与登记.
 */
export function createInstancedBarGroup(
    bars: BarDef[],
    opts: BarOptions = {},
): THREE.Group {
    const { opacity, color, edgeOpacity, edgeColor } = opts;
    const mat = createSolidMaterial(
        color ?? new THREE.Color(0xffffff),
        opacity ?? 0.6,
    );

    const mesh = new THREE.InstancedMesh(SHARED_BOX_GEOMETRY, mat, bars.length);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        dummy.position.set(b.pos[0], b.pos[1], b.pos[2]);
        dummy.scale.set(b.scale[0], b.scale[1], b.scale[2]);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, b.color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true;
    }

    const group = new THREE.Group();
    group.add(mesh);

    // 可选线框
    if (edgeOpacity && edgeOpacity > 0) {
        const edgeMat = createSolidEdgeMaterial(
            edgeColor ?? color ?? new THREE.Color(0xffffff),
            edgeOpacity,
        );
        const wireMesh = new THREE.InstancedMesh(SHARED_EDGE_GEOMETRY, edgeMat, bars.length);
        for (let i = 0; i < bars.length; i++) {
            const b = bars[i];
            dummy.position.set(b.pos[0], b.pos[1], b.pos[2]);
            dummy.scale.set(b.scale[0], b.scale[1], b.scale[2]);
            dummy.updateMatrix();
            wireMesh.setMatrixAt(i, dummy.matrix);
        }
        wireMesh.instanceMatrix.needsUpdate = true;
        group.add(wireMesh);
    }

    return group;
}

/**
 * 分层循环工具:正部从 0 向上,负部从 0 向下.
 * 生成器无关:每层如何产出柱条完全由 `callback` 决定(2D 区间扫描/3D 格点扫描).
 */
export function layerLoop(
    yMin: number,
    yMax: number,
    layers: number,
    baseColor: THREE.Color,
    blueTint: number,
    callback: LayerCallback,
): BarDef[] {
    const bars: BarDef[] = [];

    // 正部:从 0 向上
    if (yMax > 1e-12) {
        const dy = yMax / layers;
        if (dy >= 1e-12) {
            for (let k = 0; k < layers; k++) {
                const threshold = k * dy;
                const center = (threshold + (k + 1) * dy) / 2;
                const c = baseColor.clone().lerp(
                    new THREE.Color(0xffffff),
                    (k / layers) * 0.5,
                );
                const layerBars = callback(threshold, center, k, c, dy);
                if (layerBars) bars.push(...layerBars);
            }
        }
    }

    // 负部:从 0 向下
    if (yMin < -1e-12) {
        const dy = -yMin / layers;
        if (dy >= 1e-12) {
            for (let k = 0; k < layers; k++) {
                const threshold = k * dy;
                const center = -(threshold + (k + 1) * dy) / 2;
                const c = baseColor.clone()
                    .lerp(new THREE.Color(0xffffff), (k / layers) * 0.5);
                if (blueTint > 0) {
                    c.lerp(new THREE.Color(0x4488ff), blueTint);
                }
                const layerBars = callback(threshold, center, k, c, dy);
                if (layerBars) bars.push(...layerBars);
            }
        }
    }

    return bars;
}

/**
 * 递归释放 Group 中所有 Mesh 的 GPU 资源.
 *
 * InstancedMesh 分支特殊:geometry 是模块级共享的单位立方体,不能 dispose,
 * 只释放它自己的 instanceMatrix/instanceColor 与材质.
 */
export function disposeObjectGroup(group: THREE.Object3D): void {
    group.traverse((node) => {
        if (node instanceof THREE.InstancedMesh) {
            node.dispose();
            if (Array.isArray(node.material)) {
                node.material.forEach(m => m.dispose());
            } else {
                node.material?.dispose();
            }
        } else if (node instanceof THREE.Mesh) {
            node.geometry?.dispose();
            if (Array.isArray(node.material)) {
                node.material.forEach(m => m.dispose());
            } else {
                node.material?.dispose();
            }
        } else if (node instanceof THREE.Line) {
            node.geometry?.dispose();
            if (Array.isArray(node.material)) {
                node.material.forEach(m => m.dispose());
            } else {
                node.material?.dispose();
            }
        }
    });
}
