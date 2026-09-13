import * as THREE from 'three';
import { RENDER_CONFIG } from '../../config/renderConfig';

/**
 * 共享的体积几何 / 材质工具.
 *
 * 积分可视化和体积对象都使用这里的材质与线框策略,避免两边各自维护一套
 * 透明度/edge/dispose 代码.这里不包含任何 DSL / IR 类型,只接受数值.
 */

const VOLUME_RENDER_CONFIG = RENDER_CONFIG.volume;

/**
 * 创建半透明实体材质.
 *
 * opacity < 1 时关闭深度写入,避免透明面互相遮挡出现黑块;opacity === 1
 * 时打开深度写入,保证完全不透明物体有正确的遮挡关系.
 */
export function createSolidMaterial(
    color: string | THREE.Color,
    opacity: number,
): THREE.MeshPhongMaterial {
    return new THREE.MeshPhongMaterial({
        color,
        transparent: opacity < 1,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: opacity >= 1,
        emissive: 0x000000,
        specular: 0x222244,
        shininess: 30,
    });
}

/** 创建线框材质,透明度默认低于实体面,只起结构提示作用. */
export function createSolidEdgeMaterial(
    color: string | THREE.Color,
    opacity: number,
): THREE.LineBasicMaterial {
    return new THREE.LineBasicMaterial({
        color,
        transparent: opacity < 1,
        opacity,
    });
}

/** 轴对齐方块几何体;大小由三轴半长乘 2 得到完整尺寸. */
export function buildBoxGeometry(size: [number, number, number]): THREE.BoxGeometry {
    return new THREE.BoxGeometry(size[0], size[1], size[2]);
}

/** 球体几何体,segments 是经/纬分段数. */
export function buildSphereGeometry(
    radius: number,
    segments: number,
): THREE.SphereGeometry {
    return new THREE.SphereGeometry(radius, segments, segments);
}

/**
 * 旋转体几何体.
 *
 * Three.js 的 CylinderGeometry 同时覆盖圆柱/圆锥和圆台:
 * radiusTop / radiusBottom 分别对应上底/下底半径,且几何中心位于高度中点.
 */
export function buildConicGeometry(
    baseRadius: number,
    topRadius: number,
    height: number,
    segments: number,
): THREE.CylinderGeometry {
    return new THREE.CylinderGeometry(topRadius, baseRadius, height, segments, 1, true);
}

/**
 * 给一个 BufferGeometry 增加线框,并把实体与线框放进同一个 Group.
 *
 * 这样单个体积对象在场景里始终是一个 `IRenderer.group` 下的可整体控制对象.
 */
export function wrapSolid(
    geometry: THREE.BufferGeometry,
    color: string | THREE.Color,
    opacity: number,
    edgeOpacity = VOLUME_RENDER_CONFIG.defaultEdgeOpacity,
): THREE.Group {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(geometry, createSolidMaterial(color, opacity));
    const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 30),
        createSolidEdgeMaterial(color, edgeOpacity),
    );
    group.add(mesh, edges);
    return group;
}

/** 递归释放 Group 内所有 Mesh / Line 的 GPU 资源. */
export function disposeSolidGroup(group: THREE.Object3D): void {
    group.traverse((node) => {
        if (node instanceof THREE.Mesh || node instanceof THREE.Line) {
            node.geometry?.dispose();
            const material = node.material;
            if (Array.isArray(material)) {
                material.forEach((entry) => entry.dispose());
            } else {
                material?.dispose();
            }
        }
    });
}
