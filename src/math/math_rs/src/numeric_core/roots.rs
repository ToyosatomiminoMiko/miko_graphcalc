//! 一维求根与点/根去重.
//!
//! 从 `intersection_core` 提到 crate 级数值原语层(202609 统一整理):"沿参数
//! 扫符号变化找根"这件事被曲线 ∩ 曲线,曲线 ∩ 隐式场反复使用,相切复核与去重
//! 口径也共用,所以它单独成层,与"求谁跟谁交"无关;去重口径同时供联立的数值
//! 解集复用。
//!
//! 容差契约(与模块根一致):判据一律挂在**采样步长 / 邻域函数量级 /
//! 几何自身尺度**上,不取整段区间的全局最大值,也不取坐标绝对值.

use crate::sampling_core::uniform_nodes;

use super::{dist, V3};

/// 去重半径的基础系数.实际去重按"点集直径 / 根集跨度"等几何自身尺度缩放,
/// 见 `dedupe_point_tolerance` / `dedupe_root_tolerance`(坐标绝对值不参与).
const POINT_DEDUP_TOLERANCE: f64 = 1e-5;

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
pub(crate) fn find_1d_roots<F>(
    f: &mut F,
    lo: f64,
    hi: f64,
    steps: usize,
) -> Result<Vec<f64>, String>
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
pub(crate) fn dedupe_tolerance_for_scale(scale: f64) -> f64 {
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
pub(crate) fn push_deduped_point(result: &mut Vec<V3>, point: V3, tolerance: f64) {
    if !result
        .iter()
        .any(|existing| dist(*existing, point) <= tolerance)
    {
        result.push(point);
    }
}

pub(crate) fn dedupe_points(points: Vec<V3>) -> Vec<V3> {
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

pub(crate) fn dedupe_roots(roots: Vec<f64>) -> Vec<f64> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
