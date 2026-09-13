//! 几何对象模型与隐式场:求交与体积积分共享的"对象描述符 -> 几何查询"层.
//!
//! 本模块从原 intersection_core 抽出,承载三类内容:
//! - **对象描述符模型与解析**(ObjectKind / ObjectDescriptor /
//!   parse_object_descriptor):curve/surface/sphere/box/conic 参与方共用
//!   同一参数布局,表达式只解析一次,上下文只构建一次;
//! - **隐式场**(FieldEval):把"世界坐标点在对象表面上/内/外"化为带符号
//!   标量(≤0 在体内),经逆矩阵把世界坐标映射回局部,天然支持静态变换;
//! - **体积积分几何服务**:SolidProbe(体内探针)与 solid_world_aabb
//!   (实体世界外接盒).
//!
//! 拆分动机(202609 架构审查):域积分(domain_integral 的 solid C1 网格与
//! lib.rs::integrate_solid 的解析测度/世界 AABB)只消费"对象几何",原本
//! 却依赖整个 intersection_core(连带 marching squares/求根/面片链等
//! 与它无关的求交实现).抽出本层后依赖方向收敛为:
//!
//! ```text
//!   domain_integral ──> geometry_core <── intersection_core
//! ```
//!
//! 求交内核本身聚焦"哪些点/线是交集",对象几何判定统一从这里取.
//! 本模块不依赖 wasm-bindgen,便于 `cargo test` 纯 Rust 验证.
//! 体积积分只开放 sphere/box/conic;curve/surface 仍可作为求交参与方解析,
//! 但不能作为体域(见 FieldEval::new / SolidProbe::new 的校验).

use crate::eval_core::CompiledEvaluator;
use crate::transform_core::{apply_to_point, Mat4};

type V3 = [f64; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dist(a: V3, b: V3) -> f64 {
    (sub(a, b)).iter().map(|v| v * v).sum::<f64>().sqrt()
}

fn to_world(matrix: Option<Mat4>, local: V3) -> V3 {
    match matrix {
        Some(matrix) => apply_to_point(matrix, local[0], local[1], local[2]),
        None => local,
    }
}

fn to_local(inverse: Option<Mat4>, world: V3) -> V3 {
    to_world(inverse, world)
}

// ================================================================
// 对象描述符
// ================================================================

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ObjectKind {
    Curve,
    Surface,
    Sphere,
    Box,
    Conic,
}

impl ObjectKind {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "curve" => Ok(Self::Curve),
            "surface" => Ok(Self::Surface),
            "sphere" => Ok(Self::Sphere),
            "box" => Ok(Self::Box),
            "conic" => Ok(Self::Conic),
            _ => Err(format!("求交不支持对象类型 {raw}")),
        }
    }
}

/// 描述一个几何参与方(求交参与方 / 体积积分域).所有数值参数集中在 `params`:
/// - curve:  [x0, x1]
/// - surface:[x0, x1, y0, y1]
/// - sphere: [cx, cy, cz, radius]
/// - box:    [cx, cy, cz, sx, sy, sz]
/// - conic:  [cx, cy, cz, base, top, height]
#[derive(Debug)]
pub struct ObjectDescriptor {
    pub kind: ObjectKind,
    pub expr: String,
    pub coefficient_names: Vec<String>,
    pub coefficient_values: Vec<f64>,
    pub params: Vec<f64>,
    pub matrix: Option<Mat4>,
    pub inverse: Option<Mat4>,
}

fn parse_optional_matrix(raw: &[f64], label: &str) -> Result<Option<Mat4>, String> {
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.len() != 16 {
        return Err(format!("{label} 需要 16 个元素,实际为 {}", raw.len()));
    }
    let mut matrix = [0.0; 16];
    matrix.copy_from_slice(raw);
    Ok(Some(matrix))
}

pub fn parse_object_descriptor(
    kind: &str,
    expr: &str,
    coefficient_names: Vec<String>,
    coefficient_values: Vec<f64>,
    params: Vec<f64>,
    matrix_values: Vec<f64>,
    inverse_values: Vec<f64>,
) -> Result<ObjectDescriptor, String> {
    let kind = ObjectKind::parse(kind)?;
    if coefficient_names.len() != coefficient_values.len() {
        return Err(format!(
            "{} 的系数名与系数值数量不一致: {} vs {}",
            kind_name(kind),
            coefficient_names.len(),
            coefficient_values.len()
        ));
    }

    let expected_params = match kind {
        ObjectKind::Curve => 2,
        ObjectKind::Surface => 4,
        ObjectKind::Sphere => 4,
        ObjectKind::Box => 6,
        ObjectKind::Conic => 6,
    };
    if params.len() != expected_params {
        return Err(format!(
            "{} 需要 {expected_params} 个数值参数,实际为 {}",
            kind_name(kind),
            params.len()
        ));
    }

    let matrix = parse_optional_matrix(&matrix_values, "变换矩阵")?;
    let inverse = parse_optional_matrix(&inverse_values, "逆矩阵")?;

    Ok(ObjectDescriptor {
        kind,
        expr: expr.to_string(),
        coefficient_names,
        coefficient_values,
        params,
        matrix,
        inverse,
    })
}

fn kind_name(kind: ObjectKind) -> &'static str {
    match kind {
        ObjectKind::Curve => "曲线",
        ObjectKind::Surface => "曲面",
        ObjectKind::Sphere => "球体",
        ObjectKind::Box => "方块",
        ObjectKind::Conic => "旋转体",
    }
}

// ================================================================
// 隐式场
// ================================================================

enum FieldKind {
    Surface {
        expr: CompiledEvaluator,
        range: [f64; 4],
    },
    Sphere {
        center: V3,
        radius: f64,
    },
    Box {
        center: V3,
        half: V3,
    },
    Conic {
        center: V3,
        base_radius: f64,
        top_radius: f64,
        height: f64,
    },
}

/// 世界坐标隐式场求值器(求交的 field 侧与体积积分的域侧共用).
///
/// 每个对象按其局部形状给出带符号式标量(球/盒/圆台为精确的带符号距离,
/// 曲面为 z_local - z_surface):世界坐标先经逆矩阵回局部再判定,
/// 静态变换对象与未变换对象同一套代码.
pub(crate) struct FieldEval {
    inverse: Option<Mat4>,
    kind: FieldKind,
}

/// 供体积积分(C1 世界网格 / lebesgue 层)使用的"点在实体内外"探针.
///
/// 复用隐式场(≤0 在体内)与逆矩阵语义;对 `sphere/box/conic` 开放,
/// curve/surface 不能作为体域.
pub(crate) struct SolidProbe {
    field: FieldEval,
}

impl SolidProbe {
    pub(crate) fn new(descriptor: &ObjectDescriptor) -> Result<Self, String> {
        if !matches!(
            descriptor.kind,
            ObjectKind::Sphere | ObjectKind::Box | ObjectKind::Conic
        ) {
            return Err("体积积分只支持 sphere/box/conic 域".to_string());
        }
        Ok(Self {
            field: FieldEval::new(descriptor)?,
        })
    }

    /// 世界坐标点是否在实体内(边界计为体内).
    pub(crate) fn inside(&mut self, world: V3) -> Result<bool, String> {
        match self.field.eval(world)? {
            Some(value) => Ok(value <= 0.0),
            None => Ok(false),
        }
    }
}

/// 实体的世界外接 AABB:每轴为 [min, max].
pub(crate) type WorldAabb = ([f64; 2], [f64; 2], [f64; 2]);

/// 实体在世界坐标下的外接 AABB.
///
/// 做法:取"包含该实体局部形状的轴对齐盒"的 8 个角点,经静态矩阵变换到
/// 世界后取 min/max.对球/盒精确;对圆台按底半径外接盒,可能轻微外扩,
/// 但只影响采样候选格,不影响最终"点在体内"判定与积分值.
pub(crate) fn solid_world_aabb(descriptor: &ObjectDescriptor) -> Result<WorldAabb, String> {
    let (center, half) = match descriptor.kind {
        ObjectKind::Sphere => (
            [
                descriptor.params[0],
                descriptor.params[1],
                descriptor.params[2],
            ],
            [
                descriptor.params[3],
                descriptor.params[3],
                descriptor.params[3],
            ],
        ),
        ObjectKind::Box => (
            [
                descriptor.params[0],
                descriptor.params[1],
                descriptor.params[2],
            ],
            [
                descriptor.params[3] * 0.5,
                descriptor.params[4] * 0.5,
                descriptor.params[5] * 0.5,
            ],
        ),
        ObjectKind::Conic => {
            let radius = descriptor.params[3].max(descriptor.params[4]);
            (
                [
                    descriptor.params[0],
                    descriptor.params[1],
                    descriptor.params[2],
                ],
                [radius, descriptor.params[5] * 0.5, radius],
            )
        }
        _ => return Err("体积积分只支持 sphere/box/conic 域".to_string()),
    };

    let mut mins = [f64::INFINITY; 3];
    let mut maxs = [f64::NEG_INFINITY; 3];
    for &sx in &[-1.0, 1.0] {
        for &sy in &[-1.0, 1.0] {
            for &sz in &[-1.0, 1.0] {
                let corner = [
                    center[0] + sx * half[0],
                    center[1] + sy * half[1],
                    center[2] + sz * half[2],
                ];
                let world = to_world(descriptor.matrix, corner);
                for axis in 0..3 {
                    mins[axis] = mins[axis].min(world[axis]);
                    maxs[axis] = maxs[axis].max(world[axis]);
                }
            }
        }
    }
    Ok(([mins[0], maxs[0]], [mins[1], maxs[1]], [mins[2], maxs[2]]))
}

impl FieldEval {
    pub(crate) fn new(descriptor: &ObjectDescriptor) -> Result<Self, String> {
        let kind = match descriptor.kind {
            ObjectKind::Surface => {
                let expr = CompiledEvaluator::new(
                    &descriptor.expr,
                    &descriptor.coefficient_names,
                    &descriptor.coefficient_values,
                )?;
                FieldKind::Surface {
                    expr,
                    range: [
                        descriptor.params[0],
                        descriptor.params[1],
                        descriptor.params[2],
                        descriptor.params[3],
                    ],
                }
            }
            ObjectKind::Sphere => FieldKind::Sphere {
                center: [
                    descriptor.params[0],
                    descriptor.params[1],
                    descriptor.params[2],
                ],
                radius: descriptor.params[3],
            },
            ObjectKind::Box => FieldKind::Box {
                center: [
                    descriptor.params[0],
                    descriptor.params[1],
                    descriptor.params[2],
                ],
                half: [
                    descriptor.params[3] * 0.5,
                    descriptor.params[4] * 0.5,
                    descriptor.params[5] * 0.5,
                ],
            },
            ObjectKind::Conic => FieldKind::Conic {
                center: [
                    descriptor.params[0],
                    descriptor.params[1],
                    descriptor.params[2],
                ],
                base_radius: descriptor.params[3],
                top_radius: descriptor.params[4],
                height: descriptor.params[5],
            },
            ObjectKind::Curve => return Err("曲线不能作为隐式场".to_string()),
        };
        Ok(Self {
            inverse: descriptor.inverse,
            kind,
        })
    }

    pub(crate) fn eval(&mut self, world: V3) -> Result<Option<f64>, String> {
        let local = to_local(self.inverse, world);
        match &mut self.kind {
            FieldKind::Surface { expr, range } => {
                let [xa, xb, ya, yb] = *range;
                if local[0] < xa || local[0] > xb || local[1] < ya || local[1] > yb {
                    return Ok(None);
                }
                let z = expr.eval_2d(local[0], local[1])?;
                Ok(z.map(|z| local[2] - z))
            }
            FieldKind::Sphere { center, radius } => Ok(Some(dist(local, *center) - *radius)),
            FieldKind::Box { center, half } => {
                let dx = (local[0] - center[0]).abs() - half[0];
                let dy = (local[1] - center[1]).abs() - half[1];
                let dz = (local[2] - center[2]).abs() - half[2];
                Ok(Some(dx.max(dy).max(dz)))
            }
            FieldKind::Conic {
                center,
                base_radius,
                top_radius,
                height,
            } => {
                let dy = local[1] - center[1];
                let rho = ((local[0] - center[0]).powi(2) + (local[2] - center[2]).powi(2)).sqrt();
                let half_height = *height * 0.5;
                let radius_at =
                    *base_radius + (*top_radius - *base_radius) * ((dy + half_height) / *height);
                Ok(Some(
                    (rho - radius_at)
                        .max(-(dy + half_height))
                        .max(dy - half_height),
                ))
            }
        }
    }
}
