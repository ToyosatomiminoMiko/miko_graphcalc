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
//! - 收敛判据**只有相对残差一条**:`|f| <= 1e-9 * (1 + |f_起点| + |x_起点|)`
//!   ("步长足够小"不算收敛:它只说明 `J⁻¹f` 小,残差可能离 0 还很远);
//! - 扫描是"多起点"的:Lipschitz 意义上无法保证不漏根,所以调用方必须把结果
//!   当作**数值解**如实标注,不能当成精确解集(与 `symbolic::solve` 的精确
//!   路径区分开);
//! - 规模由调用方守:[`grid_node_count`] 给出节点数,调用方必须在**求值之前**
//!   判断是否超预算 -- 起点截断发生在网格全部求值之后,拦不住代价;
//! - 起点选择见 [`select_starts`]:按残差择优 **并且** 按盒域分格去偏,
//!   否则一个平坦盆地就能吃光全部起点配额.

use std::collections::HashSet;

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
    // 收敛判据的尺度取"起点残差 + 起点量级",避免系数整体放大后误判收敛.
    // 尺度只算一次:残差判据比较的是"解点附近的残差",相对起点量级已经足够;
    // 每轮重算会让判据跟着残差一起缩小,反而永远收敛不到.
    let scale = 1.0 + norm + norm_inf(&x);

    for _ in 0..MAX_ITERATIONS {
        if norm <= CONVERGENCE_RATIO * scale {
            return Some(x);
        }

        let jacobian = numeric_jacobian(f, &x, domain)?;
        let mut augmented = vec![vec![0.0; dimension + 1]; dimension];
        for (row, cells) in augmented.iter_mut().enumerate() {
            cells[..dimension].copy_from_slice(&jacobian[row]);
            cells[dimension] = -residual[row];
        }
        let step = solve_system(augmented, dimension)?;
        if step.iter().any(|value| !value.is_finite()) {
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
        // 这里**不**用"步长足够小"当收敛判据:步长小只说明
        // `J⁻¹f` 小(比如 Jacobian 接近奇异),残差可能离 0 还很远,
        // 把那样的点当根上报等于给一个错的解.收敛只看残差.
    }

    if norm <= CONVERGENCE_RATIO * scale {
        Some(x)
    } else {
        None
    }
}

/// 数值 Jacobian(中心差分,边界退化为单侧);任一列求值失败则整块放弃.
///
/// 不再接收当前残差:它此前只被 `debug_assert` 用来"保持签名一致",
/// release 下是纯摆设,调用方也刚刚求过值.
fn numeric_jacobian<F>(f: &mut F, x: &[f64], domain: &[[f64; 2]]) -> Option<Vec<Vec<f64>>>
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

    Some(jacobian)
}

/// 盒域多起点扫描:网格上取起点,依次 Newton,再去重.
///
/// `segments` 是每轴的网格分段数(与求交 `segments` 同义);`max_starts` 是
/// Newton 起点上限.返回去重后的解点(顺序按发现顺序,调用方如需稳定顺序应
/// 自行排序).
///
/// **先求值再选起点**:`(segments+1)^dimension` 个节点在这里全部求一遍残差,
/// 规模守卫必须由调用方在进来之前用 [`grid_node_count`] 完成.
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

    // 网格起点 + 初始残差(残差用于给起点排序).
    let mut nodes: Vec<(f64, Vec<f64>)> = Vec::new();
    let mut current = vec![0.0; dimension];
    collect_nodes(f, domain, segments, 0, &mut current, &mut nodes);

    let mut roots: Vec<Vec<f64>> = Vec::new();
    for node in select_starts(nodes, domain, max_starts) {
        if let Some(root) = newton(f, &node, domain) {
            roots.push(root);
        }
    }

    let tolerance = ROOT_DEDUPE_RATIO * scan_box.diagonal().max(1.0);
    dedupe_roots(roots, tolerance)
}

/// 网格节点数 `(segments + 1)^dimension`;溢出时返回 `usize::MAX`.
///
/// 调用方(联立的数值路径)用它做**求值之前**的规模判断:节点是逐个求值的
/// (每个节点还要为 Jacobian 再求若干次),只在选起点时截断等于先付了全部
/// 求值代价 -- 主线程上一次参数拖动就能感觉到,内存也会按节点数翻倍.
pub(crate) fn grid_node_count(dimension: usize, segments: usize) -> usize {
    let per_axis = segments.saturating_add(1);
    (0..dimension)
        .try_fold(1usize, |total, _| total.checked_mul(per_axis))
        .unwrap_or(usize::MAX)
}

/// 从网格节点里挑 Newton 起点.
///
/// 两步,缺一不可:
/// 1. 按初始残差升序 -- 残差小的节点离解近,先试它最省迭代;
/// 2. 按盒域分格去偏,每个格子最多贡献一个起点 -- 只做第 1 步的话,一个
///    "残差平坦"的盆地会挤满小残差节点,吃光全部配额,另一个盆地的解连起点
///    都轮不到(多起点退化成"单盆地多起点",系统性漏根).
///
/// 节点数不超过 `max_starts` 时全部原样使用(小网格不需要去偏).
fn select_starts(
    mut nodes: Vec<(f64, Vec<f64>)>,
    axes: &[[f64; 2]],
    max_starts: usize,
) -> Vec<Vec<f64>> {
    nodes.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if nodes.len() <= max_starts {
        return nodes.into_iter().map(|(_, node)| node).collect();
    }

    // 每轴格子数取 `max_starts^(1/维度)` 向上取整,格子总数因此 >= max_starts.
    let per_axis = (max_starts as f64)
        .powf(1.0 / axes.len() as f64)
        .ceil()
        .max(1.0) as usize;
    // 格子号编码成一个 `usize`(逐轴进位),避免每个节点再分配一个 Vec 当键.
    let mut used: HashSet<usize> = HashSet::new();
    let mut starts: Vec<Vec<f64>> = Vec::with_capacity(max_starts);
    for (_, node) in nodes {
        let mut cell = 0usize;
        for (value, axis) in node.iter().zip(axes) {
            let span = axis[1] - axis[0];
            let ratio = if span > 0.0 {
                (value - axis[0]) / span
            } else {
                0.0
            };
            let index = ((ratio * per_axis as f64) as isize).clamp(0, per_axis as isize - 1);
            cell = cell * per_axis + index as usize;
        }
        if !used.insert(cell) {
            continue;
        }
        starts.push(node);
        if starts.len() == max_starts {
            break;
        }
    }
    starts
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

    /// 节点计数必须与网格一致,并在溢出时饱和到 `usize::MAX`.
    #[test]
    fn grid_node_count_matches_the_grid() {
        assert_eq!(grid_node_count(1, 64), 65);
        assert_eq!(grid_node_count(2, 64), 65 * 65);
        assert_eq!(grid_node_count(3, 64), 65 * 65 * 65);
        assert_eq!(grid_node_count(3, usize::MAX), usize::MAX, "溢出必须饱和");
    }

    /// 起点选择必须跨盒域铺开:一个残差平坦的盆地不能吃光全部配额.
    ///
    /// 直接锁这个行为,是因为"按残差排序后截断"在只有单个盆地时看起来完全
    /// 正常,漏根只会在多解题目上悄悄发生.
    #[test]
    fn start_selection_spreads_across_the_box() {
        let axes = vec![[0.0, 1.0], [0.0, 1.0]];
        // 1000 个挤在左下角的小残差节点 + 1 个右上角的大残差节点.
        let mut nodes: Vec<(f64, Vec<f64>)> = (0..1000)
            .map(|index| {
                (
                    index as f64 * 1e-6,
                    vec![0.001, 0.001 + index as f64 * 1e-7],
                )
            })
            .collect();
        nodes.push((1.0, vec![0.99, 0.99]));

        let starts = select_starts(nodes, &axes, 16);

        assert!(
            starts.iter().any(|node| node[0] > 0.5 && node[1] > 0.5),
            "右上角的解必须拿到起点: {starts:?}"
        );
        assert!(starts.len() <= 16);
        // 小残差节点仍然优先(去偏不是随机抽样).
        assert!(starts.iter().any(|node| node[0] < 0.5 && node[1] < 0.5));
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
