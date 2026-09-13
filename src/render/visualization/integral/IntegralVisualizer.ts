// ============================================================
// integral/IntegralVisualizer.ts - 积分可视化门面(状态 + 采样 + 缓存)
//
// IntegralVisualizer 是黎曼 / 梯形 / 辛普森 / 勒贝格积分可视化的入口类,
// 由 DslIntegralRenderer 持有.本文件只保留三件事:
//   1. 状态:场景挂载点(group),按任务名登记的可视化缓存(cache);
//   2. 数值采样:把积分任务参数换算成柱条/区间/网格数据,并做符号分区
//      (黎曼端点,勒贝格分层阈值,体元抽稀等);
//   3. 编排:调用同目录无状态构建器(bars.ts / area.ts / grids.ts)产出
//      THREE.Group,再挂入场景并登记缓存(见 _register).
// 几何生成本身不在这里,便于对纯构建函数单独测试.
// 公开 API(9 个 visualize* + clear/clearAll/dispose + group)供上层调用.
// ============================================================
import * as THREE from 'three';
import type { RiemannSide, SceneObject } from '../../../compiler/ir/types';
import { RENDER_CONFIG } from '../../../config/renderConfig';
import {
    createInstancedBarGroup,
    disposeObjectGroup,
    layerLoop,
} from './bars';
import {
    createPrismAreaGroup,
    quadraticPoints,
} from './area';
import {
    createSurfaceGridGroup,
    createTrapezoidGridGroup,
} from './grids';

// ============================================================
// 渲染常量
// ============================================================
const {
    barGap: BAR_GAP,
    depth2D: DEPTH_2D,
    opacityRiemann: OPACITY_RIEMANN,
    opacityLebesgue: OPACITY_LEBESGUE,
    edgeOpacityRiemann: EDGE_OPACITY_RIEMANN,
} = RENDER_CONFIG.integralVisualizer;

/**
 * IntegralVisualizer - 黎曼 / 梯形 / 辛普森 / 勒贝格积分可视化.
 *
 * 本类只保留三件事:场景/缓存等状态,数值采样策略,以及把无状态几何
 * 构建结果挂入场景并登记缓存.几何生成逻辑(柱条实例化,挤出棱柱,
 * 梯形柱阵,辛普森曲面,分层扫描,资源释放)见同目录 bars.ts / area.ts / grids.ts.
 */
export class IntegralVisualizer {
    scene: THREE.Scene;
    group: THREE.Group;

    /**
     * @cache
     * 缓存目的:保存积分可视化对应的 THREE.Group,避免同一任务重复创建 GPU 对象.
     * 键/失效策略:任务名或对象 id -> { type, objects };clear/clearAll 时删除.
     * 生命周期:跟随 IntegralVisualizer 实例.
     */
    cache: Map<number | string, { type: string; objects: THREE.Group }>;

    constructor(scene: THREE.Scene) {
        this.scene = scene;
        this.group = new THREE.Group();
        this.scene.add(this.group);
        this.cache = new Map();
    }

    /**
     * @cache_access
     * 清空场景对象和缓存.
     */
    clearAll(): void {
        while (this.group.children.length > 0) {
            const child = this.group.children[0];
            this.group.remove(child);
            disposeObjectGroup(child);
        }
        this.cache.clear();
    }

    /**
     * @cache_access
     * 删除指定任务的黎曼与勒贝格缓存.
     */
    clear(id: number | string): void {
        // 清除黎曼可视化缓存
        const entry = this.cache.get(id);
        if (entry) {
            this.group.remove(entry.objects);
            disposeObjectGroup(entry.objects);
            this.cache.delete(id);
        }
        // 清除勒贝格可视化缓存;键名后缀为 '_lebesgue'
        const lebesgueKey = `${id}_lebesgue`;
        const lebesgueEntry = this.cache.get(lebesgueKey);
        if (lebesgueEntry) {
            this.group.remove(lebesgueEntry.objects);
            disposeObjectGroup(lebesgueEntry.objects);
            this.cache.delete(lebesgueKey);
        }
    }

    /**
     * @cache_access
     * 清空缓存并把自己从场景移除.
     */
    dispose(): void {
        this.clearAll();
        this.scene.remove(this.group);
    }

    /**
     * 把无状态构建结果挂入场景并登记缓存.
     *
     * 同一键被再次登记时先释放旧 group:当前调用方都会先 clear(),属防御性
     * 处理,避免将来漏清时旧 group 既留在场景里又丢掉引用(无法再释放).
     */
    private _register(
        group: THREE.Group,
        cacheType: string,
        cacheKey: number | string,
    ): void {
        const existing = this.cache.get(cacheKey);
        if (existing) {
            this.group.remove(existing.objects);
            disposeObjectGroup(existing.objects);
        }
        this.group.add(group);
        this.cache.set(cacheKey, { type: cacheType, objects: group });
    }

    // ============================================================
    // 2D / 3D 黎曼和可视化
    // ============================================================

    /**
     * @cache_access
     * 创建或替换 2D 黎曼可视化并写入缓存.
     */
    visualize2DRiemann(
        obj: SceneObject,
        fn: (x: number) => number,
        a: number,
        b: number,
        N: number,
        cacheKey: number | string = obj.id,
        side: RiemannSide = 'left',
    ): void {
        const h = (b - a) / N;
        const color = new THREE.Color(obj.color);
        const bars: {
            pos: [number, number, number];
            scale: [number, number, number];
            color: THREE.Color;
        }[] = [];

        for (let i = 0; i < N; i++) {
            const x0 = a + i * h;
            // 柱子的采样端与数值方法保持一致:左端点/右端点/中点.
            const sampleX =
                side === 'left' ? x0
                    : side === 'right' ? x0 + h
                        : x0 + h / 2;
            const yVal = fn(sampleX);
            if (!isFinite(yVal) || Math.abs(yVal) < 1e-12) continue;
            bars.push({
                pos: [x0 + h / 2, yVal / 2, 0],
                scale: [h * (1 - BAR_GAP), Math.abs(yVal), DEPTH_2D],
                color,
            });
        }

        if (bars.length === 0) return;
        const group = createInstancedBarGroup(bars, {
            opacity: OPACITY_RIEMANN,
            edgeOpacity: EDGE_OPACITY_RIEMANN,
            edgeColor: color,
        });
        this._register(group, '2d', cacheKey);
    }

    /**
     * @cache_access
     * 创建或替换 3D 黎曼可视化并写入缓存.
     */
    visualize3DRiemann(
        obj: SceneObject,
        fn: (x: number, y: number) => number,
        xRange: [number, number],
        yRange: [number, number],
        N: number,
        M: number,
        cacheKey: number | string = obj.id,
    ): void {
        const [xMin, xMax] = xRange;
        const [yMin, yMax] = yRange;
        const hx = (xMax - xMin) / N;
        const hy = (yMax - yMin) / M;
        const baseColor = new THREE.Color(obj.color);
        const bars: {
            pos: [number, number, number];
            scale: [number, number, number];
            color: THREE.Color;
        }[] = [];

        for (let j = 0; j < M; j++) {
            for (let i = 0; i < N; i++) {
                const x0 = xMin + i * hx;
                const y0 = yMin + j * hy;
                const zVal = fn(x0, y0);
                if (!isFinite(zVal) || Math.abs(zVal) < 1e-12) continue;

                const c = baseColor.clone();
                c.multiplyScalar(Math.max(0.3, Math.min(1.2, 0.6 + 0.4 * (zVal / 4 + 0.5))));

                bars.push({
                    pos: [x0 + hx / 2, y0 + hy / 2, zVal / 2],
                    scale: [hx * (1 - BAR_GAP), hy * (1 - BAR_GAP), Math.abs(zVal)],
                    color: c,
                });
            }
        }

        if (bars.length === 0) return;
        const group = createInstancedBarGroup(bars, {
            opacity: OPACITY_RIEMANN - 0.05,
            edgeOpacity: 0.15,
            edgeColor: baseColor.clone().multiplyScalar(1.3),
        });
        this._register(group, '3d', cacheKey);
    }

    // ============================================================
    // 2D / 3D 梯形积分可视化
    // ============================================================

    /**
     * @cache_access
     * 创建一维梯形积分可视化并写入缓存.
     */
    visualize2DTrapezoid(
        obj: SceneObject,
        fn: (x: number) => number,
        a: number,
        b: number,
        N: number,
        cacheKey: number | string = obj.id,
    ): void {
        const h = (b - a) / N;
        const segments: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];

        for (let i = 0; i < N; i += 1) {
            const x0 = a + i * h;
            const x1 = a + (i + 1) * h;
            segments.push({ x0, x1, y0: fn(x0), y1: fn(x1) });
        }

        const group = createPrismAreaGroup(
            segments,
            new THREE.Color(obj.color),
            OPACITY_RIEMANN,
        );
        if (!group) return;
        this._register(group, '2d_trapezoid', cacheKey);
    }

    /**
     * @cache_access
     * 创建一维辛普森积分可视化并写入缓存.
     */
    visualize2DSimpson(
        obj: SceneObject,
        fn: (x: number) => number,
        a: number,
        b: number,
        N: number,
        cacheKey: number | string = obj.id,
    ): void {
        if (N < 2 || N % 2 !== 0) return;

        const h = (b - a) / N;
        const samples = 12;
        const segments: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];

        for (let pair = 0; pair < N / 2; pair += 1) {
            const x0 = a + pair * 2 * h;
            const x1 = x0 + h;
            const x2 = x0 + 2 * h;
            const points = quadraticPoints(
                x0,
                x1,
                x2,
                fn(x0),
                fn(x1),
                fn(x2),
                samples,
            );

            for (let i = 0; i < points.length - 1; i += 1) {
                segments.push({
                    x0: points[i].x,
                    x1: points[i + 1].x,
                    y0: points[i].y,
                    y1: points[i + 1].y,
                });
            }
        }

        const group = createPrismAreaGroup(
            segments,
            new THREE.Color(obj.color),
            OPACITY_RIEMANN - 0.08,
        );
        if (!group) return;
        this._register(group, '2d_simpson', cacheKey);
    }

    /**
     * @cache_access
     * 创建二维梯形积分可视化并写入缓存.
     */
    visualize3DTrapezoid(
        obj: SceneObject,
        fn: (x: number, y: number) => number,
        xRange: [number, number],
        yRange: [number, number],
        N: number,
        M: number,
        cacheKey: number | string = obj.id,
    ): void {
        const group = createTrapezoidGridGroup(
            fn,
            xRange,
            yRange,
            N,
            M,
            new THREE.Color(obj.color),
            OPACITY_RIEMANN - 0.05,
        );
        if (!group) return;
        this._register(group, '3d_trapezoid', cacheKey);
    }

    /**
     * @cache_access
     * 创建二维辛普森积分可视化并写入缓存.
     */
    visualize3DSimpson(
        obj: SceneObject,
        fn: (x: number, y: number) => number,
        xRange: [number, number],
        yRange: [number, number],
        N: number,
        M: number,
        cacheKey: number | string = obj.id,
    ): void {
        const group = createSurfaceGridGroup(
            fn,
            xRange,
            yRange,
            N,
            M,
            new THREE.Color(obj.color),
            OPACITY_RIEMANN - 0.1,
        );
        if (!group) return;
        this._register(group, '3d_simpson', cacheKey);
    }

    // ============================================================
    // 2D / 3D 勒贝格可视化
    // ============================================================

    /**
     * @cache_access
     * 创建 2D 勒贝格可视化并写入带后缀的缓存.
     */
    visualize2DLebesgue(
        obj: SceneObject,
        fn: (x: number) => number,
        a: number,
        b: number,
        layers: number,
        sampleN: number,
        cacheKey: number | string = obj.id,
    ): void {
        const baseColor = new THREE.Color(obj.color);

        const h = (b - a) / sampleN;
        const samples: { x: number; y: number }[] = [];
        let yMin = Infinity;
        let yMax = -Infinity;
        for (let x = a; x <= b; x += h) {
            const y = fn(x);
            if (isFinite(y)) {
                samples.push({ x, y });
                if (y < yMin) yMin = y;
                if (y > yMax) yMax = y;
            }
        }
        if (samples.length === 0) return;

        const scanIntervals = (predicate: (y: number) => boolean): [number, number][] => {
            const intervals: [number, number][] = [];
            let start: number | null = null;
            for (let i = 0; i < samples.length; i++) {
                const inRange = isFinite(samples[i].y) && predicate(samples[i].y);
                if (inRange && start === null) start = samples[i].x;
                if (!inRange && start !== null) {
                    intervals.push([start, samples[i].x]);
                    start = null;
                }
            }
            if (start !== null) intervals.push([start, b]);
            return intervals;
        };

        const strips = layerLoop(yMin, yMax, layers, baseColor, 0.15,
            (threshold, centerY, _k, color, dy) => {
                const result: {
                    pos: [number, number, number];
                    scale: [number, number, number];
                    color: THREE.Color;
                }[] = [];
                const pred = centerY >= 0
                    ? (y: number) => y > threshold
                    : (y: number) => y < -threshold;
                const intervals = scanIntervals(pred);
                for (const [xStart, xEnd] of intervals) {
                    const w = xEnd - xStart;
                    if (w < 1e-6) continue;
                    result.push({
                        pos: [(xStart + xEnd) / 2, centerY, 0],
                        scale: [w * (1 - BAR_GAP), dy * (1 - BAR_GAP), 0.15],
                        color,
                    });
                }
                return result;
            },
        );

        if (strips.length === 0) return;
        const group = createInstancedBarGroup(strips, { opacity: OPACITY_LEBESGUE });
        // id + 后缀记得清理
        this._register(group, '2d', `${cacheKey}_lebesgue`);
    }

    /**
     * @cache_access
     * 创建 3D 勒贝格积分可视化并写入带后缀的缓存.
     */
    visualize3DLebesgue(
        obj: SceneObject,
        fn: (x: number, y: number) => number,
        xRange: [number, number],
        yRange: [number, number],
        layers: number,
        res: number,
        cacheKey: number | string = obj.id,
    ): void {
        const [xMin, xMax] = xRange;
        const [yMin, yMax] = yRange;
        const baseColor = new THREE.Color(obj.color);
        const hx = (xMax - xMin) / res;
        const hy = (yMax - yMin) / res;

        let zMin = Infinity;
        let zMax = -Infinity;
        const stride = res + 1;
        const grid = new Float64Array(stride * stride);
        for (let j = 0; j <= res; j++) {
            const y = yMin + j * hy;
            for (let i = 0; i <= res; i++) {
                const z = fn(xMin + i * hx, y);
                if (isFinite(z)) {
                    grid[j * stride + i] = z;
                    if (z < zMin) zMin = z;
                    if (z > zMax) zMax = z;
                } else {
                    grid[j * stride + i] = NaN;
                }
            }
        }
        if (!isFinite(zMin) || !isFinite(zMax)) return;

        const slices = layerLoop(zMin, zMax, layers, baseColor, 0,
            (threshold, centerZ, _k, color, _dy) => {
                const result: {
                    pos: [number, number, number];
                    scale: [number, number, number];
                    color: THREE.Color;
                }[] = [];
                const predicate = centerZ >= 0
                    ? (z: number) => z > threshold
                    : (z: number) => z < -threshold;

                for (let j = 0; j < res; j++) {
                    for (let i = 0; i < res; i++) {
                        const z00 = grid[j * stride + i];
                        if (!isFinite(z00)) continue;
                        if (predicate(z00)) {
                            result.push({
                                pos: [xMin + (i + 0.5) * hx, yMin + (j + 0.5) * hy, centerZ],
                                scale: [hx * (1 - BAR_GAP), hy * (1 - BAR_GAP), 0.05],
                                color,
                            });
                        }
                    }
                }
                return result;
            },
        );

        if (slices.length === 0) return;
        const group = createInstancedBarGroup(slices, { opacity: OPACITY_LEBESGUE - 0.1 });
        // id + 后缀
        this._register(group, '3d', `${cacheKey}_lebesgue`);
    }

    // ============================================================
    // 3D 实体域体元可视化
    // ============================================================

    /**
     * @cache_access
     * 创建 3D 实体(体积域)的内部体元可视化并写入缓存.
     *
     * 数值/采样网格为每轴 n 的立方体单元(行优先,外层 z,中层 y,内层 x);
     * 带外/非有限为 NaN.绘制时按 `segments`(预算降采样后)在同一个世界
     * AABB 上抽稀展示:单元中心落在体内的单元显示为半透明小立方体,
     * 颜色随被积值明暗变化.f≡1 时整块同色,用于展示"体积被离散覆盖".
     */
    visualize3DSolid(
        obj: SceneObject,
        n: number,
        samples: Float64Array,
        xa: number,
        xb: number,
        ya: number,
        yb: number,
        za: number,
        zb: number,
        segments: number,
        cacheKey: number | string = obj.id,
    ): void {
        if (n === 0 || segments === 0) return;

        const baseColor = new THREE.Color(obj.color);
        const hx = (xb - xa) / n;
        const hy = (yb - ya) / n;
        const hz = (zb - za) / n;

        // 被积值范围(仅有限样本)用于明暗着色.
        let zMin = Infinity;
        let zMax = -Infinity;
        for (let index = 0; index < samples.length; index++) {
            const z = samples[index];
            if (Number.isFinite(z)) {
                if (z < zMin) zMin = z;
                if (z > zMax) zMax = z;
            }
        }
        if (!Number.isFinite(zMin) || !Number.isFinite(zMax)) return;
        const span = Math.max(zMax - zMin, 1e-12);

        const vx = (xb - xa) / segments;
        const vy = (yb - ya) / segments;
        const vz = (zb - za) / segments;
        const bars: {
            pos: [number, number, number];
            scale: [number, number, number];
            color: THREE.Color;
        }[] = [];

        const sampleAt = (cx: number, cy: number, cz: number): number => {
            const i = Math.max(0, Math.min(n - 1, Math.floor((cx - xa) / hx)));
            const j = Math.max(0, Math.min(n - 1, Math.floor((cy - ya) / hy)));
            const k = Math.max(0, Math.min(n - 1, Math.floor((cz - za) / hz)));
            return samples[(k * n + j) * n + i] ?? NaN;
        };

        for (let k = 0; k < segments; k++) {
            const cz = za + (k + 0.5) * vz;
            for (let j = 0; j < segments; j++) {
                const cy = ya + (j + 0.5) * vy;
                for (let i = 0; i < segments; i++) {
                    const cx = xa + (i + 0.5) * vx;
                    const z = sampleAt(cx, cy, cz);
                    if (!Number.isFinite(z) || Math.abs(z) < 1e-12) continue;

                    const t = (z - zMin) / span;
                    const c = baseColor.clone().lerp(new THREE.Color(0xffffff), t * 0.55);
                    bars.push({
                        pos: [cx, cy, cz],
                        scale: [vx * (1 - BAR_GAP), vy * (1 - BAR_GAP), vz * (1 - BAR_GAP)],
                        color: c,
                    });
                }
            }
        }

        if (bars.length === 0) return;
        const group = createInstancedBarGroup(bars, {
            opacity: OPACITY_RIEMANN - 0.15,
            edgeOpacity: 0,
        });
        this._register(group, '3d_solid', cacheKey);
    }
}
