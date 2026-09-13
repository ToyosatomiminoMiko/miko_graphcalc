/**
 * 积分计算的 Worker 门面.
 *
 * 入口只保留一个 `integrate(spec)`:
 * - 方法名直接用 IR 语义名(`IntegralMethod`),与 Worker/Rust parse 同一套
 *   词汇,不再有 trapz1d/trapz2d 这类带维度别名串在主线程各处拼写;
 * - 维度/域由 spec 的显式 `dim`/`domainKind` 给出,不再用 range 长度推断;
 * - 被积函数统一为 `integrand`(region/solid 缺省 "1");数值与可视化
 *   采样所需的外接范围由 Rust 核回传(xa/xb/ya/yb/za/zb);
 * - 调度(Worker 复用,latest-only,dispose)保持原样.
 */
import type { IntegralDomainKind, IntegralMethod } from '../../../compiler/ir/types';
import { NUMERIC_CONFIG } from '../../../config/numericConfig';
import { ComputeWorkerClient } from './ComputeWorkerClient';
import { LatestRequestExecutor } from './LatestRequestExecutor';
import type {
    IntegralWorkerRequest,
    IntegralWorkerResponse,
} from './IntegralWorker';

export type IntegralSampleShape = NonNullable<IntegralWorkerResponse['sampleShape']>;

export type IntegralResult = {
    value: number;
    samples?: Float64Array;
    sampleShape?: IntegralSampleShape;
    n?: number;
    m?: number;
    /** region 域:外接矩形 y 区间;solid 域:世界外接盒范围(由 Rust 回传). */
    xa?: number;
    xb?: number;
    ya?: number;
    yb?: number;
    za?: number;
    zb?: number;
};

/** region 域的一条边界曲线描述(与求交同一数据形状的轻量版). */
export type IntegralBoundary = {
    expr: string;
    coeffs: Record<string, number>;
};

/** solid 域描述符:与求交 `IntersectionComputeSide` 一致(kind/params/matrix/inverse). */
export type IntegralSolidDomain = {
    kind: 'sphere' | 'box' | 'conic';
    params: number[];
    /** 扁平 16 元素行主序;无静态变换时空数组. */
    matrix: number[];
    inverse: number[];
};

/** 一次积分请求的完整描述. */
export type IntegralSpec = {
    /**
     * 任务身份(latest-only 调度用):只有同一个 taskKey 的新请求才会顶掉旧请求.
     * 取任务名(场景内唯一),不要用物体 id(一个物体可有多个积分).
     */
    taskKey: string;
    method: IntegralMethod;
    domainKind: IntegralDomainKind;
    /** 被积函数(归一化字符串);region/solid 缺省 "1",变量为世界坐标. */
    integrand: string;
    integrandCoeffs: Record<string, number>;
    /**
     * 显式区间:
     * - interval: [a, b];
     * - rectangle: [xa, xb, ya, yb];
     * - region: [xa, xb](y 由边界曲线在采样站点的极值推出);
     * - solid: 无.
     */
    range?: [number, number] | [number, number, number, number];
    /** region 域:两条边界曲线(次序无关,核内取 min/max). */
    region?: { boundaries: [IntegralBoundary, IntegralBoundary] };
    /** solid 域:实体描述符. */
    solid?: IntegralSolidDomain;
    /** 分段数;lebesgue 作为超采样前的基准采样数. */
    segments: number;
    /** lebesgue 专用层数;其他方法忽略. */
    layers?: number;
};

// ---------- Worker 管理 ----------
/**
 * @cache
 * 缓存目的:积分计算复用同一个 Worker client.
 * 键/失效策略:模块级单例;应用销毁时由 disposeIntegralWorker 显式释放.
 * 生命周期:模块级,随页面存活.
 */
const integralClient = new ComputeWorkerClient<IntegralWorkerRequest, IntegralWorkerResponse>(() => new Worker(
    new URL('./IntegralWorker.ts', import.meta.url),
    { type: 'module' },
));

/**
 * @cache
 * 缓存目的:每个积分任务一个 latest-only 调度器,而不是全场景共用一个.
 * 键/失效策略:taskKey(见 `IntegralSpec.taskKey`)-> executor;参数刷新只会
 *              顶掉**同一个任务**的旧请求.
 * 生命周期:模块级,随页面存活;disposeIntegralWorker 逐个释放.
 *
 * 为什么不能共用一个(202609 审查 P0-4,已用探针复现):
 * `DslIntegralRenderer.sync` 是 `for (task of tasks) await integrate(task)` 的
 * 串行循环,而共用 executor 的 superseded 是**全局按请求号**判定的.任务 A 在飞
 * 时,第二次刷新只把 A 标脏:`sync([A])` 先顶掉在飞的 A,再把新 A 排进 pending;
 * 旧 A 结算时新 A 的请求号已经过期,于是**两次 A 都以 superseded 结算**,被渲染
 * 层 `continue` 咽掉--A 永远拿不到结果,对象列表保留旧参数的积分值(静默错值).
 * 每任务一个 executor 后,superseded 只在同一任务内部发生,跨任务互不干扰.
 */
const integralExecutors = new Map<string, LatestRequestExecutor<IntegralWorkerRequest, IntegralWorkerResponse>>();

function executorFor(taskKey: string): LatestRequestExecutor<IntegralWorkerRequest, IntegralWorkerResponse> {
    let executor = integralExecutors.get(taskKey);
    if (!executor) {
        executor = new LatestRequestExecutor<IntegralWorkerRequest, IntegralWorkerResponse>(integralClient);
        integralExecutors.set(taskKey, executor);
    }
    return executor;
}

/**
 * @cache_access
 * 通过该任务自己的 latest-only executor 调用积分 Worker.
 */
export function integrate(spec: IntegralSpec): Promise<IntegralResult> {
    return executorFor(spec.taskKey)
        .request(buildRequest(spec))
        .then((response) => ({
            value: response.value!,
            samples: response.samples,
            sampleShape: response.sampleShape,
            n: response.n,
            m: response.m,
            xa: response.xa,
            xb: response.xb,
            ya: response.ya,
            yb: response.yb,
            za: response.za,
            zb: response.zb,
        }));
}

function buildRequest(spec: IntegralSpec): Omit<IntegralWorkerRequest, 'id'> {
    const base = {
        method: spec.method,
        domainKind: spec.domainKind,
        integrandExpr: spec.integrand,
        integrandCoeffs: spec.integrandCoeffs,
    };
    const layers = spec.layers ?? spec.segments;

    if (spec.domainKind === 'interval') {
        const [a, b] = spec.range as [number, number];
        if (spec.method === 'lebesgue') {
            return {
                ...base,
                a,
                b,
                layers,
                sampleN:
                    spec.segments * NUMERIC_CONFIG.integral.lebesgueOversample1D,
            };
        }
        return { ...base, a, b, n: spec.segments };
    }

    if (spec.domainKind === 'rectangle') {
        const [xa, xb, ya, yb] = spec.range as [number, number, number, number];
        if (spec.method === 'lebesgue') {
            return {
                ...base,
                xa,
                xb,
                ya,
                yb,
                layers,
                sampleN:
                    spec.segments * NUMERIC_CONFIG.integral.lebesgueOversample2D,
            };
        }
        return { ...base, xa, xb, ya, yb, n: spec.segments, m: spec.segments };
    }

    if (spec.domainKind === 'region') {
        const [xa, xb] = spec.range as [number, number];
        const [boundaryA, boundaryB] = spec.region!.boundaries;
        if (spec.method === 'lebesgue') {
            return {
                ...base,
                xa,
                xb,
                boundaryA,
                boundaryB,
                layers,
                sampleN:
                    spec.segments * NUMERIC_CONFIG.integral.lebesgueOversample2D,
            };
        }
        return { ...base, xa, xb, boundaryA, boundaryB, n: spec.segments, m: spec.segments };
    }

    // solid
    if (spec.method === 'lebesgue') {
        return {
            ...base,
            solid: spec.solid,
            layers,
            sampleN: spec.segments * NUMERIC_CONFIG.integral.lebesgueOversample3D,
        };
    }
    return { ...base, solid: spec.solid, n: spec.segments, m: spec.segments };
}

/**
 * 应用级释放积分计算资源.
 * 先停掉每个任务的 LatestRequestExecutor 逻辑调度,再 terminate 共享 Worker.
 */
/**
 * @cache_access
 * 释放所有任务的 latest-only 调度器和共享 Worker.
 */
export function disposeIntegralWorker(): void {
    for (const executor of integralExecutors.values()) {
        executor.dispose();
    }
    integralExecutors.clear();
    integralClient.dispose();
}
