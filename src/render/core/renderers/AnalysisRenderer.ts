/**
 * 分析结果渲染器.
 * 从 DslApp 拆出,负责把 gradient/divergence/curl 的点/法向,一元求导的
 * 切线(show = tangent)和曲面的切平面(show = tangent_plane)渲染到独立
 * THREE.Group.
 *
 * "点"在这里只有一处来源:测量点(导/偏导/散度/旋度里 show = point 的
 * 黄色圆点)直接实例化 PointRenderer 绘制 -- 与场景 point 对象共用
 * 几何/材质/缩放定义,并跟随右侧"点"面板的全局半径/可见样式.
 * 本类不再自建任何点几何体(旧的独立 SphereGeometry 已移除).
 */
import * as THREE from 'three';
import type { AnalysisResult, PointObject } from '../../../compiler/ir/types';
import { RENDER_CONFIG } from '../../../config/renderConfig';
import { PointRenderer, type PointStyle } from './PointRenderer';

/** 分析测量点颜色(黄),与 docs/derivatives-guide.md 描述的"黄色圆点"一致. */
const ANALYSIS_POINT_COLOR = '#ffdd44';

export class AnalysisRenderer {
    readonly group = new THREE.Group();

    /**
     * 当前挂载的分析测量点渲染器.
     *
     * render() 每次整体重建;但两次 render 之间拖动"点"面板时,
     * setPointStyle() 必须即时作用到已在场景里的测量点,因此单独登记
     * 这些 PointRenderer 实例.
     */
    private readonly markers: PointRenderer[] = [];

    /**
     * 与场景 point 对象共用同一份全局点样式.缺省值同
     * RENDER_CONFIG.scene.point(与 Plotter/PointRenderer 的初始样式一致),
     * 之后由 RenderController 在 'point:changed' 时推送 setPointStyle.
     */
    private pointStyle: PointStyle = {
        radius: RENDER_CONFIG.scene.point.radius,
        visible: RENDER_CONFIG.scene.point.visible,
    };

    /** 应用"点"面板的全局样式(半径/可见)到当前已挂载的测量点. */
    setPointStyle(style: PointStyle): void {
        this.pointStyle = { ...style };
        for (const marker of this.markers) {
            marker.setStyle(this.pointStyle);
        }
    }

    render(analyses: AnalysisResult[]): void {
        this.clear();

        for (const analysis of analyses) {
            const point = new THREE.Vector3(...analysis.point);
            const vector = new THREE.Vector3(...analysis.vector);

            if (analysis.show.includes('point')) {
                this._addMarker(analysis.point);
            }

            if (
                analysis.show.includes('normal')
                && vector.lengthSq() > RENDER_CONFIG.analysis.tolerance
            ) {
                const direction = vector.clone().normalize();
                const arrow = new THREE.ArrowHelper(
                    direction,
                    point,
                    RENDER_CONFIG.analysis.arrowLength,
                    0xff6b8a,
                    RENDER_CONFIG.analysis.arrowHeadLength,
                    RENDER_CONFIG.analysis.arrowHeadWidth,
                );
                this.group.add(arrow);
            }

            if (
                analysis.show.includes('tangent')
                && analysis.op === 'gradient'
                && analysis.tangent
            ) {
                // 一元曲线求导的切线:IR 里方向 = (1, f', 0),故 tangentHalfLength
                // 即 x 向半长;端点 = 分析点 ± half × 切向,斜率越大 Δy 越大.
                // 只对 curve 源 gradient 有效(此时 tangent 非 null),其余分析不画.
                const tangent = new THREE.Vector3(...analysis.tangent);
                const half = RENDER_CONFIG.analysis.tangentHalfLength;
                const tangentLine = new THREE.Line(
                    new THREE.BufferGeometry().setFromPoints([
                        point.clone().addScaledVector(tangent, -half),
                        point.clone().addScaledVector(tangent, half),
                    ]),
                    new THREE.LineBasicMaterial({
                        color: 0x6bffb8,
                        transparent: true,
                        opacity: 0.95,
                    }),
                );
                this.group.add(tangentLine);
            }

            if (analysis.show.includes('tangent_plane') && analysis.op === 'gradient') {
                const normal = vector.lengthSq() > RENDER_CONFIG.analysis.tolerance
                    ? vector.clone().normalize()
                    : new THREE.Vector3(0, 0, 1);
                const plane = new THREE.Mesh(
                    new THREE.PlaneGeometry(
                        RENDER_CONFIG.analysis.tangentPlaneSize,
                        RENDER_CONFIG.analysis.tangentPlaneSize,
                    ),
                    new THREE.MeshPhongMaterial({
                        color: 0x44aaff,
                        side: THREE.DoubleSide,
                        transparent: true,
                        opacity: RENDER_CONFIG.analysis.tangentPlaneOpacity,
                        depthWrite: false,
                    }),
                );
                plane.position.copy(point);
                plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
                this.group.add(plane);
            }
        }
    }

    /**
     * 测量点 = 一个 PointRenderer 实例:除固定黄色外,几何/材质/缩放与
     * 场景 point 对象完全同源(唯一定义见 PointRenderer.ts),显隐跟随
     * enabled(= true,调用方已过滤)与全局点样式的 visible.
     */
    private _addMarker(p: [number, number, number]): void {
        const marker = new PointRenderer(this._markerPoint(p), this.pointStyle);
        marker.draw();
        this.group.add(marker.group);
        this.markers.push(marker);
    }

    /** PointRenderer 只消费 x/y/z/color/enabled,喂给它最小 PointObject. */
    private _markerPoint(p: [number, number, number]): PointObject {
        return {
            kind: 'point',
            id: -1,
            expr: '',
            x: p[0],
            y: p[1],
            z: p[2],
            color: ANALYSIS_POINT_COLOR,
            enabled: true,
        };
    }

    clear(): void {
        this.markers.length = 0;
        for (const child of [...this.group.children]) {
            this.group.remove(child);
            child.traverse((node) => {
                if (node instanceof THREE.Mesh || node instanceof THREE.Line) {
                    node.geometry?.dispose();
                    if (Array.isArray(node.material)) {
                        node.material.forEach((material) => material.dispose());
                    } else {
                        node.material?.dispose();
                    }
                }
            });
        }
    }

    dispose(): void {
        this.clear();
    }
}
