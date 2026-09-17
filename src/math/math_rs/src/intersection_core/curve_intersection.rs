//! 曲线求交:曲线 ∩ 曲线(离散交点)与曲线 ∩ 隐式场(曲线穿面).
//!
//! 从 `intersection_core` 拆出(202609 结构整理):两类求交都是"把几何差
//! 写成单参数函数再求根",共用 `CurveEval` 的编译缓存与 `roots` 的求根/
//! 去重口径;空间曲线另做线段最近点细化.

use std::cmp::Ordering;

use crate::eval_core::CompiledEvaluator;
use crate::geometry_core::{FieldEval, ObjectDescriptor};
use crate::sampling_core::uniform_nodes;
use crate::transform_core::Mat4;

use crate::numeric_core::roots::{
    dedupe_points, dedupe_roots, dedupe_tolerance_for_scale, find_1d_roots, push_deduped_point,
};
use crate::numeric_core::{clamp, dist, dot, finite, midpoint, sub, V3};

use super::to_world;

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

pub(crate) fn curve_curve_intersections(
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

pub(crate) fn curve_field_intersections(
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
