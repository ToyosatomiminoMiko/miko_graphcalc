import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { RENDER_CONFIG } from '../../config/renderConfig';
import { formatTickLabel } from './tickLabel';
import {
    positiveStepPositions,
    resolveGridSteps,
    stepCount,
    type GridSteps,
} from './axisSteps';

type AxisName = 'x' | 'y' | 'z';
type GridPlane = 'xz' | 'xy' | 'yz';

/**
 * 场景管理器 - 负责创建场景,渲染器,灯光,坐标轴等基础元素
 * CameraManager 通过注入 SceneManager 获取 renderer 引用
 */
export class SceneManager {
    container: HTMLElement;
    scene: THREE.Scene;
    renderer: THREE.WebGLRenderer;
    /** 三个坐标平面网格,各自独立显隐 */
    private readonly planeGroups: Record<GridPlane, THREE.Group> = {
        xz: new THREE.Group(),
        xy: new THREE.Group(),
        yz: new THREE.Group(),
    };
    /** 各坐标平面网格的当前可见性,重建网格(切换 π 单位)时沿用 */
    private readonly planeVisible: Record<GridPlane, boolean> = {
        xz: RENDER_CONFIG.scene.grid.planes.xz,
        xy: RENDER_CONFIG.scene.grid.planes.xy,
        yz: RENDER_CONFIG.scene.grid.planes.yz,
    };
    private readonly tickGroup = new THREE.Group();
    /** Line2 坐标轴材质,resize 时同步分辨率,线宽变化时统一更新 */
    private readonly axisLineMaterials: LineMaterial[] = [];
    /** 所有 Line2/LineSegments2 材质,resize 时统一同步分辨率 */
    private readonly resolutionMaterials: LineMaterial[] = [];
    /** 网格/坐标轴刻度线材质:构造时创建一次,切换 π 单位重建几何时复用 */
    private gridMajorMaterial!: LineMaterial;
    private gridMinorMaterial!: LineMaterial;
    private tickMajorMaterial!: LineMaterial;
    private tickMinorMaterial!: LineMaterial;
    /** 各轴标签 Sprite */
    private readonly axisLabels: Partial<Record<AxisName, THREE.Sprite>> = {};
    /** 各轴刻度数字 Sprite,随对应轴标签一起显隐 */
    private readonly axisTickNumbers: Record<AxisName, THREE.Sprite[]> = {
        x: [],
        y: [],
        z: [],
    };
    /** 各轴标签/刻度数字的当前可见性,重建刻度数字时沿用(不从配置重读) */
    private readonly axisLabelVisible: Record<AxisName, boolean> = {
        x: RENDER_CONFIG.scene.axisLabels.x,
        y: RENDER_CONFIG.scene.axisLabels.y,
        z: RENDER_CONFIG.scene.axisLabels.z,
    };
    /** 刻度数字是否使用 π 单位显示(开关状态) */
    private piUnit = RENDER_CONFIG.scene.axisTicks.piUnit;

    constructor(container: HTMLElement) {
        this.container = container;

        // --- 场景 ---
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(RENDER_CONFIG.scene.background);

        // --- 光源 ---
        const ambientLight = new THREE.AmbientLight(0x404060);
        this.scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1);
        dirLight.position.set(5, 10, 7);
        this.scene.add(dirLight);

        // --- 渲染器 ---
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.appendChild(this.renderer.domElement);

        // --- 辅助元素 ---
        // XYZ 坐标轴改用 Line2 绘制,支持像素线宽
        this.createAxisLine(
            [0, 0, 0],
            [RENDER_CONFIG.scene.axesLength, 0, 0],
            RENDER_CONFIG.scene.axisColors.x,
        );
        this.createAxisLine(
            [0, 0, 0],
            [0, RENDER_CONFIG.scene.axesLength, 0],
            RENDER_CONFIG.scene.axisColors.y,
        );
        this.createAxisLine(
            [0, 0, 0],
            [0, 0, RENDER_CONFIG.scene.axesLength],
            RENDER_CONFIG.scene.axisColors.z,
        );

        // 大/小刻度网格 + 坐标轴刻度
        this.createGridMaterials();
        this.buildGridAndTicks();
        this.scene.add(
            this.planeGroups.xz,
            this.planeGroups.xy,
            this.planeGroups.yz,
        );
        this.scene.add(this.tickGroup);
        for (const plane of ['xz', 'xy', 'yz'] as const) {
            this.planeGroups[plane].visible = this.planeVisible[plane];
        }
        this.tickGroup.visible = RENDER_CONFIG.scene.axisTicks.visible;

        // XYZ 轴标签(使用 Sprite)
        const axisLen = RENDER_CONFIG.scene.axisLabelLength;
        const axisLabel = (
            axis: AxisName,
            text: string,
            position: THREE.Vector3,
            color: string,
        ): void => {
            const sprite = this.createTextSprite(text, color);
            sprite.position.copy(position);
            sprite.visible = RENDER_CONFIG.scene.axisLabels[axis];
            this.axisLabels[axis] = sprite;
            this.scene.add(sprite);
        };
        // X 红色 | Y 绿色 | Z 蓝色 与 AxesHelper 配色一致
        axisLabel('x', 'X', new THREE.Vector3(axisLen, 0, 0), RENDER_CONFIG.scene.axisColors.x);
        axisLabel('y', 'Y', new THREE.Vector3(0, axisLen, 0), RENDER_CONFIG.scene.axisColors.y);
        axisLabel('z', 'Z', new THREE.Vector3(0, 0, axisLen), RENDER_CONFIG.scene.axisColors.z);
    }

    getScene(): THREE.Scene {
        return this.scene;
    }

    getRenderer(): THREE.WebGLRenderer {
        return this.renderer;
    }

    /** 设置坐标轴线宽(像素) */
    setAxisLineWidth(width: number): void {
        const clamped = Math.max(1, width);
        for (const material of this.axisLineMaterials) {
            material.linewidth = clamped;
        }
    }

    /** 设置某个坐标平面网格的可见性 */
    setPlaneVisible(plane: GridPlane, visible: boolean): void {
        this.planeVisible[plane] = visible;
        this.planeGroups[plane].visible = visible;
    }

    /** 设置坐标轴刻度可见性 */
    setTicksVisible(visible: boolean): void {
        this.tickGroup.visible = visible;
    }

    /**
     * 切换坐标轴的显示单位.
     *
     * - `false`(默认):普通数值,网格/刻度按配置的整数步长;
     * - `true`:π 单位,网格/刻度改按 π(大刻度)/ π/2(小刻度)重排,
     *   刻度数字显示为 π 的整数/简单分数倍(π/2,π,3π/2 ...).
     * 步长变了整张网格都要重建,并保留当前的网格/刻度/标签开关状态.
     */
    setTickUnit(piUnit: boolean): void {
        if (this.piUnit === piUnit) return;
        this.piUnit = piUnit;
        this.buildGridAndTicks();
    }

    /** 设置大/小刻度线宽(像素),同时作用于网格线和坐标轴刻度 */
    setGridLineWidths(majorWidth: number, minorWidth: number): void {
        const major = Math.max(1, majorWidth);
        const minor = Math.max(0.5, minorWidth);
        this.gridMajorMaterial.linewidth = major;
        this.gridMinorMaterial.linewidth = minor;
        this.tickMajorMaterial.linewidth = major;
        this.tickMinorMaterial.linewidth = minor;
    }

    /** 设置某条轴的标签可见性,同时隐藏/显示该轴的刻度数字 */
    setAxisLabelVisible(axis: AxisName, visible: boolean): void {
        this.axisLabelVisible[axis] = visible;
        const label = this.axisLabels[axis];
        if (label) label.visible = visible;
        for (const sprite of this.axisTickNumbers[axis]) {
            sprite.visible = visible;
        }
    }

    render(camera: THREE.Camera): void {
        this.renderer.render(this.scene, camera);
    }

    resize(): { width: number; height: number } {
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        this.renderer.setSize(width, height);
        for (const material of this.resolutionMaterials) {
            material.resolution.set(width, height);
        }
        return { width, height };
    }

    /** 创建网格/刻度共用的四个 Line2 材质(只创建一次,线宽/分辨率更新不丢). */
    private createGridMaterials(): void {
        const { grid, axisTicks } = RENDER_CONFIG.scene;
        const makeMaterial = (color: number, linewidth: number): LineMaterial => {
            const material = new LineMaterial({
                color,
                linewidth,
                resolution: new THREE.Vector2(
                    this.container.clientWidth,
                    this.container.clientHeight,
                ),
            });
            this.resolutionMaterials.push(material);
            return material;
        };

        this.gridMajorMaterial = makeMaterial(grid.majorColor, grid.majorLineWidth);
        this.gridMinorMaterial = makeMaterial(grid.minorColor, grid.minorLineWidth);
        this.tickMajorMaterial = makeMaterial(axisTicks.color, grid.majorLineWidth);
        this.tickMinorMaterial = makeMaterial(axisTicks.color, grid.minorLineWidth);
    }

    /**
     * 构建大/小刻度网格和 XYZ 轴刻度线 + 刻度数字.
     *
     * - 大刻度:较粗,较亮,每 majorEvery 个小刻度一条;
     * - 小刻度:较细,较暗,按 minorStep 间隔;
     * - 位置用整数索引 × minorStep 计算,π 步长下大刻度正好落在 π 的整数倍上.
     *
     * 普通模式与 π 单位模式只是步长不同,共用这一条构建路径;切换单位时
     * 先清空旧几何再重建,平面/整组刻度的可见性由调用方状态决定,不在这里重置.
     */
    private buildGridAndTicks(): void {
        this.clearGridAndTicks();

        const { grid, axisTicks } = RENDER_CONFIG.scene;
        const half = grid.size / 2;
        const { minorStep, majorEvery } = this.activeSteps();
        const gridLineCount = stepCount(minorStep, half);

        // --- 三个坐标平面的网格线(XZ/XY/YZ,大/小刻度同风格)---
        for (const plane of ['xz', 'xy', 'yz'] as const) {
            const majorSegments: number[] = [];
            const minorSegments: number[] = [];
            for (let k = -gridLineCount; k <= gridLineCount; k += 1) {
                const v = k * minorStep;
                const target = k % majorEvery === 0 ? majorSegments : minorSegments;
                if (plane === 'xz') {
                    // y=0:沿 Z 方向与沿 X 方向各一条
                    target.push(v, 0, -half, v, 0, half);
                    target.push(-half, 0, v, half, 0, v);
                } else if (plane === 'xy') {
                    // z=0:沿 Y 方向与沿 X 方向各一条
                    target.push(v, -half, 0, v, half, 0);
                    target.push(-half, v, 0, half, v, 0);
                } else {
                    // x=0:沿 Z 方向与沿 Y 方向各一条
                    target.push(0, v, -half, 0, v, half);
                    target.push(0, -half, v, 0, half, v);
                }
            }
            if (majorSegments.length) {
                const geometry = new LineSegmentsGeometry();
                geometry.setPositions(majorSegments);
                this.planeGroups[plane].add(
                    new LineSegments2(geometry, this.gridMajorMaterial),
                );
            }
            if (minorSegments.length) {
                const geometry = new LineSegmentsGeometry();
                geometry.setPositions(minorSegments);
                this.planeGroups[plane].add(
                    new LineSegments2(geometry, this.gridMinorMaterial),
                );
            }
        }

        // --- 坐标轴刻度线 ---
        const axisLength = RENDER_CONFIG.scene.axesLength;
        const tickMajorSegments: number[] = [];
        const tickMinorSegments: number[] = [];
        const tickPositions = positiveStepPositions(minorStep, axisLength);
        tickPositions.forEach((pos, index) => {
            const isMajor = (index + 1) % majorEvery === 0;
            const length = isMajor ? axisTicks.majorLength : axisTicks.minorLength;
            const halfLen = length / 2;
            const target = isMajor ? tickMajorSegments : tickMinorSegments;
            // X 轴刻度沿 Z 方向;Y/Z 轴刻度沿 X 方向
            target.push(pos, 0, -halfLen, pos, 0, halfLen);
            target.push(-halfLen, pos, 0, halfLen, pos, 0);
            target.push(-halfLen, 0, pos, halfLen, 0, pos);
        });
        if (tickMajorSegments.length) {
            const geometry = new LineSegmentsGeometry();
            geometry.setPositions(tickMajorSegments);
            this.tickGroup.add(new LineSegments2(geometry, this.tickMajorMaterial));
        }
        if (tickMinorSegments.length) {
            const geometry = new LineSegmentsGeometry();
            geometry.setPositions(tickMinorSegments);
            this.tickGroup.add(new LineSegments2(geometry, this.tickMinorMaterial));
        }

        // --- 刻度数字(与 XYZ 轴标签共用字体/画布尺寸/缩放)---
        this.buildTickNumbers(tickPositions);
    }

    /** 当前生效的步长:普通整数步长或 π / π/2(由 π 单位开关决定). */
    private activeSteps(): GridSteps {
        return resolveGridSteps(RENDER_CONFIG.scene.grid, this.piUnit);
    }

    /**
     * 清空网格/刻度几何与刻度数字 Sprite.
     * 材质保留(线宽/分辨率设置不丢),只销毁随步长变化的几何与文字贴图.
     */
    private clearGridAndTicks(): void {
        for (const plane of ['xz', 'xy', 'yz'] as const) {
            const group = this.planeGroups[plane];
            for (const child of [...group.children]) {
                group.remove(child);
                if (child instanceof LineSegments2) child.geometry.dispose();
            }
        }
        for (const child of [...this.tickGroup.children]) {
            this.tickGroup.remove(child);
            if (child instanceof LineSegments2) {
                child.geometry.dispose();
            } else if (child instanceof THREE.Sprite) {
                child.material.map?.dispose();
                child.material.dispose();
            }
        }
        for (const axis of ['x', 'y', 'z'] as const) {
            this.axisTickNumbers[axis] = [];
        }
    }

    /**
     * 为每个刻度位置生成三条轴的数字 Sprite.
     * 位置与刻度线来自同一份 tickPositions,单位/可见性变化时整体重建.
     */
    private buildTickNumbers(positions: readonly number[]): void {
        const { labelColor, labelOffset } = RENDER_CONFIG.scene.axisTicks;
        for (const pos of positions) {
            const text = formatTickLabel(pos, this.piUnit);
            const xLabel = this.createTextSprite(text, labelColor);
            xLabel.position.set(pos, 0, labelOffset);
            xLabel.visible = this.axisLabelVisible.x;
            this.axisTickNumbers.x.push(xLabel);
            this.tickGroup.add(xLabel);

            const yLabel = this.createTextSprite(text, labelColor);
            yLabel.position.set(labelOffset, pos, 0);
            yLabel.visible = this.axisLabelVisible.y;
            this.axisTickNumbers.y.push(yLabel);
            this.tickGroup.add(yLabel);

            const zLabel = this.createTextSprite(text, labelColor);
            zLabel.position.set(labelOffset, 0, pos);
            zLabel.visible = this.axisLabelVisible.z;
            this.axisTickNumbers.z.push(zLabel);
            this.tickGroup.add(zLabel);
        }
    }

    /**
     * 创建文字 Sprite.
     * 刻度数字与 XYZ 轴标签共用同一字体/字号/缩放,保证一起缩放.
     * 画布高度固定,宽度按文字实测宽度扩展(π 分数如 "3π/2" 比单个数字宽),
     * Sprite 横向缩放按画布宽高比同步,因此字号在世界空间里保持不变,文字不被裁切.
     */
    private createTextSprite(text: string, color: string): THREE.Sprite {
        const height = RENDER_CONFIG.scene.labelCanvasSize;
        const canvas = document.createElement('canvas');
        canvas.width = height;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.font = RENDER_CONFIG.scene.labelFont;

        // 按需加宽画布;改动 canvas.width 会重置上下文状态,因此字体等在后文重设.
        const padding = height * 0.25;
        const needed = Math.ceil((ctx.measureText(text).width + padding) / 8) * 8;
        if (needed > height) canvas.width = needed;

        const width = canvas.width;
        ctx.fillStyle = 'rgba(0,0,0,0)';
        ctx.fillRect(0, 0, width, height);
        ctx.font = RENDER_CONFIG.scene.labelFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color;
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 4;
        ctx.fillText(text, width / 2, height / 2);

        const texture = new THREE.CanvasTexture(canvas);
        // 画布里的颜色是 sRGB 字节;不声明 colorSpace 时 three 会当线性值用,
        // 经输出色彩空间编码后标签/刻度数字会明显偏亮(与配置里其他经
        // `new THREE.Color(...)` 走 sRGB->linear 的颜色处理不一致).
        texture.colorSpace = THREE.SRGBColorSpace;
        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
        });
        const sprite = new THREE.Sprite(material);
        const labelScale = RENDER_CONFIG.scene.labelScale;
        sprite.scale.set(labelScale * (width / height), labelScale, 1);
        return sprite;
    }

    /**
     * 创建一段 Line2 坐标轴,并记录材质供线宽/分辨率更新.
     */
    private createAxisLine(
        start: [number, number, number],
        end: [number, number, number],
        color: string,
    ): void {
        const geometry = new LineGeometry();
        geometry.setPositions([...start, ...end]);

        const material = new LineMaterial({
            color,
            linewidth: RENDER_CONFIG.scene.axisLineWidth,
            resolution: new THREE.Vector2(
                this.container.clientWidth,
                this.container.clientHeight,
            ),
        });
        const line = new Line2(geometry, material);
        this.scene.add(line);
        this.axisLineMaterials.push(material);
        this.resolutionMaterials.push(material);
    }

    dispose(): void {
        this.scene.traverse((node: THREE.Object3D) => {
            if (
                node instanceof THREE.Mesh
                || node instanceof THREE.Line
                || node instanceof THREE.Points
            ) {
                node.geometry?.dispose();
                const materials = Array.isArray(node.material) ? node.material : [node.material];
                for (const material of materials) {
                    const texturedMaterial = material as {
                        map?: THREE.Texture | null;
                        dispose?: () => void;
                    };
                    texturedMaterial.map?.dispose();
                    texturedMaterial.dispose?.();
                }
            } else if (node instanceof THREE.Sprite) {
                node.geometry?.dispose();
                node.material.map?.dispose();
                node.material.dispose();
            }
        });

        this.renderer.dispose();
        if (this.renderer.domElement.parentElement === this.container) {
            this.container.removeChild(this.renderer.domElement);
        }
    }
}
