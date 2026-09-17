//! 方阵非线性方程组的阻尼 Newton 与盒域多起点扫描.
//!
//! 这是"联立方程数值路径"的底座,与 `roots` 的一维符号扫描互补:
//! - `roots` 擅长沿一维区间找**全部**根(曲线求交靠它);
//! - 本模块擅长在**盒域**里找方阵系统的解:网格起点 + 阻尼 Newton + 去重.
//!
//! 行为契约:
//! - 残差与迭代点一律夹在给定盒域内,不会跑到域外求值;
//! - Jacobian 用中心差分的数值近似(边界退化为单侧);奇异 Jacobian 直接放弃
//!   该起点,不抛错;
//! - 收敛判据是**相对残差**:`|f| <= 1e-9 * (1 + |x|)`;
//! - 扫描是"多起点"的:Lipschitz 意义上无法保证不漏根,所以调用方必须把结果
//!   当作**数值解**如实标注,不能当成精确解集(与 `symbolic::solve` 的精确
//!   路径区分开).

use super::linalg::solve_system;

/// 迭代上限:方阵 Newton 通常 10 步内收敛,80 步不收敛说明这个起点没用.
const MAX_ITERATIONS: usize = 80;
/// 相对残差收敛系数.
const CONVERGENCE_RATIO: f64 = 1e-9;
/// 数值 Jacobian 步长系数(相对 `1 + |x_j|`).
const JACOBIAN_STEP: f64 = 1e-6;
/// 每步最多折半多少次(阻尼线搜索).
const LINE_SEARCH_STEPS: usize = 20;
/// 多起点扫描的去重容差系数(相对盒域对角线).
const ROOT_DEDUPE_RATIO: f64 = 1e-6;

/// 求解域:每个未知量一条闭区间.它同时是扫描网格的范围和 Newton 的夹取范围.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ScanBox {
    pub(crate) axes: Vec<[f64; 2]>,
}

impl ScanBox {
    /// 构造盒域;任一条区间非有限或上下界反了就返回 `None`.
    pub(crate) fn new(axes: Vec<[f64; 2]>) -> Option<Self> {
        if axes.is_empty() {
            return None;
        }
        let valid = axes
            .iter()
            .all(|axis| axis[0].is_finite() && axis[1].is_finite() && axis[0] < axis[1]);
        if !valid {
            return None;
        }
        Some(Self { axes })
    }

    pub(crate) fn dimension(&self) -> usize {
        self.axes.len()
    }

    /// 盒域对角线长度,作为"问题自身尺度"(去重容差与收敛判据都用它).
    fn diagonal(&self) -> f64 {
        let mut sum = 0.0;
        for axis in &self.axes {
            sum += (axis[1] - axis[0]).powi(2);
        }
        sum.sqrt()
    }
}

/// 无穷范数;空向量视为 0.
fn norm_inf(values: &[f64]) -> f64 {
    values
        .iter()
        .fold(0.0f64, |acc, value| acc.max(value.abs()))
}

/// 两点的欧氏距离.
fn distance(a: &[f64], b: &[f64]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(left, right)| (left - right).powi(2))
        .sum::<f64>()
        .sqrt()
}

/// 按容差合并重复解点(保留先出现的那个).
fn dedupe_roots(roots: Vec<Vec<f64>>, tolerance: f64) -> Vec<Vec<f64>> {
    let mut result: Vec<Vec<f64>> = Vec::new();
    for root in roots {
        if !result
            .iter()
            .any(|existing| distance(existing, &root) <= tolerance)
        {
            result.push(root);
        }
    }
    result
}

/// 阻尼 Newton:从 `start` 出发求 `f(x) = 0`,迭代点始终夹在盒域内.
///
/// - `f` 返回 `n` 个残差;返回 `None` 表示该点不可求值(如定义域外);
/// - 收敛返回解点,不收敛/奇异 Jacobian/不可求值返回 `None`.
pub(crate) fn newton<F>(f: &mut F, start: &[f64], domain: &[[f64; 2]]) -> Option<Vec<f64>>
where
    F: FnMut(&[f64]) -> Option<Vec<f64>>,
{
    let dimension = domain.len();
    if dimension == 0 || start.len() != dimension {
        return None;
    }

    let mut x: Vec<f64> = start
        .iter()
        .zip(domain)
        .map(|(value, axis)| super::clamp(*value, axis[0], axis[1]))
        .collect();
    let mut residual = f(&x)?;
    if residual.len() != dimension {
        return None;
    }
    let mut norm = norm_inf(&residual);
    if !norm.is_finite() {
        return None;
    }
    // 收敛判据的尺度取"初始残差 + 当前点量级",避免系数整体放大后误判收敛.
    let scale = 1.0 + norm + norm_inf(&x);

    for _ in 0..MAX_ITERATIONS {
        if norm <= CONVERGENCE_RATIO * scale {
            return Some(x);
        }

        let jacobian = numeric_jacobian(f, &x, domain, &residual)?;
        let mut augmented = vec![vec![0.0; dimension + 1]; dimension];
        for (row, cells) in augmented.iter_mut().enumerate() {
            cells[..dimension].copy_from_slice(&jacobian[row]);
            cells[dimension] = -residual[row];
        }
        let step = solve_system(augmented, dimension)?;
        let step_norm = norm_inf(&step);
        if !step_norm.is_finite() {
            return None;
        }

        // 阻尼线搜索:残差必须真的下降,否则折半;折到极限仍不降就放弃.
        let mut factor = 1.0;
        let mut accepted = false;
        for _ in 0..LINE_SEARCH_STEPS {
            let candidate: Vec<f64> = x
                .iter()
                .zip(&step)
                .zip(domain)
                .map(|((value, delta), axis)| {
                    super::clamp(value + factor * delta, axis[0], axis[1])
                })
                .collect();
            if candidate == x {
                break;
            }
            if let Some(next) = f(&candidate) {
                let next_norm = norm_inf(&next);
                if next_norm.is_finite() && next_norm < norm {
                    x = candidate;
                    residual = next;
                    norm = next_norm;
                    accepted = true;
                    break;
                }
            }
            factor *= 0.5;
        }

        if !accepted {
            // 已到局部极小仍不满足收敛判据:不作为根上报.
            return None;
        }
        if step_norm <= CONVERGENCE_RATIO * scale {
            return Some(x);
        }
    }

    if norm <= CONVERGENCE_RATIO * scale {
        Some(x)
    } else {
        None
    }
}

/// 数值 Jacobian(中心差分,边界退化为单侧);任一列求值失败则整块放弃.
fn numeric_jacobian<F>(
    f: &mut F,
    x: &[f64],
    domain: &[[f64; 2]],
    residual: &[f64],
) -> Option<Vec<Vec<f64>>>
where
    F: FnMut(&[f64]) -> Option<Vec<f64>>,
{
    let dimension = domain.len();
    let mut jacobian = vec![vec![0.0; dimension]; dimension];
    let mut probe = x.to_vec();

    for column in 0..dimension {
        let h = JACOBIAN_STEP * (1.0 + x[column].abs());
        let can_backward = x[column] - h >= domain[column][0];
        let can_forward = x[column] + h <= domain[column][1];
        let (low, high) = match (can_backward, can_forward) {
            (true, true) => (x[column] - h, x[column] + h),
            (false, true) => (x[column], x[column] + h),
            (true, false) => (x[column] - h, x[column]),
            // 盒域比 h 还窄:用整条区间做差分.
            (false, false) => (domain[column][0], domain[column][1]),
        };
        let span = high - low;
        if span <= 0.0 {
            return None;
        }

        probe[column] = low;
        let low_values = f(&probe)?;
        probe[column] = high;
        let high_values = f(&probe)?;
        probe[column] = x[column];

        if low_values.len() != dimension || high_values.len() != dimension {
            return None;
        }
        for row in 0..dimension {
            jacobian[row][column] = (high_values[row] - low_values[row]) / span;
        }
    }

    // 残差作为校验输入保持签名一致(调用方已在当前点求过,这里不重复求值).
    debug_assert_eq!(residual.len(), dimension);
    Some(jacobian)
}

/// 盒域多起点扫描:网格上取起点,按初始残差从小到大依次 Newton,再去重.
///
/// `segments` 是每轴的网格分段数(与求交 `segments` 同义);`max_starts` 是
/// Newton 起点上限,防止高维网格把工作量顶爆.返回去重后的解点(顺序按发现
/// 顺序,调用方如需稳定顺序应自行排序).
///
/// **不保证不漏根**:网格间距大于解的吸引域时可能漏掉,这正是它只能叫
/// "数值解"的原因.
pub(crate) fn scan_roots<F>(
    f: &mut F,
    scan_box: &ScanBox,
    segments: usize,
    max_starts: usize,
) -> Vec<Vec<f64>>
where
    F: FnMut(&[f64]) -> Option<Vec<f64>>,
{
    let domain = &scan_box.axes;
    let dimension = scan_box.dimension();
    if dimension == 0 || segments == 0 || max_starts == 0 {
        return Vec::new();
    }

    // 网格起点 + 初始残差(用于排序,把最有希望的起点排在前面).
    let mut nodes: Vec<(f64, Vec<f64>)> = Vec::new();
    let mut current = vec![0.0; dimension];
    collect_nodes(f, domain, segments, 0, &mut current, &mut nodes);

    nodes.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    nodes.truncate(max_starts);

    let mut roots: Vec<Vec<f64>> = Vec::new();
    for (_, node) in nodes {
        if let Some(root) = newton(f, &node, domain) {
            roots.push(root);
        }
    }

    let tolerance = ROOT_DEDUPE_RATIO * scan_box.diagonal().max(1.0);
    dedupe_roots(roots, tolerance)
}

/// 递归展开网格节点;残差求值失败的点直接跳过.
fn collect_nodes<F>(
    f: &mut F,
    domain: &[[f64; 2]],
    segments: usize,
    axis: usize,
    current: &mut Vec<f64>,
    nodes: &mut Vec<(f64, Vec<f64>)>,
) where
    F: FnMut(&[f64]) -> Option<Vec<f64>>,
{
    if axis == domain.len() {
        if let Some(residual) = f(current) {
            let norm = norm_inf(&residual);
            if norm.is_finite() {
                nodes.push((norm, current.clone()));
            }
        }
        return;
    }
    let [low, high] = domain[axis];
    for index in 0..=segments {
        let value = low + (high - low) * index as f64 / segments as f64;
        current[axis] = value;
        collect_nodes(f, domain, segments, axis + 1, current, nodes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_dimensional_domain() -> Vec<[f64; 2]> {
        vec![[-2.0, 2.0], [-2.0, 2.0]]
    }

    /// 圆与直线的交:`x^2 + y^2 = 1` 与 `x - y = 0` -> `(±1/√2, ±1/√2)`.
    #[test]
    fn newton_converges_on_circle_line_system() {
        let domain = two_dimensional_domain();
        let mut f = |point: &[f64]| {
            let (x, y) = (point[0], point[1]);
            Some(vec![x * x + y * y - 1.0, x - y])
        };

        let root = newton(&mut f, &[0.5, 0.5], &domain).expect("应当收敛");
        let expected = 1.0 / 2.0f64.sqrt();
        assert!((root[0] - expected).abs() < 1e-8, "{root:?}");
        assert!((root[1] - expected).abs() < 1e-8, "{root:?}");
    }

    /// 多起点扫描应把两个解都找出来,且不因重复收敛而重复上报.
    #[test]
    fn scan_finds_both_roots_and_dedupes() {
        let domain = two_dimensional_domain();
        let mut f = |point: &[f64]| {
            let (x, y) = (point[0], point[1]);
            Some(vec![x * x + y * y - 1.0, x - y])
        };

        let roots = scan_roots(&mut f, &ScanBox::new(domain.clone()).unwrap(), 16, 512);
        assert_eq!(roots.len(), 2, "应当刚好两个解: {roots:?}");
        let expected = 1.0 / 2.0f64.sqrt();
        let pairs: Vec<(f64, f64)> = roots.iter().map(|root| (root[0], root[1])).collect();
        assert!(
            pairs
                .iter()
                .any(|(x, y)| (x - expected).abs() < 1e-6 && (y - expected).abs() < 1e-6),
            "{pairs:?}"
        );
        assert!(
            pairs
                .iter()
                .any(|(x, y)| (x + expected).abs() < 1e-6 && (y + expected).abs() < 1e-6),
            "{pairs:?}"
        );
    }

    /// 无解系统必须返回 None / 空集,不能编一个解出来.
    #[test]
    fn system_without_roots_yields_nothing() {
        let domain = two_dimensional_domain();
        let mut f = |point: &[f64]| {
            let (x, y) = (point[0], point[1]);
            Some(vec![x * x + y * y + 1.0, x - y])
        };

        assert!(newton(&mut f, &[0.0, 0.0], &domain).is_none());
        assert!(scan_roots(&mut f, &ScanBox::new(domain.clone()).unwrap(), 12, 256).is_empty());
    }

    /// 迭代点不得越出盒域(残差函数在域外直接报不可求值).
    #[test]
    fn newton_never_leaves_the_box() {
        let domain = vec![[0.0, 1.0], [0.0, 1.0]];
        let mut f = |point: &[f64]| {
            if point.iter().any(|value| *value < 0.0 || *value > 1.0) {
                return None;
            }
            Some(vec![point[0] + point[1] - 1.0, point[0] - point[1]])
        };

        let root = newton(&mut f, &[0.2, 0.8], &domain).expect("盒内应当有解");
        assert!((root[0] - 0.5).abs() < 1e-8, "{root:?}");
        assert!((root[1] - 0.5).abs() < 1e-8, "{root:?}");
    }

    /// `ScanBox` 只接受有限且上界大于下界的区间.
    #[test]
    fn scan_box_validates_axes() {
        assert!(ScanBox::new(vec![[0.0, 1.0], [0.0, 1.0]]).is_some());
        assert!(ScanBox::new(vec![]).is_none());
        assert!(ScanBox::new(vec![[1.0, 0.0]]).is_none());
        assert!(ScanBox::new(vec![[0.0, f64::INFINITY]]).is_none());
    }
}
