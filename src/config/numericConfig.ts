/**
 * 数值计算与 DSL 编译默认值.
 *
 * 这里只放"默认策略",不应包含类/DOM 或渲染逻辑.
 */
import type { SphericalAngleConvention } from '../math/CoordinateSystem';

export const NUMERIC_CONFIG = {
    param: {
        defaultValue: 1,
        defaultMin: -10,
        defaultMax: 10,
        defaultStep: 0.1,
    },
    curve: {
        defaultRange: [-8, 8] as [number, number],
        defaultSegments: 320,
    },
    surface: {
        defaultRange: [-6, 6, -6, 6] as [number, number, number, number],
        defaultSegments: 64,
    },
    region: {
        defaultRange: [-4, 4] as [number, number],
        defaultSegments: 256,
    },
    vectorField: {
        defaultRange: [-4, 4, -4, 4, -4, 4] as [
            number,
            number,
            number,
            number,
            number,
            number,
        ],
        defaultGrid: [8, 8, 8] as [number, number, number],
        defaultGlyphScale: 1.2,
    },
    volume: {
        defaultSphereRadius: 1,
        defaultBoxSize: [1, 1, 1] as [number, number, number],
        defaultConicBase: 1,
        defaultConicHeight: 1,
        defaultRadialSegments: 48,
    },
    intersection: {
        defaultSegments: 128,
    },
    integral: {
        defaultMethod: 'riemann:left' as const,
        defaultRange1D: [-4, 4] as [number, number],
        defaultRange2D: [-3, 3, -3, 3] as [number, number, number, number],
        defaultSegments: 32,
        defaultLayersCap: 32,
        lebesgueOversample1D: 20,
        lebesgueOversample2D: 4,
        lebesgueOversample3D: 2,
        showDefault: true,
    },
    analysis: {
        /**
         * `at spherical(r, θ, φ)` 的角度约定(唯一切换点).
         *
         * - 'physics'(默认,物理/ISO):θ 是从 +Z 轴量起的极角 ∈ [0, π],
         *   φ 是 xy 平面内从 +X 轴逆时针量起的方位角 ∈ (-π, π];
         * - 'math'(部分教材):θ 是方位角,φ 是极角,即与上一种的 θ/φ 互换.
         *
         * 两个约定都在 math/CoordinateSystem.ts 实现并单测覆盖,这里只选
         * DSL 编译默认值;结果列表把分析点换算回 [r, θ, φ] 展示时用同一约定.
         */
        sphericalAngleConvention: 'physics' as SphericalAngleConvention,
    },
    tolerance: {
        zero: 1e-12,
    },
    limits: {
        // 曲线只有一维采样,20k 顶点仍是可控的线性缓冲;
        // 真正的风险在曲面/向量场与二维积分,不在曲线.
        curve: {
            maxSegments: 20_000,
        },
        surface: {
            // 512 段时:(512+1)^2 个顶点.
            // 若继续放到 1024,主线程索引与 WASM 结果双缓冲会同时膨胀,
            // 因此这里先压回一个更可预测的峰值.
            maxSegments: 512,
        },
        region: {
            // 区域填充/边界只按一维站点点数走,512 段足够平滑且是 O(n) 缓冲.
            maxSegments: 512,
        },
        vectorField: {
            // 向量场每个箭头在主线程生成两套实例矩阵,
            // 单轴和总点数必须同时限制;100k 点比 200 万点更接近 Web 现实.
            maxAxisGrid: 128,
            maxTotalGridPoints: 100_000,
        },
        volume: {
            // 球体/旋转体只按圆周分段,128 段已经足够平滑;
            // 继续增大会让单个几何体变得沉重,但不会像二维积分一样 O(n^2) 爆炸.
            maxRadialSegments: 128,
        },
        intersection: {
            // 求交网格是 O(n^2) 采样,256 是主线程同步计算的合理上限.
            maxSegments: 256,
        },
        integral: {
            // 数值计算与可视化预算分开.
            // 一维积分可以允许更高分段,二维积分是 O(n^2) 采样,三维是 O(n^3),
            // 各维度必须使用独立的,随维度递减的上限.
            maxSegments1D: 8_192,
            maxSegments2D: 256,
            // 三维数值采样 O(n^3):48 默认足够收敛,96 是内存/耗时硬上限
            // (97^3 ≈ 91 万格点 × 每点一次隐式场判定).
            maxSegments3D: 96,
            maxLayers: 128,
            // 以下值只约束"可视化",不改变数值积分结果.
            // 数值结果仍按 task.segments 在 Worker 中计算,只是绘制时降采样.
            maxVisualizationSegments1D: 512,
            maxVisualizationSegments2D: 128,
            // 3D 体元可视化 O(n^3),默认每轴 24 段(25^3 ≈ 1.6 万实例).
            maxVisualizationSegments3D: 24,
            maxLebesgueVisualizationSamples1D: 4_096,
            maxLebesgueVisualizationResolution2D: 192,
            maxVisualizationLayers: 32,
            maxVisualizationBars: 100_000,
        },
    },
    colorPalette: [
        '#6dd5ff',
        '#ff6b8a',
        '#ffd93d',
        '#6bffb8',
        '#c084fc',
        '#fb923c',
    ],
};
