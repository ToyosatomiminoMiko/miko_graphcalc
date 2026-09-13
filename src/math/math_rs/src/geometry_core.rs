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
use crate::transform_core::{apply_to_point, identity4, multiply4x4, Mat4};

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

/// 校验静态变换的 `matrix` 与 `inverse` 确实互为逆矩阵(相对容差).
///
/// 两者由调用方成对给出;若不一致,`to_local` 会把世界坐标当成局部坐标,
/// 求交/积分会静默给出错误结果,因此这里直接报错而不是将就.
fn validate_matrix_inverse(matrix: &Mat4, inverse: &Mat4) -> Result<(), String> {
    let product = multiply4x4(*matrix, *inverse);
    let identity = identity4();
    let matrix_scale = matrix.iter().fold(0.0f64, |m, v| m.max(v.abs()));
    let inverse_scale = inverse.iter().fold(0.0f64, |m, v| m.max(v.abs()));
    // 乘积元素量级 ~ |matrix| · |inverse|,用相对容差比较单位阵.
    let tolerance = 1e-9 * 1.0f64.max(matrix_scale * inverse_scale);
    for (value, unit) in product.iter().zip(identity.iter()) {
        if (value - unit).abs() > tolerance {
            return Err("变换矩阵与逆矩阵不一致:matrix * inverse 不等于单位阵".to_string());
        }
    }
    Ok(())
}

/// 旋转体参数的统一校验(求交面片侧与体积积分域侧共用).
///
/// `top_radius == 0` 表示圆锥,合法;负半径没有几何意义,会让 AABB/面片
/// 静默失界,这里直接报错.
pub(crate) fn check_conic_params(
    base_radius: f64,
    top_radius: f64,
    height: f64,
) -> Result<(), String> {
    if !(base_radius > 0.0 && height > 0.0) {
        return Err("旋转体 base/height 必须大于 0".to_string());
    }
    if top_radius < 0.0 {
        return Err("旋转体 top_radius 不能为负".to_string());
    }
    Ok(())
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
    match (&matrix, &inverse) {
        (Some(matrix), Some(inverse)) => validate_matrix_inverse(matrix, inverse)?,
        (None, None) => {}
        _ => {
            return Err(
                "变换矩阵与逆矩阵必须同时提供(缺 inverse 会把世界坐标当局部坐标)".to_string(),
            );
        }
    }

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
            ObjectKind::Conic => {
                let base_radius = descriptor.params[3];
                let top_radius = descriptor.params[4];
                let height = descriptor.params[5];
                check_conic_params(base_radius, top_radius, height)?;
                FieldKind::Conic {
                    center: [
                        descriptor.params[0],
                        descriptor.params[1],
                        descriptor.params[2],
                    ],
                    base_radius,
                    top_radius,
                    height,
                }
            }
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
                // 盒的精确带符号距离:盒外为到盒面的欧氏距离(严格为正),
                // 盒内/盒面上为 ≤ 0.三个"半空间距离"的 max 在盒外虽也
                // >0,但只是轴向超出量的最大值,不是真正的离面距离;这里
                // 显式合成 outside(正部)与 inside(负部),保证
                // "≤ 0 当且仅当在盒内(含边界)"且盒外任一轴超出即严格为正.
                let qx = (local[0] - center[0]).abs() - half[0];
                let qy = (local[1] - center[1]).abs() - half[1];
                let qz = (local[2] - center[2]).abs() - half[2];
                let outside_x = qx.max(0.0);
                let outside_y = qy.max(0.0);
                let outside_z = qz.max(0.0);
                let outside =
                    (outside_x * outside_x + outside_y * outside_y + outside_z * outside_z).sqrt();
                let inside = qx.max(qy).max(qz).min(0.0);
                Ok(Some(outside + inside))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transform_core::translate4;

    fn descriptor(
        kind: &str,
        params: Vec<f64>,
        matrix: Vec<f64>,
        inverse: Vec<f64>,
    ) -> Result<ObjectDescriptor, String> {
        parse_object_descriptor(kind, "", vec![], vec![], params, matrix, inverse)
    }

    fn sphere() -> ObjectDescriptor {
        descriptor("sphere", vec![0.0, 0.0, 0.0, 1.0], vec![], vec![]).unwrap()
    }

    /// 回归:matrix / inverse 必须成对给出,缺一会把世界坐标当局部坐标用.
    #[test]
    fn matrix_without_inverse_is_rejected() {
        let error = descriptor(
            "sphere",
            vec![0.0, 0.0, 0.0, 1.0],
            translate4(0.0, 1.0, 0.0).to_vec(),
            vec![],
        )
        .unwrap_err();
        assert!(error.contains("逆矩阵"), "错误应点名逆矩阵: {error}");
        let error = descriptor(
            "sphere",
            vec![0.0, 0.0, 0.0, 1.0],
            vec![],
            translate4(0.0, 1.0, 0.0).to_vec(),
        )
        .unwrap_err();
        assert!(error.contains("逆矩阵"), "错误应点名逆矩阵: {error}");
    }

    /// 回归:matrix * inverse 必须(相对容差内)等于单位阵.
    #[test]
    fn inconsistent_matrix_inverse_is_rejected() {
        let matrix = translate4(0.0, 1.0, 0.0).to_vec();
        // translate(1) 的逆是 translate(-1);此处把 translate(1) 当逆用,
        // 乘积是 translate(2).
        let error =
            descriptor("sphere", vec![0.0, 0.0, 0.0, 1.0], matrix.clone(), matrix).unwrap_err();
        assert!(error.contains("单位阵"), "错误应点名单位阵: {error}");
    }

    #[test]
    fn consistent_matrix_inverse_is_accepted() {
        let descriptor = descriptor(
            "sphere",
            vec![0.0, 0.0, 0.0, 1.0],
            translate4(0.0, 1.0, 0.0).to_vec(),
            translate4(0.0, -1.0, 0.0).to_vec(),
        );
        assert!(descriptor.is_ok(), "{descriptor:?}");
    }

    /// 回归:盒隐式场是精确带符号距离 -- 盒外严格为正,盒面上为 0,
    /// 盒内为负;且"≤0 当且仅当在盒内(含边界)".
    #[test]
    fn box_field_is_exact_signed_distance() {
        let descriptor =
            descriptor("box", vec![0.0, 0.0, 0.0, 2.0, 2.0, 2.0], vec![], vec![]).unwrap();
        let mut field = FieldEval::new(&descriptor).unwrap();

        let inside = field.eval([0.5, 0.5, 0.5]).unwrap().unwrap();
        assert!(inside < 0.0, "盒内应为负: {inside}");
        let face = field.eval([1.0, 0.5, 0.5]).unwrap().unwrap();
        assert_eq!(face, 0.0, "盒面上应为 0");
        let edge = field.eval([1.0, 1.0, 0.5]).unwrap().unwrap();
        assert_eq!(edge, 0.0, "盒棱上应为 0");
        // 盒外:任一轴超出即严格为正.
        for point in [[1.5, 0.0, 0.0], [2.0, 1.0, 1.0], [0.0, -3.0, 0.0]] {
            let value = field.eval(point).unwrap().unwrap();
            assert!(value > 0.0, "{point:?} 盒外应为正: {value}");
        }
        // 角外:欧氏距离应为 sqrt(3),而不是轴向超出量的 max(1).
        let corner = field.eval([2.0, 2.0, 2.0]).unwrap().unwrap();
        assert!(
            (corner - 3.0f64.sqrt()).abs() < 1e-12,
            "角外应为欧氏距离: {corner}"
        );
    }

    #[test]
    fn box_solid_probe_inside_matches_closed_box() {
        let descriptor =
            descriptor("box", vec![0.0, 0.0, 0.0, 2.0, 2.0, 2.0], vec![], vec![]).unwrap();
        let mut probe = SolidProbe::new(&descriptor).unwrap();
        assert!(probe.inside([0.0, 0.0, 0.0]).unwrap());
        assert!(probe.inside([1.0, 1.0, 1.0]).unwrap(), "边界计为体内");
        assert!(!probe.inside([1.000_001, 0.0, 0.0]).unwrap());
        assert!(!probe.inside([0.0, 0.0, 1.000_001]).unwrap());
    }

    /// 回归:负 top_radius 必须在隐式场入口报错(而不是让 AABB 静默失界).
    #[test]
    fn conic_negative_top_radius_is_rejected() {
        let negative =
            descriptor("conic", vec![0.0, 0.0, 0.0, 2.0, -1.0, 3.0], vec![], vec![]).unwrap();
        let error = match FieldEval::new(&negative) {
            Err(error) => error,
            Ok(_) => panic!("负 top_radius 应报错"),
        };
        assert!(
            error.contains("top_radius"),
            "错误应点名 top_radius: {error}"
        );

        let cone = descriptor("conic", vec![0.0, 0.0, 0.0, 2.0, 0.0, 3.0], vec![], vec![]).unwrap();
        assert!(FieldEval::new(&cone).is_ok(), "top_radius = 0(圆锥)仍合法");
    }

    #[test]
    fn sphere_field_probe_unchanged() {
        let mut probe = SolidProbe::new(&sphere()).unwrap();
        assert!(probe.inside([0.0, 0.0, 0.0]).unwrap());
        assert!(probe.inside([1.0, 0.0, 0.0]).unwrap());
        assert!(!probe.inside([1.0 + 1e-3, 0.0, 0.0]).unwrap());
    }
}
