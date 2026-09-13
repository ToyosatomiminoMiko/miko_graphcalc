//! 求交数值内核(原 IntersectionMath.ts 的 Rust 移植).
//!
//! 设计约束:
//! - 表达式只解析一次,上下文只构建一次,后续逐点求值都复用;
//! - 所有坐标均为世界坐标,对象静态 transform 在描述符进入内核前已经附带;
//! - 对象描述是可序列化的枚举数据,不携带跨 WASM 边界的闭包;
//! - marching squares 的鞍点歧义与旧 TS 实现保持一致(中心符号判定).
//!
//! 行为契约:
//! - **所有几何容差都是相对尺度**(随坐标量级缩放,见 find_1d_roots /
//!   dedupe_* / 顶点量化),场景整体缩放到任意量级都不该改变拓扑--
//!   新容差一律相对化,禁止再引入硬编码绝对半径/绝对量化;
//! - segments 规模护栏在 [`compute_pair`] 入口执行(见 config),marching
//!   squares 单元数与 curve×curve 空间候选对都是 O(segments²);
//! - 顶点池去重(vertex key)与点/根去重语义一致:视作"同一几何顶点"合并,
//!   防止跨单元同一边两侧的浮点差产生缝隙.
//!
//! 模块边界(2026 架构审查):对象描述符模型/解析与隐式场(FieldEval /
//! SolidProbe / solid_world_aabb)已抽到共享的 [`crate::geometry_core`]--
//! 体积积分(domain_integral / lib.rs::integrate_solid)与求交各取所需,
//! 本模块只保留求交算法(曲线求根/参数化面片/marching squares/顶层编排),
//! 依赖方向为 `domain_integral -> geometry_core ← intersection_core`.
//! 参与方描述仍以 ObjectDescriptor 给出,公开面经 `pub use` 维持.
//!
//! 本模块不直接依赖 wasm-bindgen,便于在 `cargo test` 里做纯 Rust 验证.

use std::cmp::Ordering;
use std::collections::HashMap;

use crate::config::MAX_INTERSECTION_SEGMENTS;
use crate::eval_core::CompiledEvaluator;
use crate::geometry_core::{check_conic_params, FieldEval};
use crate::sampling_core::uniform_nodes;
use crate::transform_core::{apply_to_point, Mat4};

const TAU: f64 = std::f64::consts::TAU;

/// 旋转体端盖存在性判定:半径小于"旋转体自身尺度"的该比例时视为退化,
/// 不生成端盖.相对容差随几何缩放,不再用硬编码绝对 1e-9.
const CONIC_CAP_RELATIVE_EPSILON: f64 = 1e-9;

/// 去重半径的基础系数.实际去重按"点集直径 / 根集跨度"等几何自身尺度缩放,
/// 见 `dedupe_point_tolerance` / `dedupe_root_tolerance`(坐标绝对值不参与).
const POINT_DEDUP_TOLERANCE: f64 = 1e-5;
/// 顶点池坐标量化的相对精度:key = round(坐标 · VERTEX_QUANTUM / 该点量级),
/// 等价于"相对 1e-6 精度"量化(旧实现与 TS 的 toFixed(6) 是绝对 1e-6,
/// 场景整体缩小时会把不同顶点错误合并;202609 审查后改相对,见 vertex_key).
const VERTEX_QUANTUM: f64 = 1e6;

type V3 = [f64; 3];

/// 顶点池的坐标量化键:按该顶点自身的坐标量级取相对精度,
/// 使"同一几何顶点的两次计算(±ulp)"必然命中同键,而真实不同的顶点
/// (间距 ~ 网格步长)永不并键.
fn vertex_key(p: V3) -> (i64, i64, i64) {
    let scale = p.iter().fold(0.0f64, |max, &c| max.max(c.abs())).max(1e-6);
    let factor = VERTEX_QUANTUM / scale;
    (
        (p[0] * factor).round() as i64,
        (p[1] * factor).round() as i64,
        (p[2] * factor).round() as i64,
    )
}

#[derive(Clone, Copy)]
struct Crossing {
    u: f64,
    v: f64,
}

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn dist(a: V3, b: V3) -> f64 {
    (sub(a, b)).iter().map(|v| v * v).sum::<f64>().sqrt()
}

fn midpoint(a: V3, b: V3) -> V3 {
    [
        (a[0] + b[0]) * 0.5,
        (a[1] + b[1]) * 0.5,
        (a[2] + b[2]) * 0.5,
    ]
}

fn clamp(value: f64, lo: f64, hi: f64) -> f64 {
    value.max(lo).min(hi)
}

fn finite(value: f64) -> bool {
    value.is_finite()
}

fn to_world(matrix: Option<Mat4>, local: V3) -> V3 {
    match matrix {
        Some(matrix) => apply_to_point(matrix, local[0], local[1], local[2]),
        None => local,
    }
}

// ================================================================
// 对象几何:geometry_core re-export
// ================================================================

/// 对象描述符模型与解析由共享几何层统一提供(求交与体积积分同一口径),
/// 参与方/域仍以 ObjectDescriptor 描述;布局见 [`crate::geometry_core`].
pub use crate::geometry_core::{parse_object_descriptor, ObjectDescriptor, ObjectKind};

struct CurveEval {
    expr: CompiledEvaluator,
    range: [f64; 2],
}

impl CurveEval {
    fn new(descriptor: &ObjectDescriptor) -> Result<Self, String> {
        let expr = CompiledEvaluator::new(
            &descriptor.expr,
            &descriptor.coefficient_names,
            &descriptor.coefficient_values,
        )?;
        let x0: f64 = descriptor.params[0];
        let x1: f64 = descriptor.params[1];
        if x0.partial_cmp(&x1) != Some(Ordering::Less) {
            return Err("曲线 range 需要 min < max".to_string());
        }
        Ok(Self {
            expr,
            range: [x0, x1],
        })
    }

    fn eval_y(&mut self, x: f64) -> Result<Option<f64>, String> {
        self.expr.eval_1d(x)
    }

    fn world_at(&mut self, matrix: Option<Mat4>, x: f64) -> Result<Option<V3>, String> {
        match self.eval_y(x)? {
            Some(y) if finite(y) => Ok(Some(to_world(matrix, [x, y, 0.0]))),
            _ => Ok(None),
        }
    }
}

fn sample_curve(
    expr: &mut CurveEval,
    matrix: Option<Mat4>,
    steps: usize,
) -> Result<Vec<(f64, V3)>, String> {
    let [lo, hi] = expr.range;
    let mut samples: Vec<(f64, [f64; 3])> = Vec::with_capacity(steps + 1);
    for x in uniform_nodes(lo, hi, steps) {
        if let Some(point) = expr.world_at(matrix, x)? {
            samples.push((x, point));
        }
    }
    Ok(samples)
}

// ================================================================
// 参数化面片
// ================================================================

struct SurfaceGrid {
    z_values: Vec<f64>,
    nx: usize,
    ny: usize,
    range: [f64; 4],
    matrix: Option<Mat4>,
}

impl SurfaceGrid {
    fn new(descriptor: &ObjectDescriptor, nx: usize, ny: usize) -> Result<Self, String> {
        let [xa, xb, ya, yb] = [
            descriptor.params[0],
            descriptor.params[1],
            descriptor.params[2],
            descriptor.params[3],
        ];
        if !(xa < xb && ya < yb) {
            return Err("曲面 range 需要 min < max".to_string());
        }
        let z_values: Vec<f64> = crate::sampling_core::sample_surface_values(
            &descriptor.expr,
            &descriptor.coefficient_names,
            &descriptor.coefficient_values,
            xa,
            xb,
            ya,
            yb,
            nx,
            ny,
        )?;
        Ok(Self {
            z_values,
            nx,
            ny,
            range: [xa, xb, ya, yb],
            matrix: descriptor.matrix,
        })
    }

    fn bilinear_z(&self, u: f64, v: f64) -> Option<f64> {
        let [xa, xb, ya, yb] = self.range;
        let xf = ((u - xa) / (xb - xa)) * self.nx as f64;
        let yf = ((v - ya) / (yb - ya)) * self.ny as f64;
        let i0 = clamp(xf.floor(), 0.0, (self.nx - 1) as f64) as usize;
        let j0 = clamp(yf.floor(), 0.0, (self.ny - 1) as f64) as usize;
        let i1 = (i0 + 1).min(self.nx);
        let j1 = (j0 + 1).min(self.ny);
        let tx = clamp(xf - i0 as f64, 0.0, 1.0);
        let ty = clamp(yf - j0 as f64, 0.0, 1.0);
        let width = self.nx + 1;
        let z00 = self.z_values[j0 * width + i0];
        let z10 = self.z_values[j0 * width + i1];
        let z01 = self.z_values[j1 * width + i0];
        let z11 = self.z_values[j1 * width + i1];
        if !finite(z00) || !finite(z10) || !finite(z01) || !finite(z11) {
            return None;
        }
        let bottom = z00 + (z10 - z00) * tx;
        let top = z01 + (z11 - z01) * tx;
        Some(bottom + (top - bottom) * ty)
    }

    fn point(&self, u: f64, v: f64) -> Option<V3> {
        let z = self.bilinear_z(u, v)?;
        Some(to_world(self.matrix, [u, v, z]))
    }
}

const SPHERE_FACES: [([f64; 3], [f64; 3], [f64; 3]); 6] = [
    ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
    ([-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
    ([0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
    ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
    ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
    ([0.0, 0.0, -1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]),
];

enum PatchShape {
    Surface(SurfaceGrid),
    SphereFace {
        center: V3,
        radius: f64,
        direction: V3,
        axis_a: V3,
        axis_b: V3,
        matrix: Option<Mat4>,
    },
    BoxFace {
        center: V3,
        direction: V3,
        axis_a: V3,
        axis_b: V3,
        hd: f64,
        matrix: Option<Mat4>,
    },
    ConicSide {
        center: V3,
        base_radius: f64,
        top_radius: f64,
        height: f64,
        matrix: Option<Mat4>,
    },
    ConicCap {
        center: V3,
        radius: f64,
        y_offset: f64,
        matrix: Option<Mat4>,
    },
}

struct PatchEval {
    u0: f64,
    u1: f64,
    v0: f64,
    v1: f64,
    shape: PatchShape,
}

impl PatchEval {
    fn point_valid(&self, u: f64, v: f64) -> (Option<V3>, bool) {
        match &self.shape {
            PatchShape::Surface(grid) => {
                let point = grid.point(u, v);
                (point, point.is_some())
            }
            PatchShape::SphereFace {
                center,
                radius,
                direction,
                axis_a,
                axis_b,
                matrix,
            } => {
                let length = (radius * radius + u * u + v * v).sqrt();
                let scale = radius / length;
                let mut local = [0.0; 3];
                for i in 0..3 {
                    local[i] =
                        center[i] + (direction[i] * radius + axis_a[i] * u + axis_b[i] * v) * scale;
                }
                (Some(to_world(*matrix, local)), true)
            }
            PatchShape::BoxFace {
                center,
                direction,
                axis_a,
                axis_b,
                hd,
                matrix,
            } => {
                let mut local = [0.0; 3];
                for i in 0..3 {
                    local[i] = center[i] + direction[i] * hd + axis_a[i] * u + axis_b[i] * v;
                }
                (Some(to_world(*matrix, local)), true)
            }
            PatchShape::ConicSide {
                center,
                base_radius,
                top_radius,
                height,
                matrix,
            } => {
                let radius_at = base_radius + (top_radius - base_radius) * (v / height);
                let local = [
                    center[0] + radius_at * u.cos(),
                    center[1] + v - height * 0.5,
                    center[2] + radius_at * u.sin(),
                ];
                (Some(to_world(*matrix, local)), true)
            }
            PatchShape::ConicCap {
                center,
                radius,
                y_offset,
                matrix,
            } => {
                let valid = v >= 0.0 && v <= radius + 1e-9;
                if valid {
                    let local = [
                        center[0] + v * u.cos(),
                        center[1] + y_offset,
                        center[2] + v * u.sin(),
                    ];
                    (Some(to_world(*matrix, local)), true)
                } else {
                    (None, false)
                }
            }
        }
    }

    fn point(&self, u: f64, v: f64) -> Option<V3> {
        self.point_valid(u, v).0
    }
}

fn build_surface_patch(
    descriptor: &ObjectDescriptor,
    segments: usize,
) -> Result<PatchEval, String> {
    let grid = SurfaceGrid::new(descriptor, segments, segments)?;
    Ok(PatchEval {
        u0: grid.range[0],
        u1: grid.range[1],
        v0: grid.range[2],
        v1: grid.range[3],
        shape: PatchShape::Surface(grid),
    })
}

fn build_sphere_patches(descriptor: &ObjectDescriptor) -> Result<Vec<PatchEval>, String> {
    let center = [
        descriptor.params[0],
        descriptor.params[1],
        descriptor.params[2],
    ];
    let radius = descriptor.params[3];
    if radius.partial_cmp(&0.0) != Some(Ordering::Greater) {
        return Err("球体 radius 必须大于 0".to_string());
    }
    Ok(SPHERE_FACES
        .iter()
        .map(|(direction, axis_a, axis_b)| PatchEval {
            u0: -radius,
            u1: radius,
            v0: -radius,
            v1: radius,
            shape: PatchShape::SphereFace {
                center,
                radius,
                direction: *direction,
                axis_a: *axis_a,
                axis_b: *axis_b,
                matrix: descriptor.matrix,
            },
        })
        .collect())
}

fn build_box_patches(descriptor: &ObjectDescriptor) -> Result<Vec<PatchEval>, String> {
    let center = [
        descriptor.params[0],
        descriptor.params[1],
        descriptor.params[2],
    ];
    let half = [
        descriptor.params[3] * 0.5,
        descriptor.params[4] * 0.5,
        descriptor.params[5] * 0.5,
    ];
    if half.iter().any(|value| *value <= 0.0) {
        return Err("方块 size 每个分量都必须大于 0".to_string());
    }
    // 每项: 方向,u 轴,v 轴,u 半长,v 半长,法向偏移.
    let faces = [
        (
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            half[1],
            half[2],
            half[0],
        ),
        (
            [-1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 1.0, 0.0],
            half[2],
            half[1],
            half[0],
        ),
        (
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            half[2],
            half[0],
            half[1],
        ),
        (
            [0.0, -1.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            half[0],
            half[2],
            half[1],
        ),
        (
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            half[0],
            half[1],
            half[2],
        ),
        (
            [0.0, 0.0, -1.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
            half[1],
            half[0],
            half[2],
        ),
    ];
    Ok(faces
        .iter()
        .map(|(direction, axis_a, axis_b, ar, br, hd)| PatchEval {
            u0: -ar,
            u1: *ar,
            v0: -br,
            v1: *br,
            shape: PatchShape::BoxFace {
                center,
                direction: *direction,
                axis_a: *axis_a,
                axis_b: *axis_b,
                hd: *hd,
                matrix: descriptor.matrix,
            },
        })
        .collect())
}

fn build_conic_patches(descriptor: &ObjectDescriptor) -> Result<Vec<PatchEval>, String> {
    let center = [
        descriptor.params[0],
        descriptor.params[1],
        descriptor.params[2],
    ];
    let base_radius = descriptor.params[3];
    let top_radius = descriptor.params[4];
    let height = descriptor.params[5];
    check_conic_params(base_radius, top_radius, height)?;
    let cap_scale = base_radius.max(top_radius).max(height);

    let mut patches = vec![PatchEval {
        u0: 0.0,
        u1: TAU,
        v0: 0.0,
        v1: height,
        shape: PatchShape::ConicSide {
            center,
            base_radius,
            top_radius,
            height,
            matrix: descriptor.matrix,
        },
    }];

    if base_radius > CONIC_CAP_RELATIVE_EPSILON * cap_scale {
        patches.push(PatchEval {
            u0: 0.0,
            u1: TAU,
            v0: 0.0,
            v1: base_radius,
            shape: PatchShape::ConicCap {
                center,
                radius: base_radius,
                y_offset: -height * 0.5,
                matrix: descriptor.matrix,
            },
        });
    }
    if top_radius > CONIC_CAP_RELATIVE_EPSILON * cap_scale {
        patches.push(PatchEval {
            u0: 0.0,
            u1: TAU,
            v0: 0.0,
            v1: top_radius,
            shape: PatchShape::ConicCap {
                center,
                radius: top_radius,
                y_offset: height * 0.5,
                matrix: descriptor.matrix,
            },
        });
    }
    Ok(patches)
}

fn build_patches(descriptor: &ObjectDescriptor, segments: usize) -> Result<Vec<PatchEval>, String> {
    match descriptor.kind {
        ObjectKind::Surface => Ok(vec![build_surface_patch(descriptor, segments)?]),
        ObjectKind::Sphere => build_sphere_patches(descriptor),
        ObjectKind::Box => build_box_patches(descriptor),
        ObjectKind::Conic => build_conic_patches(descriptor),
        ObjectKind::Curve => Err("曲线不能作为参数化面片".to_string()),
    }
}

// ================================================================
// 一维求根
// ================================================================

/// 采样点被判为"在表面上"(符号 0)的容差系数:与相邻采样步长量级
/// `max|f_i - f_{i±1}|`(≈|f'|·h)成比例,与整段区间的函数最大值无关.
const TANGENT_STEP_RATIO: f64 = 1.0;
/// 相切根残差复核系数:细化后的 |f| 必须不超过邻域函数量级的该倍数,
/// 否则判为"接近但未到达 0",丢弃.穿越型根由符号变化本身证明,不走此判据.
const CONTACT_RESIDUAL_RATIO: f64 = 1e-7;
/// 二分收敛的残差系数(相对二分区间端点的函数量级).
const BISECTION_RESIDUAL_RATIO: f64 = 1e-12;
/// 接触点三分细化迭代次数.
const CONTACT_REFINE_ITERATIONS: usize = 120;

/// 采样 + 跨号二分 + 接触段细化,返回参数位置.
///
/// 容差一律与**采样步长/局部函数尺度**挂钩,不用"整段区间的函数最大值":
/// - 采样点按局部量级 `max|f_i - f_{i±1}|`(≈|f'|·h)分类,落在容差内的
///   点视作"在表面上"(符号 0),相切/擦边因此不会被拆成成片假根;
/// - 严格跨号的相邻采样点用二分收敛;
/// - 相邻"在表面上"的采样点合并成接触段:段两侧异号(真实穿越)时二分;
///   两侧同号(相切)时取段内 |f| 最小的采样点做三分细化,再用"残差相对
///   邻域函数量级足够小"复核,复核不过则丢弃(避免大动态范围下的假根).
fn find_1d_roots<F>(f: &mut F, lo: f64, hi: f64, steps: usize) -> Result<Vec<f64>, String>
where
    F: FnMut(f64) -> Result<Option<f64>, String>,
{
    let mut xs = Vec::with_capacity(steps + 1);
    let mut values: Vec<Option<f64>> = Vec::with_capacity(steps + 1);
    for x in uniform_nodes(lo, hi, steps) {
        xs.push(x);
        values.push(f(x)?.filter(|value| value.is_finite()));
    }

    // 局部步长量级:|f_i - f_{i±1}| ≈ |f'|·h(端点只有唯一邻居).
    let step_scale = |i: usize| -> f64 {
        let Some(fi) = values[i] else {
            return 0.0;
        };
        let mut scale = 0.0f64;
        if i > 0 {
            if let Some(left) = values[i - 1] {
                scale = scale.max((fi - left).abs());
            }
        }
        if i + 1 < values.len() {
            if let Some(right) = values[i + 1] {
                scale = scale.max((fi - right).abs());
            }
        }
        scale
    };

    // 三值符号:+1 / 0(局部容差内视作在表面上)/ -1.
    let signs: Vec<i8> = (0..=steps)
        .map(|i| match values[i] {
            None => 0,
            Some(value) => {
                let tolerance = TANGENT_STEP_RATIO * step_scale(i);
                if value > tolerance {
                    1
                } else if value < -tolerance {
                    -1
                } else {
                    0
                }
            }
        })
        .collect();

    let mut roots = Vec::new();

    // 1) 严格跨号区间:二分.
    for i in 0..steps {
        if signs[i] == 0 || signs[i + 1] == 0 || signs[i] == signs[i + 1] {
            continue;
        }
        if let Some(root) = bisect_sign_change(f, xs[i], xs[i + 1], values[i], values[i + 1])? {
            roots.push(root);
        }
    }

    // 2) "在表面上"的连续采样段:段内细化 + 残差复核.
    let mut i = 0usize;
    while i <= steps {
        if signs[i] != 0 || values[i].is_none() {
            i += 1;
            continue;
        }
        let start = i;
        while i <= steps && signs[i] == 0 && values[i].is_some() {
            i += 1;
        }
        let end = i - 1;

        // 接触段两侧若为异号,段内必有一次真实穿越:用两侧端点二分.
        // 符号变化本身就是根存在的证明,残差只受浮点分辨率限制.
        let crossing = start > 0
            && end < steps
            && signs[start - 1] != 0
            && signs[end + 1] != 0
            && signs[start - 1] != signs[end + 1];
        if crossing {
            if let Some(root) = bisect_sign_change(
                f,
                xs[start - 1],
                xs[end + 1],
                values[start - 1],
                values[end + 1],
            )? {
                roots.push(root);
            }
            continue;
        }

        // 相切(两侧同号):段内取 |f| 最小的采样点做三分细化,再用
        // "细化残差相对邻域函数量级足够小"复核;接近但未到达 0 则丢弃.
        //
        // 已知分辨率限制(不修,记录在此):若两个真实交点落在**同一个**接触段
        // 内,且相距小于采样步长,这里只能给出一个解.曾尝试按 |f| 局部极大把
        // 接触段拆成多个邻域,但解决不了这种情形(段内 |f| 可能先降后升,没有
        // 可切的峰),反而在"曲线正好落在面上,采样点精确取 0"时把一连串零值
        // 点各自报成根.要真正分开需要提高采样分辨率或引入导数信息,属于新的
        // 数值能力,不在本轮范围内.
        let mut best_index = start;
        let mut best_abs = f64::INFINITY;
        for (j, value) in values.iter().enumerate().take(end + 1).skip(start) {
            if let Some(value) = value {
                if value.abs() < best_abs {
                    best_abs = value.abs();
                    best_index = j;
                }
            }
        }

        let left = if best_index == 0 {
            xs[0]
        } else {
            xs[best_index - 1]
        };
        let right = if best_index == steps {
            xs[steps]
        } else {
            xs[best_index + 1]
        };
        let refined = refine_contact(f, left, right)?;

        let mut local = 0.0f64;
        for value in values
            .iter()
            .take((end + 1).min(steps) + 1)
            .skip(start.saturating_sub(1))
            .flatten()
        {
            local = local.max(value.abs());
        }
        if let Some(residual) = f(refined)?.filter(|value| value.is_finite()).map(f64::abs) {
            if residual == 0.0 || residual <= CONTACT_RESIDUAL_RATIO * local {
                roots.push(refined);
            }
        }
    }

    Ok(roots)
}

/// 对已知跨号区间做二分;残差相对区间端点的函数量级校验.
fn bisect_sign_change<F>(
    f: &mut F,
    lo: f64,
    hi: f64,
    f_lo: Option<f64>,
    f_hi: Option<f64>,
) -> Result<Option<f64>, String>
where
    F: FnMut(f64) -> Result<Option<f64>, String>,
{
    let (Some(mut f_lo), Some(mut f_hi)) = (f_lo, f_hi) else {
        return Ok(None);
    };
    if (f_lo < 0.0) == (f_hi < 0.0) {
        return Ok(None);
    }
    let scale = f_lo.abs().max(f_hi.abs()).max(f64::MIN_POSITIVE);
    let mut lo_x = lo;
    let mut hi_x = hi;
    for _ in 0..200 {
        let mid = (lo_x + hi_x) * 0.5;
        let Some(value) = f(mid)?.filter(|value| value.is_finite()) else {
            break;
        };
        if value == 0.0 || value.abs() <= BISECTION_RESIDUAL_RATIO * scale {
            return Ok(Some(mid));
        }
        if (value < 0.0) == (f_lo < 0.0) {
            lo_x = mid;
            f_lo = value;
        } else {
            hi_x = mid;
            f_hi = value;
        }
        if hi_x - lo_x <= 1e-11 * (1.0 + lo_x.abs()) {
            return Ok(Some((lo_x + hi_x) * 0.5));
        }
    }
    if (f_lo < 0.0) != (f_hi < 0.0) {
        Ok(Some((lo_x + hi_x) * 0.5))
    } else {
        Ok(None)
    }
}

/// 在 [lo, hi] 上对 |f| 做三分搜索(该邻域内 |f| 近似单峰),返回极小点.
fn refine_contact<F>(f: &mut F, lo: f64, hi: f64) -> Result<f64, String>
where
    F: FnMut(f64) -> Result<Option<f64>, String>,
{
    let mut a = lo;
    let mut b = hi;
    for _ in 0..CONTACT_REFINE_ITERATIONS {
        let m1 = a + (b - a) / 3.0;
        let m2 = b - (b - a) / 3.0;
        let f1 = f(m1)?
            .filter(|value| value.is_finite())
            .map_or(f64::INFINITY, f64::abs);
        let f2 = f(m2)?
            .filter(|value| value.is_finite())
            .map_or(f64::INFINITY, f64::abs);
        if f1 <= f2 {
            b = m2;
        } else {
            a = m1;
        }
        if b - a <= f64::EPSILON * (1.0 + a.abs()) {
            break;
        }
    }
    Ok((a + b) * 0.5)
}

/// 去重半径 = 基础系数 × 几何自身尺度(点集直径 / 采样外接盒等),
/// 与坐标绝对值无关,因此整体平移不改变去重结果.
fn dedupe_tolerance_for_scale(scale: f64) -> f64 {
    POINT_DEDUP_TOLERANCE * scale
}

/// 点集的"直径"(外接盒对角线),作为几何自身尺度.
fn point_set_diameter(points: &[V3]) -> f64 {
    if points.is_empty() {
        return 0.0;
    }
    let mut mins = [f64::INFINITY; 3];
    let mut maxs = [f64::NEG_INFINITY; 3];
    for point in points {
        for axis in 0..3 {
            mins[axis] = mins[axis].min(point[axis]);
            maxs[axis] = maxs[axis].max(point[axis]);
        }
    }
    dist(mins, maxs)
}

/// 点集去重半径:按点集直径缩放.退化为单点/重合点集时半径为 0,
/// 仍靠"完全相等"合并重复点.
fn dedupe_point_tolerance(points: &[V3]) -> f64 {
    dedupe_tolerance_for_scale(point_set_diameter(points))
}

/// 按给定半径把一个点并入去重结果(与 [`dedupe_points`] 同一比较口径).
/// 半径由调用方按"该场景的几何尺度"给出,便于空间曲线路径增量去重.
fn push_deduped_point(result: &mut Vec<V3>, point: V3, tolerance: f64) {
    if !result
        .iter()
        .any(|existing| dist(*existing, point) <= tolerance)
    {
        result.push(point);
    }
}

fn dedupe_points(points: Vec<V3>) -> Vec<V3> {
    let tolerance = dedupe_point_tolerance(&points);
    let mut result: Vec<V3> = Vec::with_capacity(points.len());
    for point in points {
        push_deduped_point(&mut result, point, tolerance);
    }
    result
}

/// 一维根坐标的去重半径:按根集的参数跨度(几何自身尺度)缩放,
/// 同样是平移不变的;单根时半径为 0,仅合并完全相等的重复根.
fn dedupe_root_tolerance(roots: &[f64]) -> f64 {
    if roots.is_empty() {
        return 0.0;
    }
    let min = roots.iter().copied().fold(f64::INFINITY, f64::min);
    let max = roots.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    POINT_DEDUP_TOLERANCE * (max - min)
}

fn dedupe_roots(roots: Vec<f64>) -> Vec<f64> {
    let tolerance = dedupe_root_tolerance(&roots);
    let mut result: Vec<f64> = Vec::with_capacity(roots.len());
    for root in roots {
        if !result
            .iter()
            .any(|existing| (*existing - root).abs() <= tolerance)
        {
            result.push(root);
        }
    }
    result
}

// ================================================================
// 曲线 ∩ 曲线
// ================================================================

fn planar_curve_intersections(
    a: &ObjectDescriptor,
    b: &ObjectDescriptor,
    steps: usize,
) -> Result<Vec<V3>, String> {
    let mut curve_a = CurveEval::new(a)?;
    let mut curve_b = CurveEval::new(b)?;
    let lo = a.params[0].max(b.params[0]);
    let hi = a.params[1].min(b.params[1]);
    if lo.partial_cmp(&hi) != Some(Ordering::Less) {
        return Ok(Vec::new());
    }

    let roots = find_1d_roots(
        &mut |x| {
            let ya = curve_a.eval_y(x)?;
            let yb = curve_b.eval_y(x)?;
            match (ya, yb) {
                (Some(ya), Some(yb)) => Ok(Some(ya - yb)),
                _ => Ok(None),
            }
        },
        lo,
        hi,
        steps,
    )?;

    let mut points = Vec::with_capacity(roots.len());
    for x in dedupe_roots(roots) {
        if let Some(point) = curve_a.world_at(None, x)? {
            points.push(point);
        }
    }
    Ok(dedupe_points(points))
}

fn closest_point_on_segments(p1: V3, p2: V3, q1: V3, q2: V3) -> (f64, f64, f64) {
    let d1 = sub(p2, p1);
    let d2 = sub(q2, q1);
    let r = sub(p1, q1);
    let a = dot(d1, d1);
    let e = dot(d2, d2);
    let f = dot(d2, r);
    let eps = 1e-14;

    let (mut t, mut s);
    if a <= eps && e <= eps {
        t = 0.0;
        s = 0.0;
    } else if a <= eps {
        t = 0.0;
        s = clamp(f / e, 0.0, 1.0);
    } else {
        let c = dot(d1, r);
        if e <= eps {
            s = 0.0;
            t = clamp(-c / a, 0.0, 1.0);
        } else {
            let b = dot(d1, d2);
            let denom = a * e - b * b;
            t = if denom > eps {
                clamp((b * f - c * e) / denom, 0.0, 1.0)
            } else {
                0.0
            };
            s = (b * t + f) / e;
            if s < 0.0 {
                s = 0.0;
                t = clamp(-c / a, 0.0, 1.0);
            } else if s > 1.0 {
                s = 1.0;
                t = clamp((b - c) / a, 0.0, 1.0);
            }
        }
    }

    let cp1 = [p1[0] + d1[0] * t, p1[1] + d1[1] * t, p1[2] + d1[2] * t];
    let cp2 = [q1[0] + d2[0] * s, q1[1] + d2[1] * s, q1[2] + d2[2] * s];
    let d2 = (cp1[0] - cp2[0]).powi(2) + (cp1[1] - cp2[1]).powi(2) + (cp1[2] - cp2[2]).powi(2);
    (d2, t, s)
}

fn refine_space_curve_pair(
    a: &ObjectDescriptor,
    b: &ObjectDescriptor,
    curve_a: &mut CurveEval,
    curve_b: &mut CurveEval,
    t0: f64,
    s0: f64,
) -> Result<Option<V3>, String> {
    let t = clamp(t0, a.params[0], a.params[1]);
    let s = clamp(s0, b.params[0], b.params[1]);
    let mut pa = match curve_a.world_at(a.matrix, t)? {
        Some(point) => point,
        None => return Ok(None),
    };
    let mut pb = match curve_b.world_at(b.matrix, s)? {
        Some(point) => point,
        None => return Ok(None),
    };

    let mut t = t;
    let mut s = s;
    for _ in 0..40 {
        let r = sub(pa, pb);
        let r2 = dot(r, r);
        if r2 < 1e-16 {
            return Ok(Some(midpoint(pa, pb)));
        }

        let h = 1e-6;
        let pa_p = curve_a.world_at(a.matrix, t + h)?;
        let pa_m = curve_a.world_at(a.matrix, t - h)?;
        let pb_p = curve_b.world_at(b.matrix, s + h)?;
        let pb_m = curve_b.world_at(b.matrix, s - h)?;
        let (Some(pa_p), Some(pa_m), Some(pb_p), Some(pb_m)) = (pa_p, pa_m, pb_p, pb_m) else {
            break;
        };

        let dpa = [
            (pa_p[0] - pa_m[0]) / (2.0 * h),
            (pa_p[1] - pa_m[1]) / (2.0 * h),
            (pa_p[2] - pa_m[2]) / (2.0 * h),
        ];
        let dpb = [
            (pb_p[0] - pb_m[0]) / (2.0 * h),
            (pb_p[1] - pb_m[1]) / (2.0 * h),
            (pb_p[2] - pb_m[2]) / (2.0 * h),
        ];

        let a00 = dot(dpa, dpa);
        let a01 = -dot(dpa, dpb);
        let a11 = dot(dpb, dpb);
        let b0 = -dot(dpa, r);
        let b1 = dot(dpb, r);
        let det = a00 * a11 - a01 * a01;
        if det.abs() < 1e-18 {
            break;
        }

        let dt = (b0 * a11 - a01 * b1) / det;
        let ds = (a00 * b1 - a01 * b0) / det;
        t = clamp(t + dt, a.params[0], a.params[1]);
        s = clamp(s + ds, b.params[0], b.params[1]);
        if dt.abs() < 1e-12 && ds.abs() < 1e-12 {
            break;
        }

        match (
            curve_a.world_at(a.matrix, t)?,
            curve_b.world_at(b.matrix, s)?,
        ) {
            (Some(next_pa), Some(next_pb)) => {
                pa = next_pa;
                pb = next_pb;
            }
            _ => break,
        }
    }

    let r = sub(pa, pb);
    if dot(r, r) < 1e-12 {
        Ok(Some(midpoint(pa, pb)))
    } else {
        Ok(None)
    }
}

fn space_curve_intersections(
    a: &ObjectDescriptor,
    b: &ObjectDescriptor,
    steps: usize,
) -> Result<Vec<V3>, String> {
    let mut curve_a = CurveEval::new(a)?;
    let mut curve_b = CurveEval::new(b)?;
    let samples_a = sample_curve(&mut curve_a, a.matrix, steps)?;
    let samples_b = sample_curve(&mut curve_b, b.matrix, steps)?;
    if samples_a.len() < 2 || samples_b.len() < 2 {
        return Ok(Vec::new());
    }

    let mut max_step: f64 = 1e-6;
    for pair in samples_a.windows(2) {
        max_step = max_step.max(dist(pair[0].1, pair[1].1));
    }
    for pair in samples_b.windows(2) {
        max_step = max_step.max(dist(pair[0].1, pair[1].1));
    }
    let seed_tolerance = max_step.max(1e-6) * 2.0;

    // 去重半径取"两条曲线采样点的世界外接盒对角线"(几何自身尺度),
    // 与坐标绝对值无关;这样同一场景整体平移后交点个数不变.
    let mut bbox_mins = [f64::INFINITY; 3];
    let mut bbox_maxs = [f64::NEG_INFINITY; 3];
    for (_, point) in samples_a.iter().chain(samples_b.iter()) {
        for axis in 0..3 {
            bbox_mins[axis] = bbox_mins[axis].min(point[axis]);
            bbox_maxs[axis] = bbox_maxs[axis].max(point[axis]);
        }
    }
    let tolerance = dedupe_tolerance_for_scale(dist(bbox_mins, bbox_maxs).max(max_step));

    // 增量去重(与 dedupe_points 同口径):重合曲线会产生 O(steps²) 个候选,
    // 必须边细化边合并,避免先堆积再二次去重.
    let mut results: Vec<V3> = Vec::new();
    for pair_a in samples_a.windows(2) {
        for pair_b in samples_b.windows(2) {
            let (d2, t_local, s_local) =
                closest_point_on_segments(pair_a[0].1, pair_a[1].1, pair_b[0].1, pair_b[1].1);
            if d2 > seed_tolerance * seed_tolerance {
                continue;
            }
            let t = pair_a[0].0 + (pair_a[1].0 - pair_a[0].0) * t_local;
            let s = pair_b[0].0 + (pair_b[1].0 - pair_b[0].0) * s_local;
            if let Some(point) = refine_space_curve_pair(a, b, &mut curve_a, &mut curve_b, t, s)? {
                push_deduped_point(&mut results, point, tolerance);
            }
        }
    }
    Ok(results)
}

fn curve_curve_intersections(
    a: &ObjectDescriptor,
    b: &ObjectDescriptor,
    steps: usize,
) -> Result<Vec<V3>, String> {
    if a.matrix.is_none() && b.matrix.is_none() {
        planar_curve_intersections(a, b, steps)
    } else {
        space_curve_intersections(a, b, steps)
    }
}

// ================================================================
// 曲线 ∩ 隐式场
// ================================================================

fn curve_field_intersections(
    curve: &ObjectDescriptor,
    field: &ObjectDescriptor,
    steps: usize,
) -> Result<Vec<V3>, String> {
    let mut curve_eval = CurveEval::new(curve)?;
    let mut field_eval = FieldEval::new(field)?;
    let range = [curve.params[0], curve.params[1]];
    let roots = find_1d_roots(
        &mut |x| {
            let world = match curve_eval.world_at(curve.matrix, x)? {
                Some(world) => world,
                None => return Ok(None),
            };
            field_eval.eval(world)
        },
        range[0],
        range[1],
        steps,
    )?;

    let mut points = Vec::with_capacity(roots.len());
    for x in dedupe_roots(roots) {
        if let Some(point) = curve_eval.world_at(curve.matrix, x)? {
            points.push(point);
        }
    }
    Ok(dedupe_points(points))
}

// ================================================================
// marching squares 等值线
// ================================================================

fn trace_contours(
    patch: &PatchEval,
    field: &mut FieldEval,
    nu: usize,
    nv: usize,
) -> Result<Vec<Vec<V3>>, String> {
    let grid_width = nu + 1;
    let mut values = vec![f64::NAN; grid_width * (nv + 1)];
    let mut valid_flags = vec![false; grid_width * (nv + 1)];

    for j in 0..=nv {
        let v = patch.v0 + ((patch.v1 - patch.v0) * j as f64) / nv as f64;
        for i in 0..=nu {
            let u = patch.u0 + ((patch.u1 - patch.u0) * i as f64) / nu as f64;
            let index = j * grid_width + i;
            let (point, point_valid) = patch.point_valid(u, v);
            let f = match point {
                Some(point) => field.eval(point)?,
                None => None,
            };
            let f = f.unwrap_or(f64::NAN);
            let ok = point_valid && finite(f);
            values[index] = f;
            valid_flags[index] = ok;
        }
    }

    let mut points: Vec<V3> = Vec::new();
    let mut pool: HashMap<(i64, i64, i64), u32> = HashMap::new();
    let mut vertex_id = |u: f64, v: f64| -> Option<u32> {
        let p = patch.point(u, v)?;
        let key = vertex_key(p);
        Some(match pool.get(&key) {
            Some(id) => *id,
            None => {
                let id = points.len() as u32;
                pool.insert(key, id);
                points.push(p);
                id
            }
        })
    };

    let mut segments: Vec<(u32, u32)> = Vec::new();
    for j in 0..nv {
        for i in 0..nu {
            let i_a = j * grid_width + i;
            let i_b = j * grid_width + i + 1;
            let i_c = (j + 1) * grid_width + i + 1;
            let i_d = (j + 1) * grid_width + i;
            if !valid_flags[i_a] || !valid_flags[i_b] || !valid_flags[i_c] || !valid_flags[i_d] {
                continue;
            }

            let v_a = values[i_a];
            let v_b = values[i_b];
            let v_c = values[i_c];
            let v_d = values[i_d];
            let neg_a = v_a < 0.0;
            let neg_b = v_b < 0.0;
            let neg_c = v_c < 0.0;
            let neg_d = v_d < 0.0;

            let u0 = patch.u0 + ((patch.u1 - patch.u0) * i as f64) / nu as f64;
            let u1 = patch.u0 + ((patch.u1 - patch.u0) * (i + 1) as f64) / nu as f64;
            let v0 = patch.v0 + ((patch.v1 - patch.v0) * j as f64) / nv as f64;
            let v1 = patch.v0 + ((patch.v1 - patch.v0) * (j + 1) as f64) / nv as f64;

            let mut crossings: Vec<Crossing> = Vec::with_capacity(4);
            let mut add_crossing = |fa: f64, fb: f64, ua: f64, va: f64, ub: f64, vb: f64| {
                if fa == 0.0 && fb == 0.0 {
                    return;
                }
                if fa == 0.0 {
                    crossings.push(Crossing { u: ua, v: va });
                    return;
                }
                if fb == 0.0 {
                    crossings.push(Crossing { u: ub, v: vb });
                    return;
                }
                if (fa < 0.0) == (fb < 0.0) {
                    return;
                }
                let t = fa / (fa - fb);
                crossings.push(Crossing {
                    u: ua + (ub - ua) * t,
                    v: va + (vb - va) * t,
                });
            };

            add_crossing(v_a, v_b, u0, v0, u1, v0);
            add_crossing(v_b, v_c, u1, v0, u1, v1);
            add_crossing(v_c, v_d, u1, v1, u0, v1);
            add_crossing(v_d, v_a, u0, v1, u0, v0);

            if crossings.len() == 2 {
                push_segment(&mut vertex_id, &mut segments, crossings[0], crossings[1]);
            } else if crossings.len() == 4 {
                let center_neg = (v_a + v_b + v_c + v_d) * 0.25 < 0.0;
                if neg_a == neg_c && neg_b == neg_d && neg_a != neg_b {
                    if neg_a == center_neg {
                        push_segment(&mut vertex_id, &mut segments, crossings[0], crossings[1]);
                        push_segment(&mut vertex_id, &mut segments, crossings[2], crossings[3]);
                    } else {
                        push_segment(&mut vertex_id, &mut segments, crossings[0], crossings[3]);
                        push_segment(&mut vertex_id, &mut segments, crossings[1], crossings[2]);
                    }
                } else {
                    push_segment(&mut vertex_id, &mut segments, crossings[0], crossings[1]);
                    push_segment(&mut vertex_id, &mut segments, crossings[2], crossings[3]);
                }
            }
        }
    }

    let chains = chain_segments(&segments);
    let mut contours = Vec::with_capacity(chains.len());
    for chain in chains {
        if chain.len() >= 2 {
            let contour: Vec<V3> = chain.into_iter().map(|id| points[id as usize]).collect();
            contours.push(contour);
        }
    }
    Ok(contours)
}

fn push_segment(
    vertex_id: &mut impl FnMut(f64, f64) -> Option<u32>,
    segments: &mut Vec<(u32, u32)>,
    first: Crossing,
    second: Crossing,
) {
    if let (Some(first), Some(second)) =
        (vertex_id(first.u, first.v), vertex_id(second.u, second.v))
    {
        segments.push((first, second));
    }
}

fn chain_segments(segments: &[(u32, u32)]) -> Vec<Vec<u32>> {
    let mut adjacency: HashMap<u32, Vec<(u32, usize)>> = HashMap::new();
    for (id, (a, b)) in segments.iter().enumerate() {
        adjacency.entry(*a).or_default().push((*b, id));
        adjacency.entry(*b).or_default().push((*a, id));
    }

    let mut used = vec![false; segments.len()];
    let mut chains: Vec<Vec<u32>> = Vec::new();
    for id in 0..segments.len() {
        if used[id] {
            continue;
        }
        used[id] = true;
        let mut tail = segments[id].0;
        let mut head = segments[id].1;
        let mut chain = vec![tail, head];

        let mut extended = true;
        while extended {
            extended = false;
            if let Some(edges) = adjacency.get(&head) {
                for (other, edge_id) in edges {
                    if used[*edge_id] {
                        continue;
                    }
                    if *other == chain[0] && chain.len() > 2 {
                        used[*edge_id] = true;
                        chain.push(*other);
                        extended = true;
                        break;
                    }
                    used[*edge_id] = true;
                    chain.push(*other);
                    head = *other;
                    extended = true;
                    break;
                }
            }
            if extended {
                continue;
            }
            if let Some(edges) = adjacency.get(&tail) {
                for (other, edge_id) in edges {
                    if used[*edge_id] {
                        continue;
                    }
                    used[*edge_id] = true;
                    chain.insert(0, *other);
                    tail = *other;
                    extended = true;
                    break;
                }
            }
        }
        chains.push(chain);
    }
    chains
}

fn patch_field_intersections(
    patch: &ObjectDescriptor,
    field: &ObjectDescriptor,
    segments: usize,
) -> Result<Vec<Vec<V3>>, String> {
    let mut field_eval = FieldEval::new(field)?;
    let patches = build_patches(patch, segments)?;
    let mut contours = Vec::new();
    for patch_eval in &patches {
        contours.extend(trace_contours(
            patch_eval,
            &mut field_eval,
            segments,
            segments,
        )?);
    }
    Ok(contours)
}

// ================================================================
// 顶层入口
// ================================================================

#[derive(Debug, Default, Clone)]
pub struct IntersectionCoreOutput {
    /// 离散交点,扁平 `[x, y, z, ...]`.
    pub points: Vec<f64>,
    /// 交线折线点,扁平 `[x, y, z, ...]`.
    pub curve_points: Vec<f64>,
    /// 每条折线在 `curve_points` 里的起始下标,末尾追加总长.
    pub curve_offsets: Vec<u32>,
}

impl IntersectionCoreOutput {
    fn from_points(points: Vec<V3>) -> Self {
        let mut flat = Vec::with_capacity(points.len() * 3);
        for point in points {
            flat.extend_from_slice(&point);
        }
        Self {
            points: flat,
            ..Self::default()
        }
    }

    fn from_contours(contours: Vec<Vec<V3>>) -> Self {
        let mut curve_points = Vec::new();
        let mut curve_offsets = Vec::with_capacity(contours.len() + 1);
        curve_offsets.push(0);
        for contour in contours {
            for point in contour {
                curve_points.extend_from_slice(&point);
            }
            curve_offsets.push(curve_points.len() as u32 / 3);
        }
        Self {
            points: Vec::new(),
            curve_points,
            curve_offsets,
        }
    }
}

/// 计算两个对象描述符的交集,组合语义为:
/// 曲线参与 -> 离散交点;曲面/体积参与 -> 空间交线.
/// 非曲线组合的面片侧选择见 [`choose_patch_field_pair`].
pub fn compute_pair(
    a: &ObjectDescriptor,
    b: &ObjectDescriptor,
    segments: usize,
) -> Result<IntersectionCoreOutput, String> {
    if segments == 0 {
        return Err("求交 segments 必须大于 0".to_string());
    }
    if segments > MAX_INTERSECTION_SEGMENTS {
        return Err(format!(
            "求交 segments 超过上限 {MAX_INTERSECTION_SEGMENTS}"
        ));
    }
    match (a.kind, b.kind) {
        (ObjectKind::Curve, ObjectKind::Curve) => Ok(IntersectionCoreOutput::from_points(
            curve_curve_intersections(a, b, segments)?,
        )),
        (ObjectKind::Curve, _) => Ok(IntersectionCoreOutput::from_points(
            curve_field_intersections(a, b, segments)?,
        )),
        (_, ObjectKind::Curve) => Ok(IntersectionCoreOutput::from_points(
            curve_field_intersections(b, a, segments)?,
        )),
        _ => {
            let (patch, field) = choose_patch_field_pair(a, b);
            Ok(IntersectionCoreOutput::from_contours(
                patch_field_intersections(patch, field, segments)?,
            ))
        }
    }
}

/// 让"曲面/体积组合"的计算结果不依赖 DSL 参数顺序.
///
/// 规则:
/// - 曲面 + 体积:体积表面是精确参数化,曲面用隐式场精确求值,因此体积做
///   面片侧更稳(旧实现固定第一个对象做面片,会因顺序差 6 倍工作量并引入
///   曲面双线性近似误差);
/// - 体积 + 体积:双方都精确,选面片数少的一侧,减少重复扫描;
/// - 曲面 + 曲面:保持第一个对象为面片(两边的离散化误差同级,无全局更优).
fn choose_patch_field_pair<'a>(
    a: &'a ObjectDescriptor,
    b: &'a ObjectDescriptor,
) -> (&'a ObjectDescriptor, &'a ObjectDescriptor) {
    let patch_count = |kind: ObjectKind| match kind {
        ObjectKind::Conic => 3,
        ObjectKind::Surface => 1,
        ObjectKind::Curve => 0,
        ObjectKind::Sphere | ObjectKind::Box => 6,
    };

    let a_is_surface = a.kind == ObjectKind::Surface;
    let b_is_surface = b.kind == ObjectKind::Surface;
    if a_is_surface != b_is_surface {
        // 曲面/体积组合:体积做面片.
        if a_is_surface {
            (b, a)
        } else {
            (a, b)
        }
    } else if !a_is_surface && !b_is_surface && patch_count(b.kind) < patch_count(a.kind) {
        (b, a)
    } else {
        (a, b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn curve_descriptor(expr: &str, range: [f64; 2]) -> ObjectDescriptor {
        parse_object_descriptor(
            "curve",
            expr,
            vec![],
            vec![],
            range.to_vec(),
            vec![],
            vec![],
        )
        .unwrap()
    }

    fn surface_descriptor(expr: &str, range: [f64; 4]) -> ObjectDescriptor {
        parse_object_descriptor(
            "surface",
            expr,
            vec![],
            vec![],
            range.to_vec(),
            vec![],
            vec![],
        )
        .unwrap()
    }

    fn sphere_descriptor(center: [f64; 3], radius: f64) -> ObjectDescriptor {
        let params = [center[0], center[1], center[2], radius];
        parse_object_descriptor(
            "sphere",
            "",
            vec![],
            vec![],
            params.to_vec(),
            vec![],
            vec![],
        )
        .unwrap()
    }

    fn box_descriptor(center: [f64; 3], size: [f64; 3]) -> ObjectDescriptor {
        let params = [center[0], center[1], center[2], size[0], size[1], size[2]];
        parse_object_descriptor("box", "", vec![], vec![], params.to_vec(), vec![], vec![]).unwrap()
    }

    fn points_of(output: &IntersectionCoreOutput) -> Vec<[f64; 3]> {
        output
            .points
            .as_chunks::<3>()
            .0
            .iter()
            .map(|chunk| [chunk[0], chunk[1], chunk[2]])
            .collect()
    }

    fn conic_descriptor(base: f64, top: f64, height: f64) -> ObjectDescriptor {
        let params = [0.0, 0.0, 0.0, base, top, height];
        parse_object_descriptor("conic", "", vec![], vec![], params.to_vec(), vec![], vec![])
            .unwrap()
    }

    #[test]
    fn planar_curves_cross_at_expected_x() {
        let a = curve_descriptor("x", [-2.0, 2.0]);
        let b = curve_descriptor("-x + 2", [-2.0, 2.0]);
        let output = compute_pair(&a, &b, 64).unwrap();
        let points = points_of(&output);
        assert_eq!(points.len(), 1);
        assert!((points[0][0] - 1.0).abs() < 1e-4);
        assert!((points[0][1] - 1.0).abs() < 1e-4);
    }

    #[test]
    fn curve_pierces_surface() {
        let curve = curve_descriptor("x", [-2.0, 2.0]);
        let surface = surface_descriptor("y", [-2.0, 2.0, -2.0, 2.0]);
        let output = compute_pair(&curve, &surface, 64).unwrap();
        let points = points_of(&output);
        assert_eq!(points.len(), 1);
        assert!(points[0][0].abs() < 1e-3);
        assert!(points[0][1].abs() < 1e-3);
    }

    #[test]
    fn curve_crosses_sphere_twice() {
        let curve = curve_descriptor("x", [-2.0, 2.0]);
        let sphere = sphere_descriptor([0.0, 0.0, 0.0], 1.0);
        let output = compute_pair(&curve, &sphere, 128).unwrap();
        let points = points_of(&output);
        assert_eq!(points.len(), 2);
        let mut xs: Vec<f64> = points.iter().map(|point| point[0]).collect();
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert!((xs[0] + 1.0 / 2.0f64.sqrt()).abs() < 1e-2);
        assert!((xs[1] - 1.0 / 2.0f64.sqrt()).abs() < 1e-2);
    }

    #[test]
    fn two_surfaces_produce_contour() {
        let a = surface_descriptor("0", [-2.0, 2.0, -2.0, 2.0]);
        let b = surface_descriptor("x", [-2.0, 2.0, -2.0, 2.0]);
        let output = compute_pair(&a, &b, 32).unwrap();
        assert!(output.curve_offsets.len() >= 2);
        assert!(output.curve_points.len() >= 16 * 3);
        for chunk in output.curve_points.as_chunks::<3>().0 {
            assert!(chunk[0].abs() < 0.03);
            assert!(chunk[2].abs() < 1e-9);
        }
    }

    #[test]
    fn plane_cuts_sphere_in_circle() {
        let sphere = sphere_descriptor([0.0, 0.0, 0.0], 1.0);
        let surface = surface_descriptor("0", [-1.5, 1.5, -1.5, 1.5]);
        let output = compute_pair(&sphere, &surface, 32).unwrap();
        assert!(output.curve_offsets.len() >= 2);
        for chunk in output.curve_points.as_chunks::<3>().0 {
            let rho = (chunk[0] * chunk[0] + chunk[1] * chunk[1]).sqrt();
            assert!((rho - 1.0).abs() < 0.1);
            assert!(chunk[2].abs() < 1e-6);
        }
    }

    #[test]
    fn sphere_box_crossing_produces_closed_contours() {
        let sphere = sphere_descriptor([0.0, 0.0, 0.0], 1.5);
        let box_obj = box_descriptor([0.0, 0.0, 0.0], [2.0, 2.0, 2.0]);
        let output = compute_pair(&sphere, &box_obj, 32).unwrap();
        assert!(output.curve_offsets.len() >= 5);
        for chunk in output.curve_points.as_chunks::<3>().0 {
            assert!(
                (chunk[0].powi(2) + chunk[1].powi(2) + chunk[2].powi(2))
                    .sqrt()
                    .abs()
                    - 1.5
                    < 0.2
            );
            assert!((chunk[0].abs().max(chunk[1].abs()).max(chunk[2].abs()) - 1.0).abs() < 0.2);
        }
    }

    #[test]
    fn surface_volume_order_does_not_change_result() {
        let sphere = sphere_descriptor([0.0, 0.0, 0.0], 1.0);
        let surface = surface_descriptor("0", [-1.5, 1.5, -1.5, 1.5]);
        let first = compute_pair(&sphere, &surface, 32).unwrap();
        let second = compute_pair(&surface, &sphere, 32).unwrap();
        assert_eq!(first.curve_offsets, second.curve_offsets);
        assert_eq!(first.curve_points, second.curve_points);
    }

    /// 回归 #1:曲线贴着盒面(振幅仅 1e-6)时,旧实现返回 201 个**假**交点.
    ///
    /// 真正的缺陷是盒隐式场在"盒外但落在另两轴跨度内"时返回恰好 0,于是
    /// `y > 1` 的那半个振荡周期也被当成在盒面上.改成精确带符号距离后,
    /// `y > 1` 的点严格为正,不允许上报;`y ≤ 1` 的点才可能落在盒顶面上.
    /// 这条守住"没有盒外假交点",与下面那条"交点数量有界"互为补充
    /// (当前实现最终返回 1 个点;数量断言见
    /// [`grazing_curve_on_box_face_reports_at_most_two_intersections`]).
    #[test]
    fn grazing_curve_on_box_face_has_no_false_intersections() {
        let curve = curve_descriptor("1 + 1e-6 * sin(200 * pi * x)", [0.0, 1.0]);
        let box_obj = box_descriptor([0.0, 0.0, 0.0], [2.0, 2.0, 2.0]);
        let output = compute_pair(&curve, &box_obj, 400).unwrap();
        let points = points_of(&output);
        assert!(!points.is_empty(), "贴面接触不应全部丢失");
        for point in &points {
            assert!(
                point[1] <= 1.0 + 1e-12,
                "盒外的 y={} 被当成盒面交点: {point:?}",
                point[1]
            );
        }

        // 反例对照:把整条曲线抬到盒外(最小值仍在面上方)后必须**一个交点都没有**,
        // 这正是旧实现会返回成片假交点的情形.
        let above = curve_descriptor(
            "1.000001 + 0.5 * 1e-6 * (1 + sin(200 * pi * x))",
            [0.0, 1.0],
        );
        let output = compute_pair(&above, &box_obj, 400).unwrap();
        let points = points_of(&output);
        assert!(
            points.is_empty(),
            "整条曲线在盒外,不应有交点,实际 {} 个: {points:?}",
            points.len()
        );
    }

    /// 回归 #1(任务验收口径):贴面振荡曲线不得把每个采样点都当成独立交点.
    /// 修复前为 201 个,修复后应 ≤ 2.
    #[test]
    fn grazing_curve_on_box_face_reports_at_most_two_intersections() {
        let curve = curve_descriptor("1 + 1e-6 * sin(200 * pi * x)", [0.0, 1.0]);
        let box_obj = box_descriptor([0.0, 0.0, 0.0], [2.0, 2.0, 2.0]);
        let output = compute_pair(&curve, &box_obj, 400).unwrap();
        let points = points_of(&output);
        assert!(
            points.len() <= 2,
            "贴面曲线产生了 {} 个交点(任务要求 ≤ 2): {points:?}",
            points.len()
        );
    }

    /// 空间曲线路径(带静态变换)同样按几何自身尺度去重:
    /// 两条交叉直线只应得到 1 个交点(众多候选对都收敛到同一点).
    #[test]
    fn space_curve_intersections_dedupe_to_single_point() {
        let identity: Vec<f64> = vec![
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let a = parse_object_descriptor(
            "curve",
            "x",
            vec![],
            vec![],
            vec![-2.0, 2.0],
            identity.clone(),
            identity.clone(),
        )
        .unwrap();
        let b = parse_object_descriptor(
            "curve",
            "-x + 2",
            vec![],
            vec![],
            vec![-2.0, 2.0],
            identity.clone(),
            identity,
        )
        .unwrap();
        let output = compute_pair(&a, &b, 64).unwrap();
        let points = points_of(&output);
        assert_eq!(points.len(), 1, "{points:?}");
        assert!((points[0][0] - 1.0).abs() < 1e-3, "{points:?}");
    }

    /// 回归 #2:极大值很大,零点附近平坦时,旧的 `|f| ≤ 1e-7·全局max`
    /// 判据把平坦段的采样点全当相切根.局部尺度判定 + 残差复核后应无根.
    #[test]
    fn tangential_scan_uses_local_scale_not_global_max() {
        // 函数量级 1e6,但在 x≈0 附近平坦且最小值 1e-2 > 0(全程无根).
        let mut near_touch = |x: f64| Ok(Some(1e-2 + 1e6 * x * x));
        let roots = find_1d_roots(&mut near_touch, -1.0, 1.0, 128).unwrap();
        assert!(roots.is_empty(), "平坦近切段不应产生根: {roots:?}");
    }

    /// 对照:真正的相切(双重根)仍必须被找到并细化.
    #[test]
    fn tangential_scan_still_finds_true_tangency() {
        let mut tangent = |x: f64| Ok(Some(1e6 * (x - 0.5) * (x - 0.5)));
        let roots = find_1d_roots(&mut tangent, 0.0, 1.0, 128).unwrap();
        assert_eq!(roots.len(), 1, "{roots:?}");
        assert!(
            (roots[0] - 0.5).abs() < 1e-6,
            "相切点应被细化: {}",
            roots[0]
        );
    }

    /// 回归 #3:去重容差必须取几何自身尺度(根集跨度),不是坐标绝对值,
    /// 否则平移到 1e5 量级会把相距 3e-6 的真实根并掉.
    #[test]
    fn dedupe_roots_scale_is_geometric_not_absolute() {
        assert_eq!(dedupe_roots(vec![0.0, 3e-6]).len(), 2);
        assert_eq!(
            dedupe_roots(vec![1e5, 1e5 + 3e-6]).len(),
            2,
            "平移后相距 3e-6 的真实根被错误合并"
        );
        assert_eq!(
            dedupe_roots(vec![7.0, 7.0]).len(),
            1,
            "完全重合的根仍应合并"
        );
    }

    /// 回归 #3:点集去重同口径(按外接盒对角线,平移不变).
    #[test]
    fn dedupe_points_scale_is_geometric_not_absolute() {
        assert_eq!(
            dedupe_points(vec![[0.0, 0.0, 0.0], [3e-6, 0.0, 0.0]]).len(),
            2
        );
        assert_eq!(
            dedupe_points(vec![[1e5, 0.0, 0.0], [1e5 + 3e-6, 0.0, 0.0]]).len(),
            2,
            "平移后相距 3e-6 的真实交点被错误合并"
        );
        assert_eq!(
            dedupe_points(vec![[1e5, 0.0, 0.0], [1e5, 0.0, 0.0]]).len(),
            1,
            "完全重合的点仍应合并"
        );
    }

    /// 回归 #3(端到端):同一几何放在原点与放在 1e5 处,真实交点个数一致.
    #[test]
    fn close_intersections_survive_large_translation() {
        let origin = curve_descriptor("x * (x - 3e-6)", [-1e-5, 1e-5]);
        let origin_base = curve_descriptor("0", [-1e-5, 1e-5]);
        assert_eq!(
            points_of(&compute_pair(&origin, &origin_base, 256).unwrap()).len(),
            2
        );

        let a = 1.0e5;
        let shifted = curve_descriptor("(x - 1e5) * (x - 1e5 - 3e-6)", [a - 1e-5, a + 1e-5]);
        let shifted_base = curve_descriptor("0", [a - 1e-5, a + 1e-5]);
        assert_eq!(
            points_of(&compute_pair(&shifted, &shifted_base, 256).unwrap()).len(),
            2,
            "平移到 1e5 后相近真实交点被并掉"
        );
    }

    /// 回归 #5:负 top_radius 必须在求交内核入口报错(隐式场侧与面片侧).
    #[test]
    fn conic_negative_top_radius_is_rejected_at_core_entry() {
        let bad = conic_descriptor(2.0, -1.0, 3.0);
        let curve = curve_descriptor("x", [-3.0, 3.0]);
        let error = compute_pair(&curve, &bad, 32).unwrap_err();
        assert!(error.contains("top_radius"), "{error}");

        let surface = surface_descriptor("0", [-3.0, 3.0, -3.0, 3.0]);
        let error = compute_pair(&surface, &bad, 32).unwrap_err();
        assert!(error.contains("top_radius"), "{error}");

        // top_radius == 0(圆锥)仍然合法.
        let cone = conic_descriptor(2.0, 0.0, 3.0);
        assert!(compute_pair(&surface, &cone, 32).is_ok());
    }

    #[test]
    fn transform_translates_curve_intersection() {
        let mut matrix = [0.0; 16];
        matrix[0] = 1.0;
        matrix[5] = 1.0;
        matrix[10] = 1.0;
        matrix[15] = 1.0;
        matrix[3] = 0.0;
        matrix[7] = 1.0;
        // 与 matrix 成对的真逆(translate(0,1) 的逆是 translate(0,-1));
        // 曲线侧只用 matrix,逆矩阵不参与该场景的求值.
        let mut inverse = matrix;
        inverse[7] = -1.0;
        let curve = parse_object_descriptor(
            "curve",
            "x",
            vec![],
            vec![],
            vec![-2.0, 2.0],
            matrix.to_vec(),
            inverse.to_vec(),
        )
        .unwrap();
        let surface = surface_descriptor("y", [-2.0, 2.0, -2.0, 2.0]);
        let output = compute_pair(&curve, &surface, 64).unwrap();
        let points = points_of(&output);
        assert_eq!(points.len(), 1);
        assert!((points[0][0] + 1.0).abs() < 1e-3);
        assert!(points[0][1].abs() < 1e-3);
    }
}
