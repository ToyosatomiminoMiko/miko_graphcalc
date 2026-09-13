/**
 * 资源预算纯函数.
 *
 * 这里不渲染/不创建几何体,只负责回答两个问题:
 *   1. 某个用户输入大概会吃掉多少内存;
 *   2. 可视化时应该把分辨率压到多少才不会被主线程/GPU 拖死.
 *
 * 设计原则:数值计算精度和可视化分辨率必须分开.
 * 积分值可以在 Worker 里按用户指定的高 segments 计算,
 * 但 2D 勒贝格/梯形/辛普森可视化绝不允许在主线程构造 O(n^2) 的几何体.
 */
import { NUMERIC_CONFIG } from './numericConfig';

const BYTES_PER_F32 = 4;
const BYTES_PER_F64 = 8;
const BYTES_PER_U32 = 4;
const MIB = 1024 * 1024;

/**
 * 单个曲面在"几何体 + 完整索引"情况下的近似峰值字节数.
 *
 * 这里没有把 WASM 侧 Vec 与 JS 侧 typed array 的双缓冲算进去,
 * 因此实际峰值会比这个值更高;它只用于快速估计,不作为唯一防线.
 */
export function surfaceGeometryBytes(segments: number): number {
    const vertexCount = (segments + 1) * (segments + 1);
    const attributesBytes = vertexCount * 3 * BYTES_PER_F32 * 3; // position/color/normal
    const fullIndexBytes = segments * segments * 6 * BYTES_PER_U32;
    return attributesBytes + fullIndexBytes;
}

/**
 * 向量场主线程与 GPU 侧最容易失控的是实例矩阵.
 *
 * 每个点有 shaft/head 两个 InstancedMesh,每个 instanceMatrix 是 16 个 f32.
 * 这里只是最保守的 CPU 侧估算,GPU 侧还会再占一份.
 */
export function vectorFieldInstanceBytes(totalPoints: number): number {
    return totalPoints * 16 * BYTES_PER_F32 * 2;
}

/** 一维积分采样数组的字节数. */
export function integral1DSampleBytes(segments: number, oversample = 1): number {
    const sampleCount = segments * oversample + 1;
    return sampleCount * BYTES_PER_F64;
}

/** 二维积分网格采样数组的字节数. */
export function integral2DSampleBytes(segments: number, oversample = 1): number {
    const sampleCount = (segments * oversample + 1) ** 2;
    return sampleCount * BYTES_PER_F64;
}

/** 把字节数格式化成更适合错误信息与诊断输出的 MiB 字符串. */
export function formatMiB(bytes: number): string {
    return `${(bytes / MIB).toFixed(1)} MiB`;
}

type ClampedResolution<T> = T & {
    decimated: boolean;
};

/**
 * 一维普通积分可视化的分段数.
 *
 * 梯形/辛普森当前用 ExtrudeGeometry 逐段构造,分段过高会明显卡顿;
 * 数值计算不经过这个函数,因此降采样只影响画面,不影响积分值.
 */
export function clampIntegral1DVisualization(
    requestedSegments: number,
): ClampedResolution<{ segments: number }> {
    const maxSegments = NUMERIC_CONFIG.limits.integral.maxVisualizationSegments1D;
    const segments = Math.min(requestedSegments, maxSegments);
    return {
        segments,
        decimated: segments < requestedSegments,
    };
}

/**
 * 二维普通积分可视化的分段数.
 *
 * 2D Riemann/Trapezoid/Simpson 的几何体都是 O(nx*ny),
 * 主线程必须单独限制每轴分段数.
 */
export function clampIntegral2DVisualization(
    requestedSegments: number,
): ClampedResolution<{ segments: number }> {
    const maxSegments = NUMERIC_CONFIG.limits.integral.maxVisualizationSegments2D;
    const segments = Math.min(requestedSegments, maxSegments);
    return {
        segments,
        decimated: segments < requestedSegments,
    };
}

/**
 * 三维实体体元可视化的每轴分段数.
 *
 * 3D 体元 O(n³),每轴分段必须单独压到 24 段以下(25³ ≈ 1.6 万实例),
 * 数值结果仍按 task.segments 在 Worker 中计算.
 */
export function clampIntegral3DVisualization(
    requestedSegments: number,
): ClampedResolution<{ segments: number }> {
    const maxSegments = NUMERIC_CONFIG.limits.integral.maxVisualizationSegments3D;
    const segments = Math.min(requestedSegments, maxSegments);
    return {
        segments,
        decimated: segments < requestedSegments,
    };
}

/**
 * 一维勒贝格可视化:同时限制采样点数和分层数.
 *
 * 可视化最坏情况是 layers * sampleN 个实例柱,因此不能只压其中一个.
 */
export function clampLebesgue1DVisualization(
    requestedSegments: number,
    requestedLayers: number,
): ClampedResolution<{ sampleN: number; layers: number }> {
    const { integral } = NUMERIC_CONFIG;
    const requestedSampleN = requestedSegments * integral.lebesgueOversample1D;
    const sampleN = Math.min(
        requestedSampleN,
        NUMERIC_CONFIG.limits.integral.maxLebesgueVisualizationSamples1D,
    );
    const maxLayersByBars = Math.max(
        1,
        Math.floor(NUMERIC_CONFIG.limits.integral.maxVisualizationBars / sampleN),
    );
    const layers = Math.min(
        requestedLayers,
        NUMERIC_CONFIG.limits.integral.maxVisualizationLayers,
        maxLayersByBars,
    );

    return {
        sampleN,
        layers,
        decimated: sampleN < requestedSampleN || layers < requestedLayers,
    };
}

/**
 * 二维勒贝格可视化:控制网格分辨率与总柱数.
 *
 * 最坏情况是 layers * (res + 1)^2 个实例柱;
 * 如果直接沿用数值积分的高分辨率,很容易超过 1 GiB 临时内存.
 */
export function clampLebesgue2DVisualization(
    requestedSegments: number,
    requestedLayers: number,
): ClampedResolution<{ res: number; layers: number }> {
    const { integral } = NUMERIC_CONFIG;
    const requestedRes = requestedSegments * integral.lebesgueOversample2D;
    const res = Math.min(
        requestedRes,
        NUMERIC_CONFIG.limits.integral.maxLebesgueVisualizationResolution2D,
    );
    const cellCount = (res + 1) * (res + 1);
    const maxLayersByBars = Math.max(
        1,
        Math.floor(NUMERIC_CONFIG.limits.integral.maxVisualizationBars / cellCount),
    );
    const layers = Math.min(
        requestedLayers,
        NUMERIC_CONFIG.limits.integral.maxVisualizationLayers,
        maxLayersByBars,
    );

    return {
        res,
        layers,
        decimated: res < requestedRes || layers < requestedLayers,
    };
}
