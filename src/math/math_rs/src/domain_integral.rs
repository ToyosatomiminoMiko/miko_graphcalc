//! 带域积分数值内核:region 面积图形(2D)与实体(solid,3D)域.
//!
//! 语义(见 prompt/feature.md):
//! - region(2D, x 型带状)D = { a≤x≤b, min(c1,c2)(x) ≤ y ≤ max(c1,c2)(x) }:
//!   - **B1 迭代(累次)积分**:trapezoid/simpson 按
//!     ∫_a^b [∫_{y_1(x)}^{y_2(x)} g(x,y) dy] dx 内层逐 x 站积分;
//!   - **B2 网格指示积分**:riemann:left/right/mid 与 lebesgue 在外接矩形
//!     n×n 网格上取"格点采样端 = 方法端",采样端在带内即计入;
//! - solid(3D):
//!   - **C1 世界网格**:riemann 家族取实体世界外接盒 n³ 网格 + 隐式场判定
//!     (采样端在体内计入,天然支持静态变换);
//!   - **C2 轴向切片**:trapezoid/simpson 沿体局部轴(u)切出圆盘/圆环/矩形
//!     族,先片内积分再对 u 做 1D 方法积分,最后乘 |det M|(见 kernel 注释).
//!     片内是 n×n 中点积分离散,总误差由内层主导为 O(1/n²)--它名义上是
//!     "切片中点法"而不是四阶 Simpson(详见 `integrate_solid` 注释);
//!   - lebesgue:f≡1 直接返回测度(体积)不生成层几何;非平凡 f 按 C1 层
//!     处理(收尾阶段).
//!
//! 掩码语义:riemann/lebesgue 与梯形/辛普森在被积函数非有限处一律按
//! "该点不贡献测度"处理(与可视化 NaN 格一致),不会把整条内层积分/整片
//! 清零;求值 `Err` 照常上抛.
//!
//! 所有被积函数一律以**世界坐标**求值(所见即所得);boundary/域边界曲线为
//! 一元 y=f(x).本模块不依赖 wasm-bindgen,便于 `cargo test` 纯 Rust 验证.
//!
//! 模块边界(2026 架构审查,为何保持单文件):region 与 solid 不是两个偶合
//! 特性,而是"带域积分"这一个 feature 的两半--掩码语义,1D 求积 helper,
//! lebesgue 层扫描与测试基建(descriptor/解析值对拍)全部共享,非测试代码
//! 仅约 690 行(文件其余约 39% 是 `#[cfg(test)]`);仅为行数沿 region/solid
//! 切开只会分裂共享契约文档与测试基建,净收益低,故**刻意不拆**.若未来某
//! 侧单独膨胀(新域类型/新可视化形态),再按该轴拆.实体几何(ObjectDescriptor
//! /隐式场/SolidProbe/世界 AABB)由 geometry_core 统一提供:本模块与
//! intersection_core 共享同一几何层,域积分特性不依赖求交算法实现.
//!
//! 行为契约(202609 审查收口):
//! - **掩码语义与 integral_core 统一**:被积函数在采样点非有限 = 该点不贡献
//!   测度(单元丢弃/按 0 计入),不因个别点把整条内层积分或整片清零;求值 Err 上抛;
//! - 规模护栏:region n ≤ MAX_GRID_N,solid n ≤ MAX_SOLID_N(见 config),
//!   进入 n³ 分配前先校验;layers 上限由 lebesgue 核统一执行;
//! - solid C2(trapz/simpson)的数值走轴向切片,可视化体元样本刻意再跑一遍
//!   C1 中点网格(仅画面):两条路径成本都是 O(n³),重复采样是**有意的**,
//!   不要在数值路径里顺带产出 C1 样本(会改变 C2 的数值语义);
//! - 编码注意:单元端坐标用 `cell_end_at`,勒贝格层扫描用
//!   `lebesgue_over_cells`,不要复制第三份"扫 min/max + 按谓词计测度".

use crate::config::{MAX_GRID_N, MAX_SOLID_N};
use crate::eval_core::CompiledEvaluator;
use crate::geometry_core::{solid_world_aabb, ObjectDescriptor, ObjectKind, SolidProbe};
use crate::integral_core::{lebesgue_over_cells, validate_1d_interval};
use crate::integral_method::{cell_end_at, IntegralMethod};
use crate::transform_core::{apply_to_point, Mat4};

/// 一维 from-values 积分核的最小包装,便于复用梯形/辛普森(等距样本).
fn integrate_1d_values(
    values: &[f64],
    lo: f64,
    hi: f64,
    method: IntegralMethod,
) -> Result<f64, String> {
    match method {
        IntegralMethod::Trapz => crate::integral_core::trapz1d_from_values(values, lo, hi),
        IntegralMethod::Simpson => crate::integral_core::simpson1d_from_values(values, lo, hi),
        _ => Err("该方法不是一维积分核".to_string()),
    }
}

// ================================================================
// region 2D
// ================================================================

pub struct RegionInput<'a> {
    pub integrand_expr: &'a str,
    pub integrand_names: &'a [String],
    pub integrand_values: &'a [f64],
    /// 两条边界曲线 y=f(x)(次序无关,核内取 min/max).
    pub boundary_exprs: [&'a str; 2],
    pub boundary_names: [&'a [String]; 2],
    pub boundary_values: [&'a [f64]; 2],
    pub xa: f64,
    pub xb: f64,
}

pub struct RegionOutcome {
    pub value: f64,
    /// n×n 行优先单元网格(外层 y,内层 x);单元采样端在带内时是被积值,
    /// 否则/非有限时为 NaN.数值(riemann/lebesgue)与可视化共用它.
    pub samples: Vec<f64>,
    pub n: usize,
    /// 外接矩形 y 区间(由边界曲线在采样站点的 min/max 推出).
    pub y_min: f64,
    pub y_max: f64,
}

fn compile_boundary(
    expr: &str,
    names: &[String],
    values: &[f64],
) -> Result<CompiledEvaluator, String> {
    CompiledEvaluator::new(expr, names, values)
}

/// 把某条边界曲线在 x 处的取值当成区间端点;两曲线取 min/max 构成带.
/// 非有限值返回 None(该站点认为带为空).
fn band_at(
    lo_eval: &mut CompiledEvaluator,
    hi_eval: &mut CompiledEvaluator,
    x: f64,
) -> Result<Option<(f64, f64)>, String> {
    let lo = lo_eval.eval_1d(x)?;
    let hi = hi_eval.eval_1d(x)?;
    match (lo, hi) {
        (Some(lo), Some(hi)) if lo.is_finite() && hi.is_finite() => {
            Ok(Some((lo.min(hi), lo.max(hi))))
        }
        _ => Ok(None),
    }
}

/// 按方法采样端构建 region 的 n×n 单元网格,同时返回外接 y 区间.
fn region_cell_grid(
    method: IntegralMethod,
    integrand: &mut CompiledEvaluator,
    lo_eval: &mut CompiledEvaluator,
    hi_eval: &mut CompiledEvaluator,
    xa: f64,
    xb: f64,
    n: usize,
) -> Result<(Vec<f64>, f64, f64), String> {
    if n == 0 {
        return Err("region 积分需要 n > 0".to_string());
    }
    let end = method.cell_end();

    // 每列(x 单元)的采样端 x 与带上下界.
    let mut lo_col: Vec<Option<f64>> = Vec::with_capacity(n);
    let mut hi_col: Vec<Option<f64>> = Vec::with_capacity(n);
    let mut x_end: Vec<f64> = Vec::with_capacity(n);
    for i in 0..n {
        let x = cell_end_at(end, xa, xb, n, i);
        let band = band_at(lo_eval, hi_eval, x)?;
        x_end.push(x);
        lo_col.push(band.map(|(lo, _)| lo));
        hi_col.push(band.map(|(_, hi)| hi));
    }

    // 外接 y 区间:对采样站点上的 lo/hi 取极值.
    let mut y_min = f64::INFINITY;
    let mut y_max = f64::NEG_INFINITY;
    for i in 0..n {
        if let (Some(lo), Some(hi)) = (lo_col[i], hi_col[i]) {
            y_min = y_min.min(lo);
            y_max = y_max.max(hi);
        }
    }
    if !y_min.is_finite() || !y_max.is_finite() {
        return Err("边界曲线在积分区间内无定义,区域为空".to_string());
    }
    if y_max <= y_min {
        return Err("边界曲线在积分区间内恒相交,区域为空".to_string());
    }

    let mut samples = Vec::with_capacity(n * n);
    for j in 0..n {
        let y = cell_end_at(end, y_min, y_max, n, j);
        for i in 0..n {
            let inside = match (lo_col[i], hi_col[i]) {
                (Some(lo), Some(hi)) => lo <= y && y <= hi,
                _ => false,
            };
            let value = if inside {
                integrand.eval_2d(x_end[i], y)?
            } else {
                None
            };
            samples.push(match value {
                Some(v) if v.is_finite() => v,
                _ => f64::NAN,
            });
        }
    }
    Ok((samples, y_min, y_max))
}

/// 内层 ∫_{lo}^{hi} g(x_k, y) dy 的 from-values 一维积分(方法梯形/辛普森).
///
/// 被积函数在某条内层积分线上只在部分 y 处有定义(如 `sqrt(y-0.5)` 在
/// y<0.5 处非有限)是常态.约定与 riemann/lebesgue 网格路径一致--
/// **掩码语义**:非有限采样节点按 0 计入(该点对测度无贡献),而不是把
/// 整条内层积分清零.结果即"定义域受限"的积分,与其他方法同源;
/// 网格加细时仍收敛到解析值.求值 `Err` 依然上抛,不会被吞掉.
fn inner_y_integral(
    integrand: &mut CompiledEvaluator,
    lo: f64,
    hi: f64,
    x_k: f64,
    sub: usize,
    method: IntegralMethod,
) -> Result<f64, String> {
    if hi <= lo {
        return Ok(0.0);
    }
    if method == IntegralMethod::Simpson && !sub.is_multiple_of(2) {
        return Err("region 辛普森内层要求偶数细分".to_string());
    }
    let sub = sub.max(2);
    let mut values = Vec::with_capacity(sub + 1);
    for s in 0..=sub {
        let y = lo + (hi - lo) * (s as f64 / sub as f64);
        match integrand.eval_2d(x_k, y)? {
            Some(v) if v.is_finite() => values.push(v),
            // 非有限/无定义:掩码为零(不贡献测度),见函数注释.
            Some(_) | None => values.push(0.0),
        }
    }
    integrate_1d_values(&values, lo, hi, method)
}

/// B1:累次积分(region 的 trapezoid/simpson).
fn region_iterated_value(
    method: IntegralMethod,
    integrand: &mut CompiledEvaluator,
    lo_eval: &mut CompiledEvaluator,
    hi_eval: &mut CompiledEvaluator,
    xa: f64,
    xb: f64,
    n: usize,
) -> Result<f64, String> {
    if method != IntegralMethod::Trapz && method != IntegralMethod::Simpson {
        return Err("该方法不使用累次积分".to_string());
    }
    if n == 0 {
        return Err("region 积分需要 n > 0".to_string());
    }
    let hx = (xb - xa) / n as f64;
    let mut outer = Vec::with_capacity(n + 1);
    for k in 0..=n {
        let x_k = xa + k as f64 * hx;
        let station = band_at(lo_eval, hi_eval, x_k)?;
        let inner = match station {
            Some((lo, hi)) => inner_y_integral(integrand, lo, hi, x_k, n, method)?,
            None => 0.0,
        };
        outer.push(inner);
    }
    integrate_1d_values(&outer, xa, xb, method)
}

/// region 勒贝格:单元采样端在带内时计入单元测度(左端点格子约定),
/// 层扫描统一走 integral_core 的 `lebesgue_over_cells`.
fn lebesgue_region_value(samples: &[f64], hx: f64, hy: f64, layers: usize) -> Result<f64, String> {
    lebesgue_over_cells(samples, hx * hy, layers)
}

/// region 域积分统一入口.
///
/// - riemann:left/right/mid:数值 = Σ 采样端在带内单元的 g(端)·hx·hy,
///   与可视化样本同源;
/// - trapezoid/simpson:B1 累次积分;样本网格(中点端)仅用于可视化;
/// - lebesgue:对网格指示积分(左端点格子约定)分层求测度.
pub fn integrate_region(
    method: IntegralMethod,
    input: &RegionInput<'_>,
    n: usize,
    layers: usize,
) -> Result<RegionOutcome, String> {
    validate_1d_interval(input.xa, input.xb)?;
    if n == 0 {
        return Err("region 积分需要 n > 0".to_string());
    }
    if n > MAX_GRID_N {
        return Err(format!("region 积分 n 超过上限 {MAX_GRID_N}"));
    }
    let mut integrand = CompiledEvaluator::new(
        input.integrand_expr,
        input.integrand_names,
        input.integrand_values,
    )?;
    let mut lo_eval = compile_boundary(
        input.boundary_exprs[0],
        input.boundary_names[0],
        input.boundary_values[0],
    )?;
    let mut hi_eval = compile_boundary(
        input.boundary_exprs[1],
        input.boundary_names[1],
        input.boundary_values[1],
    )?;

    let (samples, y_min, y_max) = region_cell_grid(
        method,
        &mut integrand,
        &mut lo_eval,
        &mut hi_eval,
        input.xa,
        input.xb,
        n,
    )?;
    let hx = (input.xb - input.xa) / n as f64;
    let hy = (y_max - y_min) / n as f64;

    let value = match method {
        IntegralMethod::RiemannLeft | IntegralMethod::RiemannRight | IntegralMethod::RiemannMid => {
            let mut sum = 0.0;
            for &z in &samples {
                if z.is_finite() {
                    sum += z;
                }
            }
            sum * hx * hy
        }
        IntegralMethod::Trapz | IntegralMethod::Simpson => region_iterated_value(
            method,
            &mut integrand,
            &mut lo_eval,
            &mut hi_eval,
            input.xa,
            input.xb,
            n,
        )?,
        IntegralMethod::Lebesgue => lebesgue_region_value(&samples, hx, hy, layers)?,
    };

    Ok(RegionOutcome {
        value,
        samples,
        n,
        y_min,
        y_max,
    })
}

// ================================================================
// solid 3D
// ================================================================

pub struct SolidOutcome {
    pub value: f64,
    /// n³ 行优先单元网格(外层 z,中层 y,内层 x);采样端在体内时为
    /// 被积值,否则为 NaN.数值(riemann/lebesgue)与可视化共用.
    pub samples: Vec<f64>,
    pub n: usize,
    /// 世界外接 AABB.
    pub x_min: f64,
    pub x_max: f64,
    pub y_min: f64,
    pub y_max: f64,
    pub z_min: f64,
    pub z_max: f64,
}

/// 世界外接盒 n³ 单元采样(C1),采样端由方法决定.
#[allow(clippy::too_many_arguments)]
fn solid_cell_grid(
    method: IntegralMethod,
    probe: &mut SolidProbe,
    integrand: &mut CompiledEvaluator,
    aabb: ([f64; 2], [f64; 2], [f64; 2]),
    n: usize,
) -> Result<(Vec<f64>, f64), String> {
    let end = method.cell_end();
    let (xs, ys, zs) = aabb;
    let x_min = xs[0];
    let x_max = xs[1];
    let y_min = ys[0];
    let y_max = ys[1];
    let z_min = zs[0];
    let z_max = zs[1];
    let hx = (x_max - x_min) / n as f64;
    let hy = (y_max - y_min) / n as f64;
    let hz = (z_max - z_min) / n as f64;
    let x_of = |i: usize| cell_end_at(end, x_min, x_max, n, i);
    let y_of = |j: usize| cell_end_at(end, y_min, y_max, n, j);
    let z_of = |k: usize| cell_end_at(end, z_min, z_max, n, k);

    let mut samples = Vec::with_capacity(n * n * n);
    for k in 0..n {
        let z = z_of(k);
        for j in 0..n {
            let y = y_of(j);
            for i in 0..n {
                let x = x_of(i);
                let inside = probe.inside([x, y, z])?;
                let value = if inside {
                    integrand.eval_at(x, y, z)?
                } else {
                    None
                };
                samples.push(match value {
                    Some(v) if v.is_finite() => v,
                    _ => f64::NAN,
                });
            }
        }
    }
    Ok((samples, hx * hy * hz))
}

fn lebesgue_solid_value(samples: &[f64], volume: f64, layers: usize) -> Result<f64, String> {
    lebesgue_over_cells(samples, volume, layers)
}

// ---------------- C2:轴向切片 ----------------

/// 实体局部测度的解析公式(供 f≡1 的 lebesgue 直接返回测度,不建层几何).
///
/// 局部体积:球 4πr³/3,盒 sx·sy·sz,圆台 πh/3·(R²+R·r+r²);
/// 世界体积 = 局部体积 × |det M|(仿射变换体积缩放).
pub fn solid_exact_measure(descriptor: &ObjectDescriptor) -> Result<f64, String> {
    let p = &descriptor.params;
    let local = match descriptor.kind {
        ObjectKind::Sphere => {
            let r = p[3];
            if r <= 0.0 {
                return Err("球体半径必须大于 0".to_string());
            }
            4.0 / 3.0 * std::f64::consts::PI * r * r * r
        }
        ObjectKind::Box => {
            let (sx, sy, sz) = (p[3], p[4], p[5]);
            if sx <= 0.0 || sy <= 0.0 || sz <= 0.0 {
                return Err("方块尺寸必须大于 0".to_string());
            }
            sx * sy * sz
        }
        ObjectKind::Conic => {
            let (base, top, height) = (p[3], p[4], p[5]);
            if base <= 0.0 || height <= 0.0 {
                return Err("旋转体 base/height 必须大于 0".to_string());
            }
            let top = if top > 0.0 { top } else { 0.0 };
            std::f64::consts::PI * height / 3.0 * (base * base + base * top + top * top)
        }
        _ => return Err("体积积分只支持 sphere/box/conic 域".to_string()),
    };
    Ok(local * crate::transform_core::affine_volume_scale(descriptor.matrix))
}

/// 实体沿局部 y 轴的切片几何参数.
enum SliceFamily {
    /// 圆盘族(球/圆台):切片为圆心 (cx,cz),半径 R(u) 的圆盘.
    #[allow(clippy::type_complexity)]
    Disk {
        cx: f64,
        cz: f64,
        u0: f64,
        u1: f64,
        radius: Box<dyn Fn(f64) -> f64>,
    },
    /// 矩形族(方块):切片为定宽定高的矩形.
    Rect {
        x0: f64,
        x1: f64,
        z0: f64,
        z1: f64,
        u0: f64,
        u1: f64,
    },
}

fn conic_radius_at(base: f64, top: f64, height: f64, u: f64) -> f64 {
    // 局部 y = u ∈ [-h/2, +h/2],半径随 u 线性从 base -> top.
    base + (top - base) * ((u + height * 0.5) / height)
}

fn solid_slice_family(descriptor: &ObjectDescriptor) -> Result<SliceFamily, String> {
    let p = &descriptor.params;
    match descriptor.kind {
        ObjectKind::Sphere => {
            let (cx, cy, cz, radius) = (p[0], p[1], p[2], p[3]);
            Ok(SliceFamily::Disk {
                cx,
                cz,
                u0: cy - radius,
                u1: cy + radius,
                radius: Box::new(move |u: f64| {
                    let d = u - cy;
                    let rr = radius * radius - d * d;
                    if rr <= 0.0 {
                        0.0
                    } else {
                        rr.sqrt()
                    }
                }),
            })
        }
        ObjectKind::Conic => {
            let (cx, cy, cz, base, top, height) = (p[0], p[1], p[2], p[3], p[4], p[5]);
            Ok(SliceFamily::Disk {
                cx,
                cz,
                u0: cy - height * 0.5,
                u1: cy + height * 0.5,
                radius: Box::new(move |u: f64| conic_radius_at(base, top, height, u)),
            })
        }
        ObjectKind::Box => {
            let (cx, cy, cz) = (p[0], p[1], p[2]);
            let (sx, sy, sz) = (p[3], p[4], p[5]);
            Ok(SliceFamily::Rect {
                x0: cx - sx * 0.5,
                x1: cx + sx * 0.5,
                z0: cz - sz * 0.5,
                z1: cz + sz * 0.5,
                u0: cy - sy * 0.5,
                u1: cy + sy * 0.5,
            })
        }
        _ => Err("体积积分只支持 sphere/box/conic 域".to_string()),
    }
}

/// C2 内层(片内)二维积分:返回 I(u) = ∫∫_{slice(u)} g(M·p) dA_local.
/// 采用"中点积分离散"(对圆盘用极坐标 ρ∈[0,R],φ∈[0,2π],乘雅可比 ρ),
/// 外层轴向再由方法(trapezoid/simpson)做 1D 积分,总积分乘 |det M|.
///
/// NaN/掩码语义:片内某采样单元非有限(被积函数只在部分定义域上有值)
/// 时**只跳过该单元**,与 C1 网格/riemann/lebesgue 的掩码一致,不会把
/// 整片清零.求值 `Err` 照常上抛.
#[allow(clippy::too_many_arguments)]
fn slice_inner_integral(
    family: &SliceFamily,
    matrix: Option<Mat4>,
    integrand: &mut CompiledEvaluator,
    u: f64,
    sub: usize,
) -> Result<f64, String> {
    let sub = sub.max(2);
    match family {
        SliceFamily::Disk { cx, cz, radius, .. } => {
            let r = radius(u);
            if r <= 0.0 {
                return Ok(0.0);
            }
            let hr = r / sub as f64;
            let hphi = std::f64::consts::TAU / sub as f64;
            // 中点积分离散:∫∫ g ρ dρ dφ ≈ Σ g(ρ_i, φ_j) ρ_i hr hφ
            let mut sum = 0.0;
            for i in 0..sub {
                let rho = (i as f64 + 0.5) * hr;
                for j in 0..sub {
                    let phi = (j as f64 + 0.5) * hphi;
                    let local = [cx + rho * phi.cos(), u, cz + rho * phi.sin()];
                    let world = apply_to_point(
                        matrix.unwrap_or(crate::transform_core::identity4()),
                        local[0],
                        local[1],
                        local[2],
                    );
                    let Some(g) = integrand.eval_at(world[0], world[1], world[2])? else {
                        continue; // 非有限/无定义:该单元不贡献测度(掩码).
                    };
                    sum += g * rho;
                }
            }
            Ok(sum * hr * hphi)
        }
        SliceFamily::Rect { x0, x1, z0, z1, .. } => {
            let hx = (x1 - x0) / sub as f64;
            let hz = (z1 - z0) / sub as f64;
            let mut sum = 0.0;
            for i in 0..sub {
                let x = x0 + (i as f64 + 0.5) * hx;
                for j in 0..sub {
                    let z = z0 + (j as f64 + 0.5) * hz;
                    let world = apply_to_point(
                        matrix.unwrap_or(crate::transform_core::identity4()),
                        x,
                        u,
                        z,
                    );
                    let Some(g) = integrand.eval_at(world[0], world[1], world[2])? else {
                        continue; // 非有限/无定义:该单元不贡献测度(掩码).
                    };
                    sum += g;
                }
            }
            Ok(sum * hx * hz)
        }
    }
}

/// C2:轴向切片积分(trapezoid/simpson 的体积数值路径).
fn solid_axial_value(
    method: IntegralMethod,
    descriptor: &ObjectDescriptor,
    integrand: &mut CompiledEvaluator,
    n: usize,
) -> Result<f64, String> {
    let family = solid_slice_family(descriptor)?;
    let (u0, u1) = match &family {
        SliceFamily::Disk { u0, u1, .. } => (*u0, *u1),
        SliceFamily::Rect { u0, u1, .. } => (*u0, *u1),
    };
    if n == 0 {
        return Err("solid 积分需要 n > 0".to_string());
    }
    let h = (u1 - u0) / n as f64;
    let mut outer = Vec::with_capacity(n + 1);
    for k in 0..=n {
        let u = u0 + k as f64 * h;
        outer.push(slice_inner_integral(
            &family,
            descriptor.matrix,
            integrand,
            u,
            n,
        )?);
    }
    let local = integrate_1d_values(&outer, u0, u1, method)?;
    Ok(local * crate::transform_core::affine_volume_scale(descriptor.matrix))
}

/// solid 域积分统一入口(数值主路径).
///
/// - riemann 家族与 lebesgue(非平凡 f):C1 世界网格,采样端 = 方法端,
///   点在体内(隐式场 ≤ 0)即计入;
/// - trapezoid/simpson:C2 轴向切片.注意精度语义:**内层是 n×n 中点积分离散**
///   (片内积分只有二阶),外层才是 Simpson/梯形的一维轴向和--总误差由内层
///   主导,名义上仍是 O(1/n²) 的"切片中点法",不是四阶 Simpson.对 f≡1 时
///   内层中点恰好精确,外层 I(u) 又恰为二次函数,所以常量测试看起来"精确".
/// - lebesgue + f≡1 由 Worker 直接返回测度,不走层几何(见 lib.rs).
pub fn integrate_solid(
    method: IntegralMethod,
    descriptor: &ObjectDescriptor,
    integrand_expr: &str,
    integrand_names: &[String],
    integrand_values: &[f64],
    n: usize,
    layers: usize,
) -> Result<SolidOutcome, String> {
    if n == 0 {
        return Err("solid 积分需要 n > 0".to_string());
    }
    if n > MAX_SOLID_N {
        return Err(format!("solid 积分 n 超过上限 {MAX_SOLID_N}"));
    }
    let aabb = solid_world_aabb(descriptor)?;
    let mut probe = SolidProbe::new(descriptor)?;
    let mut integrand = CompiledEvaluator::new(integrand_expr, integrand_names, integrand_values)?;

    let value = match method {
        IntegralMethod::RiemannLeft | IntegralMethod::RiemannRight | IntegralMethod::RiemannMid => {
            let (samples, volume) = solid_cell_grid(method, &mut probe, &mut integrand, aabb, n)?;
            let mut sum = 0.0;
            for &z in &samples {
                if z.is_finite() {
                    sum += z;
                }
            }
            sum * volume
        }
        IntegralMethod::Trapz | IntegralMethod::Simpson => {
            solid_axial_value(method, descriptor, &mut integrand, n)?
        }
        IntegralMethod::Lebesgue => {
            // 非平凡 f:C1 层(勒贝格测度按层计数);f≡1 在 Worker 层短路返回测度.
            let (samples, volume) = solid_cell_grid(method, &mut probe, &mut integrand, aabb, n)?;
            lebesgue_solid_value(&samples, volume, layers)?
        }
    };

    // 返回可视化体元样本(与 C1 采样端同源).
    // C2(trapz/simpson)数值走轴向切片,不产出体元样本,这里刻意再跑一遍
    // C1 中点网格(仅画面)--成本同为 O(n³),重复采样是有意的,见文件头契约.
    let samples = if matches!(method, IntegralMethod::Trapz | IntegralMethod::Simpson) {
        let (samples, _) = solid_cell_grid(
            IntegralMethod::RiemannMid,
            &mut probe,
            &mut integrand,
            aabb,
            n,
        )?;
        samples
    } else {
        let (samples, _) = solid_cell_grid(method, &mut probe, &mut integrand, aabb, n)?;
        samples
    };

    Ok(SolidOutcome {
        value,
        samples,
        n,
        x_min: aabb.0[0],
        x_max: aabb.0[1],
        y_min: aabb.1[0],
        y_max: aabb.1[1],
        z_min: aabb.2[0],
        z_max: aabb.2[1],
    })
}

// ================================================================
// 常量积分测试辅助(纯 Rust 对拍)
// ================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry_core::parse_object_descriptor;

    const PI: f64 = std::f64::consts::PI;

    fn coeff(names: &[&str], values: &[f64]) -> (Vec<String>, Vec<f64>) {
        (
            names.iter().map(|s| s.to_string()).collect(),
            values.to_vec(),
        )
    }

    #[test]
    fn region_area_between_parabola_and_line() {
        // D = { -1 ≤ x ≤ 1, 0 ≤ y ≤ 1 - x² };面积 = 4/3 ≈ 1.333333...
        // 边界曲线:y = 0 与 y = 1 - x².
        let (n1, v1) = coeff(&[], &[]);
        let input = RegionInput {
            integrand_expr: "1",
            integrand_names: &n1,
            integrand_values: &v1,
            boundary_exprs: ["0", "1 - x * x"],
            boundary_names: [&n1, &n1],
            boundary_values: [&v1, &v1],
            xa: -1.0,
            xb: 1.0,
        };
        let trapz = integrate_region(IntegralMethod::Trapz, &input, 200, 8).unwrap();
        assert!(
            (trapz.value - 4.0 / 3.0).abs() < 1e-4,
            "trapz {}",
            trapz.value
        );
        let simpson = integrate_region(IntegralMethod::Simpson, &input, 200, 8).unwrap();
        assert!(
            (simpson.value - 4.0 / 3.0).abs() < 1e-9,
            "simpson {}",
            simpson.value
        );
        // f≡1 时 lebesgue 收敛到面积.
        let lebesgue = integrate_region(IntegralMethod::Lebesgue, &input, 400, 16).unwrap();
        assert!(
            (lebesgue.value - 4.0 / 3.0).abs() < 5e-3,
            "lebesgue {}",
            lebesgue.value
        );
    }

    #[test]
    fn region_area_semicircle_upper_half() {
        // D = { -1 ≤ x ≤ 1, 0 ≤ y ≤ sqrt(1-x²) };面积 = π/2.
        let (n1, v1) = coeff(&[], &[]);
        let input = RegionInput {
            integrand_expr: "1",
            integrand_names: &n1,
            integrand_values: &v1,
            boundary_exprs: ["0", "sqrt(1 - x * x)"],
            boundary_names: [&n1, &n1],
            boundary_values: [&v1, &v1],
            xa: -1.0,
            xb: 1.0,
        };
        let simpson = integrate_region(IntegralMethod::Simpson, &input, 256, 8).unwrap();
        assert!((simpson.value - PI / 2.0).abs() < 2e-3, "{}", simpson.value);
        let riemann_mid = integrate_region(IntegralMethod::RiemannMid, &input, 512, 8).unwrap();
        assert!(
            (riemann_mid.value - PI / 2.0).abs() < 1e-2,
            "{}",
            riemann_mid.value
        );
    }

    #[test]
    fn region_integrates_polynomial_over_triangle() {
        // D = {0≤x≤1, 0≤y≤x};∬_D x dA = ∫_0^1 x·x dx = 1/3.
        let (n1, v1) = coeff(&[], &[]);
        let input = RegionInput {
            integrand_expr: "x",
            integrand_names: &n1,
            integrand_values: &v1,
            boundary_exprs: ["0", "x"],
            boundary_names: [&n1, &n1],
            boundary_values: [&v1, &v1],
            xa: 0.0,
            xb: 1.0,
        };
        let simpson = integrate_region(IntegralMethod::Simpson, &input, 128, 8).unwrap();
        assert!(
            (simpson.value - 1.0 / 3.0).abs() < 1e-7,
            "{}",
            simpson.value
        );
        let right = integrate_region(IntegralMethod::RiemannRight, &input, 512, 8).unwrap();
        assert!((right.value - 1.0 / 3.0).abs() < 5e-3, "{}", right.value);
        let left = integrate_region(IntegralMethod::RiemannLeft, &input, 512, 8).unwrap();
        assert!((left.value - 1.0 / 3.0).abs() < 5e-3, "{}", left.value);
    }

    fn sphere_descriptor(r: f64) -> ObjectDescriptor {
        parse_object_descriptor(
            "sphere",
            "",
            vec![],
            vec![],
            vec![0.0, 0.0, 0.0, r],
            vec![],
            vec![],
        )
        .unwrap()
    }

    fn box_descriptor(sx: f64, sy: f64, sz: f64) -> ObjectDescriptor {
        parse_object_descriptor(
            "box",
            "",
            vec![],
            vec![],
            vec![1.0, 2.0, -1.0, sx, sy, sz],
            vec![],
            vec![],
        )
        .unwrap()
    }

    fn conic_descriptor(base: f64, top: f64, height: f64) -> ObjectDescriptor {
        parse_object_descriptor(
            "conic",
            "",
            vec![],
            vec![],
            vec![0.0, 0.0, 0.0, base, top, height],
            vec![],
            vec![],
        )
        .unwrap()
    }

    #[test]
    fn solid_volume_sphere_c2_close_to_analytic() {
        let (n1, v1) = coeff(&[], &[]);
        let r = 1.7;
        let descriptor = sphere_descriptor(r);
        let simpson =
            integrate_solid(IntegralMethod::Simpson, &descriptor, "1", &n1, &v1, 48, 8).unwrap();
        let analytic = 4.0 / 3.0 * PI * r * r * r;
        assert!(
            (simpson.value - analytic).abs() < 1e-3 * analytic,
            "simpson {} vs {}",
            simpson.value,
            analytic
        );
    }

    #[test]
    fn solid_volume_box_c1_approximates_analytic() {
        let (n1, v1) = coeff(&[], &[]);
        let descriptor = box_descriptor(2.0, 1.0, 3.0);
        let left = integrate_solid(
            IntegralMethod::RiemannLeft,
            &descriptor,
            "1",
            &n1,
            &v1,
            64,
            8,
        )
        .unwrap();
        assert!((left.value - 6.0).abs() < 1e-9, "left {}", left.value);
        let mid = integrate_solid(
            IntegralMethod::RiemannMid,
            &descriptor,
            "1",
            &n1,
            &v1,
            64,
            8,
        )
        .unwrap();
        assert!((mid.value - 6.0).abs() < 1e-9, "mid {}", mid.value);
    }

    #[test]
    fn solid_volume_cylinder_and_cone() {
        let (n1, v1) = coeff(&[], &[]);
        // 圆柱 R=1, h=2 -> 2π.
        let cylinder = conic_descriptor(1.0, 1.0, 2.0);
        let c_value =
            integrate_solid(IntegralMethod::Simpson, &cylinder, "1", &n1, &v1, 48, 8).unwrap();
        assert!(
            (c_value.value - 2.0 * PI).abs() < 1e-3,
            "cylinder {} vs {}",
            c_value.value,
            2.0 * PI
        );
        // 圆锥 base=2, h=3 -> 4π/3·?公式 πR²h/3 = π*4*3/3 = 4π.
        let cone = conic_descriptor(2.0, 0.0, 3.0);
        let k_value =
            integrate_solid(IntegralMethod::Simpson, &cone, "1", &n1, &v1, 48, 8).unwrap();
        assert!(
            (k_value.value - 4.0 * PI).abs() < 1e-3,
            "cone {} vs {}",
            k_value.value,
            4.0 * PI
        );
    }

    #[test]
    fn solid_transform_scales_volume_by_determinant() {
        let (n1, v1) = coeff(&[], &[]);
        let descriptor = parse_object_descriptor(
            "sphere",
            "",
            vec![],
            vec![],
            vec![0.0, 0.0, 0.0, 1.0],
            vec![
                2.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 5.0, 0.0, 0.0, 0.0, 1.0,
            ],
            vec![],
        )
        .unwrap();
        // M = scale(2,1,1)·translate? 上表 = 列主序?不:parse 直接收行主序,这里
        // 采用 scale(2,1,1) 后平移 (0,0,5):|det|=2,体积 = 2·4π/3.
        let value =
            integrate_solid(IntegralMethod::Simpson, &descriptor, "1", &n1, &v1, 48, 8).unwrap();
        let analytic = 2.0 * 4.0 / 3.0 * PI;
        assert!(
            (value.value - analytic).abs() < 1e-3 * analytic,
            "{} vs {}",
            value.value,
            analytic
        );
    }

    #[test]
    fn solid_integrates_linear_integrand_world_coords() {
        let (n1, v1) = coeff(&[], &[]);
        // 单位球上 ∭ x dV = 0;∭ (x+y+z) dV = 0.
        let descriptor = sphere_descriptor(1.0);
        let value = integrate_solid(
            IntegralMethod::Simpson,
            &descriptor,
            "x + y + z",
            &n1,
            &v1,
            48,
            8,
        )
        .unwrap();
        assert!(value.value.abs() < 1e-9, "{}", value.value);
    }

    #[test]
    fn solid_exact_measure_matches_analytic_formulas() {
        // f≡1 的 3D lebesgue 直接走解析测度,不依赖网格.
        let sphere = sphere_descriptor(2.0);
        let value = solid_exact_measure(&sphere).unwrap();
        assert!(
            (value - 4.0 / 3.0 * PI * 8.0).abs() < 1e-9,
            "sphere {}",
            value
        );

        let box_value = solid_exact_measure(&box_descriptor(2.0, 1.0, 3.0)).unwrap();
        assert!((box_value - 6.0).abs() < 1e-12);

        let cone = conic_descriptor(2.0, 0.0, 3.0);
        let cone_value = solid_exact_measure(&cone).unwrap();
        assert!((cone_value - 4.0 * PI).abs() < 1e-9, "cone {}", cone_value);

        let frustum = conic_descriptor(2.0, 1.0, 3.0);
        let frustum_value = solid_exact_measure(&frustum).unwrap();
        // πh/3·(R²+Rr+r²) = π·1·(4+2+1) = 7π.
        assert!(
            (frustum_value - 7.0 * PI).abs() < 1e-9,
            "frustum {}",
            frustum_value
        );
    }

    #[test]
    fn solid_exact_measure_applies_affine_volume_scale() {
        let descriptor = parse_object_descriptor(
            "sphere",
            "",
            vec![],
            vec![],
            vec![0.0, 0.0, 0.0, 1.0],
            vec![
                2.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 5.0, 0.0, 0.0, 0.0, 1.0,
            ],
            vec![],
        )
        .unwrap();
        // |det| = 2,单位球体积 × 2 = 8π/3.
        let value = solid_exact_measure(&descriptor).unwrap();
        let analytic = 2.0 * 4.0 / 3.0 * PI;
        assert!((value - analytic).abs() < 1e-9, "{} vs {}", value, analytic);
    }

    // ------------------------------------------------------------
    // 审查回归:NaN 掩码(单点非有限不得清零整条内层积分/整片)
    // ------------------------------------------------------------

    /// P1 回归:region 单位带 [0,1]²,integrand = sqrt(y - 0.5)(y<0.5 处
    /// 非有限).旧实现只要内层线上有一个 NaN 就把整条内层积分按 0 处理,
    /// simpson/trapezoid 整体静默返回 0.0;掩码语义下应得到
    /// ∫_0^1∫_{0.5}^1 sqrt(y-0.5) dy dx = 2/3·(1/2)^{3/2} ≈ 0.2357.
    #[test]
    fn region_partially_undefined_integrand_masks_instead_of_zeroing_columns() {
        let (n1, v1) = coeff(&[], &[]);
        let band = RegionInput {
            integrand_expr: "sqrt(y - 0.5)",
            integrand_names: &n1,
            integrand_values: &v1,
            boundary_exprs: ["0", "1"],
            boundary_names: [&n1, &n1],
            boundary_values: [&v1, &v1],
            xa: 0.0,
            xb: 1.0,
        };
        let analytic = 2.0 / 3.0 * (0.5f64).powf(1.5); // ≈ 0.2357

        for method in [IntegralMethod::Trapz, IntegralMethod::Simpson] {
            let coarse = integrate_region(method, &band, 64, 16).unwrap();
            let fine = integrate_region(method, &band, 256, 16).unwrap();
            assert!(
                coarse.value > 0.0,
                "{method:?} 把部分定义域的被积函数静默清零了"
            );
            // 网格加细应收敛到解析值(掩码零点处的间断使收敛慢于光滑情形,
            // 容差按 O(1/n) 主导估计).
            assert!(
                (fine.value - analytic).abs() < 2e-2,
                "{method:?}: fine {} vs 解析 {analytic}",
                fine.value
            );
        }
    }

    /// 对照:完全定义域的同类被积函数不受掩码路径影响.
    #[test]
    fn region_fully_defined_sqrt_integrand_unchanged() {
        let (n1, v1) = coeff(&[], &[]);
        let band = RegionInput {
            integrand_expr: "sqrt(y + 0.5)",
            integrand_names: &n1,
            integrand_values: &v1,
            boundary_exprs: ["0", "1"],
            boundary_names: [&n1, &n1],
            boundary_values: [&v1, &v1],
            xa: 0.0,
            xb: 1.0,
        };
        // ∫_0^1 sqrt(y+0.5) dy = 2/3·(1.5^{1.5} - 0.5^{1.5}) ≈ 1.1134.
        let analytic = 2.0 / 3.0 * (1.5f64.powf(1.5) - 0.5f64.powf(1.5));
        let value = integrate_region(IntegralMethod::Simpson, &band, 256, 16).unwrap();
        assert!(
            (value.value - analytic).abs() < 1e-6,
            "{} vs {analytic}",
            value.value
        );
    }

    /// solid C2 掩码:单位球,integrand = sqrt(z)(z<0 半球的采样非有限).
    /// 旧实现任一片内一个 NaN 就把整片清零;掩码后应得到与 C1 网格
    /// (riemann:mid 同为掩码语义)互相一致的正值.
    #[test]
    fn solid_partially_undefined_integrand_masks_instead_of_zeroing_slices() {
        let (n1, v1) = coeff(&[], &[]);
        let descriptor = sphere_descriptor(1.0);
        let simpson = integrate_solid(
            IntegralMethod::Simpson,
            &descriptor,
            "sqrt(z)",
            &n1,
            &v1,
            48,
            8,
        )
        .unwrap();
        let c1_mid = integrate_solid(
            IntegralMethod::RiemannMid,
            &descriptor,
            "sqrt(z)",
            &n1,
            &v1,
            96,
            8,
        )
        .unwrap();
        assert!(simpson.value > 0.0, "C2 掩码把部分定义域的被积函数清零了");
        assert!(c1_mid.value > 0.0);
        let scale = simpson.value.abs().max(1e-9);
        assert!(
            (simpson.value - c1_mid.value).abs() < 0.05 * scale,
            "C2 {} 与 C1 {} 应互为参照",
            simpson.value,
            c1_mid.value
        );
    }

    // ------------------------------------------------------------
    // 审查回归:3D solid simpson/trapezoid 只是 O(1/n²) 的切片中点法
    // ------------------------------------------------------------

    /// 一般被积函数 ∭(x²+y²+z²) dV = 4π/5:误差按 O(1/n²) 衰减
    /// (每翻倍 ≈ 1/4),不是四阶 Simpson 的 1/16.旧测试只覆盖 f≡1,
    /// 内层中点恰好精确,外层 I(u) 又恰为二次函数,把这一点完全遮住.
    #[test]
    fn solid_simpson_on_general_integrand_is_second_order() {
        let (n1, v1) = coeff(&[], &[]);
        let descriptor = sphere_descriptor(1.0);
        let analytic = 4.0 / 5.0 * PI;
        let mut errors = Vec::new();
        for &n in &[8usize, 16, 32, 64] {
            let value = integrate_solid(
                IntegralMethod::Simpson,
                &descriptor,
                "x*x + y*y + z*z",
                &n1,
                &v1,
                n,
                8,
            )
            .unwrap()
            .value;
            errors.push((value - analytic).abs());
        }
        for pair in errors.windows(2) {
            let ratio = pair[1] / pair[0];
            assert!(
                (0.12..0.5).contains(&ratio),
                "相邻误差比 {ratio} 应 ≈ 1/4(O(1/n²));误差序列 {errors:?}"
            );
        }
        assert!(errors[3] < 5e-4, "n=64 误差 {errors:?}");
    }
}
