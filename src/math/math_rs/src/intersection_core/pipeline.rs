//! 顶层入口:组合语义,输出结构与面片侧选择.
//!
//! 从 `intersection_core` 拆出(202609 结构整理):这里只做"选哪条算法路径"
//! 的编排--曲线参与得到离散交点,曲面/体积参与得到空间交线,并对非曲线
//! 组合挑一个面片侧(见 `choose_patch_field_pair`).

use crate::config::MAX_INTERSECTION_SEGMENTS;
use crate::geometry_core::{ObjectDescriptor, ObjectKind};

use super::curve_intersection::{curve_curve_intersections, curve_field_intersections};
use super::marching_squares::patch_field_intersections;
use super::V3;

#[derive(Debug, Default, Clone, PartialEq)]
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
    use crate::geometry_core::parse_object_descriptor;
    use crate::intersection_core::dist;
    use crate::intersection_core::test_support::{
        box_descriptor, conic_descriptor, curve_descriptor, points_of, sphere_descriptor,
        surface_descriptor,
    };

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

    /// 回归:`s1 = sin(x)cos(y)`,range ±6;`s2 = 0`(平面 z = 0),range ±5.
    ///
    /// 交线是 `x = kπ` 与 `y = π/2 + mπ` 的直线网格.这里断言采样出的折线
    /// 真的沿这组直线走,而不是塌陷后连成长弦:
    /// - 每条折线的相邻两点不超过 4 个采样步长(等值线只在一个单元内插值);
    /// - 每个点落在 z = 0 上,且到最近一条 `x = kπ` / `y = π/2 + mπ`
    ///   不超过 2 个采样步长(恰好在格点上的零值让交点有一格以内的近似);
    /// - 直线 `x = 0` 被完整描出(y 跨度 > 9),而不是塌成少数几个点.
    #[test]
    fn wavy_surface_plane_intersection_traces_straight_line_grid() {
        let surface = surface_descriptor("sin(x) * cos(y)", [-6.0, 6.0, -6.0, 6.0]);
        let plane = surface_descriptor("0", [-5.0, 5.0, -5.0, 5.0]);
        let segments = 256;
        let output = compute_pair(&surface, &plane, segments).unwrap();
        let step = 12.0 / segments as f64;
        assert!(output.curve_offsets.len() > 2, "交线应被描出");

        let point_at = |index: usize| -> V3 {
            [
                output.curve_points[index * 3],
                output.curve_points[index * 3 + 1],
                output.curve_points[index * 3 + 2],
            ]
        };
        let mut axis_span = (f64::INFINITY, f64::NEG_INFINITY);
        for pair in output.curve_offsets.windows(2) {
            let (start, end) = (pair[0] as usize, pair[1] as usize);
            assert!(end - start >= 2, "折线至少要有两个点");
            for index in start..end {
                let point = point_at(index);
                assert!(point[2].abs() < 1e-9, "交线点不在 z = 0 上: {point:?}");
                assert!(
                    point[0].abs() <= 5.0 + step && point[1].abs() <= 5.0 + step,
                    "交线点跑到截平面 range 之外: {point:?}"
                );
                let x_line = (point[0] / std::f64::consts::PI).round() * std::f64::consts::PI;
                let y_line = ((point[1] - std::f64::consts::FRAC_PI_2) / std::f64::consts::PI)
                    .round()
                    * std::f64::consts::PI
                    + std::f64::consts::FRAC_PI_2;
                let distance = (point[0] - x_line).abs().min((point[1] - y_line).abs());
                assert!(
                    distance <= 2.0 * step,
                    "交线点偏离直线网格 {distance}: {point:?}"
                );
                if point[0].abs() < step {
                    axis_span.0 = axis_span.0.min(point[1]);
                    axis_span.1 = axis_span.1.max(point[1]);
                }
            }
            for index in start + 1..end {
                assert!(
                    dist(point_at(index - 1), point_at(index)) <= 4.0 * step,
                    "折线相邻两点跨度过大(顶点被错误合并)"
                );
            }
        }
        assert!(
            axis_span.1 - axis_span.0 > 9.0,
            "直线 x = 0 未被完整描出: {axis_span:?}"
        );
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
