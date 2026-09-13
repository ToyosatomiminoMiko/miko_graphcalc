/**
 * 积分计算 Worker.
 * 采样/求值与积分值计算全部由 Rust/WASM 完成,不再使用外部 JS 数学库.
 *
 * 维度语义:请求带显式 `dim`('1d'|'2d'|'3d')与 `domainKind`
 * (interval/rectangle/region/solid),按域路由到 Rust 的
 * integrate1d/integrate2d/integrate_region/integrate_solid 入口;
 * 不再用 range 长度推断维度.
 */
import init, {
    integrate1d,
    integrate2d,
    integrate_region,
    integrate_solid,
} from "../../../wasm/math_rs/math_rs";
import type { IntegralDomainKind, IntegralMethod } from '../../../compiler/ir/types';
import { recordToCoefficientArgs } from '../../adapters/coefficientUtils';
import { createWasmWorker } from './wasmWorkerRuntime';

export type IntegralBoundaryDesc = {
    expr: string;
    coeffs: Record<string, number>;
};

export type IntegralSolidDesc = {
    kind: 'sphere' | 'box' | 'conic';
    params: number[];
    matrix: number[];
    inverse: number[];
};

export type IntegralWorkerRequest = {
    id: number;
    /**
     * 语义方法名,与 IR `IntegralMethod` 及 Rust parse 名单保持一致;
     * 维度/域由 `dim` 与 `domainKind` 显式给出.
     */
    method: IntegralMethod;
    dim: '1d' | '2d' | '3d';
    domainKind: IntegralDomainKind;
    /** 被积函数(世界坐标变量). */
    integrandExpr: string;
    integrandCoeffs: Record<string, number>;
    /** interval 域. */
    a?: number;
    b?: number;
    /** rectangle / region 域(region 只用 x 分量). */
    xa?: number;
    xb?: number;
    ya?: number;
    yb?: number;
    /** region 域的两条边界曲线. */
    boundaryA?: IntegralBoundaryDesc;
    boundaryB?: IntegralBoundaryDesc;
    /** solid 域描述符. */
    solid?: IntegralSolidDesc;
    /** 网格采样分段(lebesgue 之外的方法使用). */
    n?: number;
    m?: number;
    /** lebesgue 专用. */
    layers?: number;
    /** lebesgue 超采样数(由主线程按 oversample 倍数换算后传入). */
    sampleN?: number;
};

export type IntegralWorkerResponse = {
    id: number;
    value?: number;
    error?: string;
    samples?: Float64Array;
    sampleShape?:
        | '1d-grid'
        | '1d-mid'
        | '2d-grid'
        | '2d-corner'
        | '2d-corner-right'
        | '2d-mid2'
        | '2d-cell'
        | '3d-cells'
        | '3d-skip';
    n?: number;
    m?: number;
    /** 采样外接范围(Rust 回传;region 的 y 区间/solid 的 AABB). */
    xa?: number;
    xb?: number;
    ya?: number;
    yb?: number;
    za?: number;
    zb?: number;
};

/**
 * @cache
 * 缓存目的:Worker 内只初始化一次 math_rs WASM 实例,后续请求复用.
 * 键/失效策略:模块级 Promise;永不失效.
 * 生命周期:随 Worker 实例存活.
 */
const wasmInit = init();

type IntegralComputed = {
    value: number;
    samples: Float64Array;
    sampleShape: NonNullable<IntegralWorkerResponse['sampleShape']>;
    n: number;
    m?: number;
    xa?: number;
    xb?: number;
    ya?: number;
    yb?: number;
    za?: number;
    zb?: number;
};

createWasmWorker<IntegralWorkerRequest, IntegralWorkerResponse>(
    wasmInit,
    (req, post) => {
        const { names: integrandNames, values: integrandValues } =
            recordToCoefficientArgs(req.integrandCoeffs);
        const result = compute(req, integrandNames, integrandValues);
        const resp: IntegralWorkerResponse = {
            id: req.id,
            value: result.value,
            // 直接复用 wasm-bindgen getter 产出的 Float64Array,不再用
            // Float64Array.from(result.samples) 二次拷贝.
            //
            // 目的:wasm-bindgen 的 struct getter(getter_with_clone)在读取
            // `.samples` 时就已经把整块 Vec<f64> 从 wasm 线性内存 `.slice()`
            // 复制成一块独立,自含 ArrayBuffer 的 JS Float64Array(见生成
            // math_rs.js 的 `get samples(){ ... .slice(); }`).原来的
            // `Float64Array.from(...)` 会把这份已经物化的采样网格再完整拷贝
            // 一次--对三维 solid(n³)约 7MB,二维 lebesgue 约 8.4MB 的
            // 结果来说纯属浪费,而且紧接着就被 postMessage 的 transferable
            // 转移到主线程,拷出来的第二份根本没有存在价值.
            //
            // 直接转走 `resp.samples!.buffer` 即可把样本数组的"JS 堆内重复
            // 拷贝"从 2 次降到 1 次,收益随输出规模线性放大.
            samples: result.samples,
            sampleShape: result.sampleShape,
            n: result.n,
            m: result.m || undefined,
            xa: result.xa,
            xb: result.xb,
            ya: result.ya,
            yb: result.yb,
            za: result.za,
            zb: result.zb,
        };
        post(resp, [resp.samples!.buffer]);
    },
);

function compute(
    req: IntegralWorkerRequest,
    integrandNames: string[],
    integrandValues: Float64Array,
): IntegralComputed {
    const isLebesgue = req.method === 'lebesgue';

    if (req.domainKind === 'interval') {
        const sampleN = isLebesgue ? req.sampleN! : req.n!;
        const layers = isLebesgue ? req.layers! : req.n!;
        const payload = JSON.stringify({
            expr: req.integrandExpr,
            coeff_names: integrandNames,
            coeff_values: [...integrandValues],
            a: req.a!,
            b: req.b!,
            n: sampleN,
            layers,
            method: req.method,
        });
        const result = integrate1d(payload);
        return {
            value: result.value,
            samples: result.samples,
            sampleShape: result.sample_shape as '1d-grid' | '1d-mid',
            n: result.n,
            xa: result.xa,
            xb: result.xb,
        };
    }

    if (req.domainKind === 'rectangle') {
        const n = isLebesgue ? req.sampleN! : req.n!;
        const m = isLebesgue ? req.sampleN! : (req.m ?? req.n!);
        const layers = isLebesgue ? req.layers! : req.n!;
        const payload = JSON.stringify({
            expr: req.integrandExpr,
            coeff_names: integrandNames,
            coeff_values: [...integrandValues],
            xa: req.xa!,
            xb: req.xb!,
            ya: req.ya!,
            yb: req.yb!,
            n,
            m,
            layers,
            method: req.method,
        });
        const result = integrate2d(payload);
        return {
            value: result.value,
            samples: result.samples,
            sampleShape: result.sample_shape as
                | '2d-grid'
                | '2d-corner'
                | '2d-corner-right'
                | '2d-mid2',
            n: result.n,
            m: result.m,
            xa: result.xa,
            xb: result.xb,
            ya: result.ya,
            yb: result.yb,
        };
    }

    if (req.domainKind === 'region') {
        const n = isLebesgue ? req.sampleN! : req.n!;
        const layers = isLebesgue ? req.layers! : req.n!;
        const a = recordToCoefficientArgs(req.boundaryA!.coeffs);
        const b = recordToCoefficientArgs(req.boundaryB!.coeffs);
        const payload = JSON.stringify({
            method: req.method,
            integrand_expr: req.integrandExpr,
            integrand_names: integrandNames,
            integrand_values: [...integrandValues],
            boundary_a_expr: req.boundaryA!.expr,
            boundary_a_names: a.names,
            boundary_a_values: [...a.values],
            boundary_b_expr: req.boundaryB!.expr,
            boundary_b_names: b.names,
            boundary_b_values: [...b.values],
            xa: req.xa!,
            xb: req.xb!,
            n,
            layers,
        });
        const result = integrate_region(payload);
        return {
            value: result.value,
            samples: result.samples,
            sampleShape: '2d-cell',
            n: result.n,
            m: result.m,
            xa: result.xa,
            xb: result.xb,
            ya: result.ya,
            yb: result.yb,
        };
    }

    // solid
    const n = isLebesgue ? req.sampleN! : req.n!;
    const layers = isLebesgue ? req.layers! : req.n!;
    const solid = req.solid!;
    const payload = JSON.stringify({
        method: req.method,
        kind: solid.kind,
        params: [...solid.params],
        matrix_values: [...solid.matrix],
        inverse_values: [...solid.inverse],
        integrand_expr: req.integrandExpr,
        integrand_names: integrandNames,
        integrand_values: [...integrandValues],
        n,
        layers,
    });
    const result = integrate_solid(payload);
    return {
        value: result.value,
        samples: result.samples,
        sampleShape: result.sample_shape as '3d-cells' | '3d-skip',
        n: result.n,
        m: result.m,
        xa: result.xa,
        xb: result.xb,
        ya: result.ya,
        yb: result.yb,
        za: result.za,
        zb: result.zb,
    };
}
