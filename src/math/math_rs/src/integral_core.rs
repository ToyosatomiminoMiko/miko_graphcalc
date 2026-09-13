//! 数值积分核(基于预计算采样值数组):1D/2D 梯形,辛普森,端点黎曼,勒贝格.
//!
//! 行为契约(掩码语义,全 crate 统一,region/solid 在 domain_integral 同此):
//! - 采样数组里 `NaN`(或其它非有限值)表示"该点不在被积函数定义域内";
//!   所有 from-values 核一律把它当作"该点不贡献测度"(按 0 计入),
//!   **不再**因个别非有限点整条积分报错(202609 审查前 1D/2D rectangle
//!   的 trapz/simpson/riemann 与 lebesgue,region/solid 行为不一致);
//! - 全部样本都非有限的退化情形积分值为 0(与 lebesgue 路径一致);
//! - 长度/区间/层数/layers 等结构性错误仍然报错(那是调用方 bug,不是掩码);
//! - 数组布局:1D 整格 n+1 / 单元端 n;2D 行主序(外层 y,内层 x),
//!   Grid 步长 (n+1),LeftCell/MidCell 步长 n--布局由 sampling_core 保证,
//!   核只按长度校验,不要按语义猜维度.
//!
//! 编码注意:任何新积分核都要先问"非有限点怎么办",答案必须是掩码而不是
//! 报错;不要在核里手工重扫 min/max 与按谓词计测度(用 [`lebesgue_over_cells`]).

use crate::config::LEBESGUE_ZERO_EPSILON;
use crate::config::MAX_LEBESGUE_LAYERS;

/// 辛普森法则节点权重,避免权重数字散落在多个函数里.
const SIMPSON_WEIGHT_EDGE: f64 = 1.0;
const SIMPSON_WEIGHT_ODD: f64 = 4.0;
const SIMPSON_WEIGHT_EVEN: f64 = 2.0;

/// 掩码语义:非有限采样值 = 该点不贡献测度(按 0 计入).
/// 见文件头契约;禁止在此文件里新增"遇 NaN 整体报错"的分支.
fn masked(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

/// 一维区间校验(有限且 min < max)--积分核,积分采样,region 域共用,
/// 错误文案只在这一次定义,避免各处手写 `xa >= xb -> Err(...)` 各不相同.
pub(crate) fn validate_1d_interval(a: f64, b: f64) -> Result<(), String> {
    if !a.is_finite() || !b.is_finite() {
        return Err("积分/采样区间必须为有限数值".to_string());
    }
    if a >= b {
        return Err("积分/采样区间需要满足 min < max".to_string());
    }
    Ok(())
}

/// 二维区间校验(有限且每轴 min < max),同上.
pub(crate) fn validate_2d_interval(x_range: (f64, f64), y_range: (f64, f64)) -> Result<(), String> {
    let (a, b) = x_range;
    let (c, d) = y_range;
    if !a.is_finite() || !b.is_finite() || !c.is_finite() || !d.is_finite() {
        return Err("积分/采样二维区间必须为有限数值".to_string());
    }
    if a >= b || c >= d {
        return Err("积分/采样二维区间需要满足每轴 min < max".to_string());
    }
    Ok(())
}

/// 按值域分层计算勒贝格积分(正部/负部通用).
pub(crate) fn lebesgue_layer_sum(
    layers: usize,
    y_range: f64,
    measure_fn: &dyn Fn(f64) -> f64,
    sign: f64,
) -> Result<f64, String> {
    if layers == 0 {
        return Err("勒贝格积分 layers 必须大于 0".to_string());
    }
    if layers > MAX_LEBESGUE_LAYERS {
        return Err(format!("勒贝格积分 layers 超过上限 {MAX_LEBESGUE_LAYERS}"));
    }
    if !y_range.is_finite() || y_range < 0.0 {
        return Err("勒贝格积分值域必须为非负有限数值".to_string());
    }
    if y_range == 0.0 {
        return Ok(0.0);
    }

    let dy = y_range / layers as f64;
    let mut sum = 0.0;
    for k in 0..layers {
        let threshold = k as f64 * dy;
        sum += sign * measure_fn(threshold) * dy;
    }
    Ok(sum)
}

/// 勒贝格层积分的公共骨架:正部测度 + 负部测度.
///
/// 1D/2D/region/solid 的勒贝格实现差异只在"测度怎么数"(左端点格子,
/// 区域带掩码,体元掩码),把"按值域分层 + 正/负部求和"收口到这里,
/// 各实现只需提供 `positive(t)`(测度 {z > t})与 `negative(t)`
/// (测度 {z < -t})两个测度函数.
pub(crate) fn lebesgue_layered_measure(
    layers: usize,
    z_min: f64,
    z_max: f64,
    positive: &dyn Fn(f64) -> f64,
    negative: &dyn Fn(f64) -> f64,
) -> Result<f64, String> {
    if layers == 0 {
        return Err("勒贝格积分 layers 必须大于 0".to_string());
    }
    if !z_min.is_finite() || !z_max.is_finite() {
        return Ok(0.0);
    }
    let mut sum = 0.0;
    if z_max > LEBESGUE_ZERO_EPSILON {
        sum += lebesgue_layer_sum(layers, z_max, &|t| positive(t), 1.0)?;
    }
    if z_min < -LEBESGUE_ZERO_EPSILON {
        sum += lebesgue_layer_sum(layers, -z_min, &|t| negative(t), -1.0)?;
    }
    Ok(sum)
}

/// 均匀"单元计数测度"的勒贝格分层(region/solid/2D 网格共用的收口).
///
/// `values` 是每个单元代表点的被积值(NaN = 单元不贡献,见文件头掩码契约),
/// 每个单元测度 `cell_measure` 恒定.测度 {z > t} = 满足条件的有限单元数
/// × `cell_measure`,正/负部分层求和交给 [`lebesgue_layered_measure`].
///
/// 编码注意:1D 左端点格子(代表点即单元左端)也走这里--调用方把右端
/// 样本裁掉,按单元传 `cell_measure = h` 即可;不要在调用方重复"扫 min/max
/// + 按谓词计数"的那段循环.
pub(crate) fn lebesgue_over_cells(
    values: &[f64],
    cell_measure: f64,
    layers: usize,
) -> Result<f64, String> {
    let mut z_min = f64::INFINITY;
    let mut z_max = f64::NEG_INFINITY;
    for &z in values {
        if z.is_finite() {
            z_min = z_min.min(z);
            z_max = z_max.max(z);
        }
    }
    if !z_min.is_finite() || !z_max.is_finite() {
        return Ok(0.0);
    }
    let measure_fn = |predicate: &dyn Fn(f64) -> bool| -> f64 {
        let mut count = 0.0;
        for &z in values {
            if z.is_finite() && predicate(z) {
                count += 1.0;
            }
        }
        count * cell_measure
    };
    lebesgue_layered_measure(layers, z_min, z_max, &|t| measure_fn(&|z| z > t), &|t| {
        measure_fn(&|z| z < -t)
    })
}

/// 辛普森法则的节点权重.
pub(crate) fn simpson_weight(idx: usize, total: usize) -> f64 {
    if idx == 0 || idx == total {
        SIMPSON_WEIGHT_EDGE
    } else if idx % 2 == 1 {
        SIMPSON_WEIGHT_ODD
    } else {
        SIMPSON_WEIGHT_EVEN
    }
}

// ================================================================
// 基于预计算值数组的一维积分函数
// ================================================================

pub fn trapz1d_from_values(values: &[f64], a: f64, b: f64) -> Result<f64, String> {
    validate_1d_interval(a, b)?;
    if values.len() < 2 {
        return Err("梯形法至少需要 2 个采样值".to_string());
    }

    let n = values.len() - 1;
    let h = (b - a) / n as f64;
    let mut sum = masked(values[0]) + masked(values[n]);
    for &value in &values[1..n] {
        sum += 2.0 * masked(value);
    }
    Ok((h / 2.0) * sum)
}

pub fn simpson1d_from_values(values: &[f64], a: f64, b: f64) -> Result<f64, String> {
    validate_1d_interval(a, b)?;
    if values.len() < 2 {
        return Err("辛普森法至少需要 2 个采样值".to_string());
    }

    let n = values.len() - 1;
    if !n.is_multiple_of(2) {
        return Err("辛普森法要求 N 必须为偶数".to_string());
    }

    let h = (b - a) / n as f64;
    let mut sum = masked(values[0]) + masked(values[n]);
    for (i, &value) in values.iter().enumerate().take(n).skip(1) {
        sum += simpson_weight(i, n) * masked(value);
    }
    Ok((h / 3.0) * sum)
}

pub fn riemann1d_left_from_values(values: &[f64], a: f64, b: f64) -> Result<f64, String> {
    validate_1d_interval(a, b)?;
    if values.len() < 2 {
        return Err("左黎曼法至少需要 2 个采样值".to_string());
    }

    let n = values.len() - 1;
    let h = (b - a) / n as f64;
    let sum: f64 = values[..n].iter().map(|&v| masked(v)).sum();
    Ok(sum * h)
}

pub fn riemann1d_right_from_values(values: &[f64], a: f64, b: f64) -> Result<f64, String> {
    validate_1d_interval(a, b)?;
    if values.len() < 2 {
        return Err("右黎曼法至少需要 2 个采样值".to_string());
    }

    let n = values.len() - 1;
    let h = (b - a) / n as f64;
    let sum: f64 = values[1..].iter().map(|&v| masked(v)).sum();
    Ok(sum * h)
}

pub fn riemann1d_mid_from_values(values: &[f64], a: f64, b: f64) -> Result<f64, String> {
    validate_1d_interval(a, b)?;
    if values.is_empty() {
        return Err("中点黎曼法至少需要 1 个采样值".to_string());
    }

    let n = values.len();
    let h = (b - a) / n as f64;
    let sum: f64 = values.iter().map(|&v| masked(v)).sum();
    Ok(sum * h)
}

// ================================================================
// 基于预计算值数组的二维积分函数
// ================================================================

pub fn trapz2d_from_values(
    values: &[f64],
    x_range: (f64, f64),
    y_range: (f64, f64),
    n: usize,
    m: usize,
) -> Result<f64, String> {
    validate_2d_interval(x_range, y_range)?;
    if n == 0 || m == 0 {
        return Err("二维梯形法要求 n 和 m 均大于 0".to_string());
    }
    let expected = (n + 1) * (m + 1);
    if values.len() != expected {
        return Err(format!(
            "二维梯形法输入长度错误: 期望 {expected},实际 {}",
            values.len()
        ));
    }

    let (a, b) = x_range;
    let (c, d) = y_range;
    let hx = (b - a) / n as f64;
    let hy = (d - c) / m as f64;
    let mut sum = 0.0;

    for j in 0..=m {
        let wy = if j == 0 || j == m { 1.0 } else { 2.0 };
        for i in 0..=n {
            let wx = if i == 0 || i == n { 1.0 } else { 2.0 };
            sum += wx * wy * masked(values[j * (n + 1) + i]);
        }
    }

    Ok((hx * hy / 4.0) * sum)
}

pub fn simpson2d_from_values(
    values: &[f64],
    x_range: (f64, f64),
    y_range: (f64, f64),
    n: usize,
    m: usize,
) -> Result<f64, String> {
    validate_2d_interval(x_range, y_range)?;
    if n == 0 || m == 0 {
        return Err("二维辛普森法要求 n 和 m 均大于 0".to_string());
    }
    if !n.is_multiple_of(2) || !m.is_multiple_of(2) {
        return Err("二维辛普森法要求 N 和 M 必须为偶数".to_string());
    }
    let expected = (n + 1) * (m + 1);
    if values.len() != expected {
        return Err(format!(
            "二维辛普森法输入长度错误: 期望 {expected},实际 {}",
            values.len()
        ));
    }

    let (a, b) = x_range;
    let (c, d) = y_range;
    let hx = (b - a) / n as f64;
    let hy = (d - c) / m as f64;
    let mut sum = 0.0;

    for j in 0..=m {
        let wy = simpson_weight(j, m);
        for i in 0..=n {
            let wx = simpson_weight(i, n);
            sum += wx * wy * masked(values[j * (n + 1) + i]);
        }
    }

    Ok((hx * hy / 9.0) * sum)
}

/// 二维端点黎曼(左/右/中点)共享实现:输入是 n×m 个"单元采样端"值,
/// 数值 = Σ 值 · hx · hy.左/右/中只差采样端的取法(采样在 sampling_core),
/// 求和公式完全一致,因此这里收敛成一个带方法名的私有实现.
fn riemann2d_endpoint_from_values(
    values: &[f64],
    x_range: (f64, f64),
    y_range: (f64, f64),
    n: usize,
    m: usize,
    label: &str,
) -> Result<f64, String> {
    validate_2d_interval(x_range, y_range)?;
    if n == 0 || m == 0 {
        return Err(format!("二维{label}黎曼法要求 n 和 m 均大于 0"));
    }
    let expected = n * m;
    if values.len() != expected {
        return Err(format!(
            "二维{label}黎曼法输入长度错误: 期望 {expected},实际 {}",
            values.len()
        ));
    }
    let (a, b) = x_range;
    let (c, d) = y_range;
    let hx = (b - a) / n as f64;
    let hy = (d - c) / m as f64;
    let sum: f64 = values.iter().map(|&v| masked(v)).sum();
    Ok(sum * hx * hy)
}

pub fn riemann2d_left_from_values(
    values: &[f64],
    x_range: (f64, f64),
    y_range: (f64, f64),
    n: usize,
    m: usize,
) -> Result<f64, String> {
    riemann2d_endpoint_from_values(values, x_range, y_range, n, m, "左")
}

pub fn riemann2d_right_from_values(
    values: &[f64],
    x_range: (f64, f64),
    y_range: (f64, f64),
    n: usize,
    m: usize,
) -> Result<f64, String> {
    riemann2d_endpoint_from_values(values, x_range, y_range, n, m, "右")
}

pub fn riemann2d_mid_from_values(
    values: &[f64],
    x_range: (f64, f64),
    y_range: (f64, f64),
    n: usize,
    m: usize,
) -> Result<f64, String> {
    riemann2d_endpoint_from_values(values, x_range, y_range, n, m, "中点")
}

// ================================================================
// 勒贝格积分(基于值数组,扫描在 Rust 内完成,零 FFI 回调)
// ================================================================

pub fn lebesgue1d_from_values(
    values: &[f64],
    a: f64,
    b: f64,
    layers: usize,
) -> Result<f64, String> {
    validate_1d_interval(a, b)?;
    if layers == 0 {
        return Err("勒贝格积分 layers 必须大于 0".to_string());
    }
    if values.len() < 2 {
        return Err("勒贝格积分至少需要 2 个采样值".to_string());
    }

    let n = values.len() - 1;
    let h = (b - a) / n as f64;

    // 一维测度采用与 2D 相同的"左端点代表格子"约定:
    // 每个满足条件的左端点样本贡献一段 h,右端点样本不单独贡献,
    // 因此把右端样本裁掉后直接走统一的单元计数测度收口.
    lebesgue_over_cells(&values[..n], h, layers)
}

/// 二维勒贝格积分:输入是 nx×ny 个**单元最小角(左下角)采样值**(行优先,
/// 外层 y,内层 x),与 2D 端点黎曼/region/solid 的"左端点代表格子"约定一致.
///
/// 每个格子 (i, j)(i 为 x 序号, j 为 y 序号)的代表值为
/// `values[j * nx + i]`;测度 {f > t} 按满足条件的格子数 × 单格面积计数.
/// 采样形态由 `IntegralMethod::sample_shape_2d` 保证(Lebesgue -> 最小角),
/// 与 1D lebesgue 的"整格采样,核取左端点"是同一左端点约定的两种形态.
///
/// 202609 审查修复:签名从 `grid_size`(隐含 nx==ny)改为 (nx, ny),
/// rectangle 域允许 n≠m,不再把 m 静默丢弃或报"长度错误".
pub fn lebesgue2d_from_values(
    values: &[f64],
    x_range: (f64, f64),
    y_range: (f64, f64),
    nx: usize,
    ny: usize,
    layers: usize,
) -> Result<f64, String> {
    validate_2d_interval(x_range, y_range)?;
    if nx == 0 || ny == 0 {
        return Err("二维勒贝格积分要求 nx 和 ny 均大于 0".to_string());
    }
    if layers == 0 {
        return Err("勒贝格积分 layers 必须大于 0".to_string());
    }

    let expected = nx * ny;
    if values.len() != expected {
        return Err(format!(
            "二维勒贝格输入长度错误: 期望 {expected},实际 {}",
            values.len()
        ));
    }

    let (a, b) = x_range;
    let (c, d) = y_range;
    let area = ((b - a) / nx as f64) * ((d - c) / ny as f64);
    lebesgue_over_cells(values, area, layers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trapezoid_integrates_linear_function() {
        let values = vec![0.0, 1.0, 2.0, 3.0];
        let value = trapz1d_from_values(&values, 0.0, 3.0).unwrap();

        assert!((value - 4.5).abs() < 1e-12);
    }

    #[test]
    fn riemann_left_right_mid_use_matching_endpoints() {
        // f(x)=x 在 [0,1] 上按 n=4 均匀采样:
        // 左端点 0.375,右端点 0.625,中点 0.5.
        let grid = vec![0.0, 0.25, 0.5, 0.75, 1.0];
        let mid = vec![0.125, 0.375, 0.625, 0.875];

        let left = riemann1d_left_from_values(&grid, 0.0, 1.0).unwrap();
        let right = riemann1d_right_from_values(&grid, 0.0, 1.0).unwrap();
        let middle = riemann1d_mid_from_values(&mid, 0.0, 1.0).unwrap();

        assert!((left - 0.375).abs() < 1e-12);
        assert!((right - 0.625).abs() < 1e-12);
        assert!((middle - 0.5).abs() < 1e-12);
    }

    #[test]
    fn empty_1d_values_return_error() {
        assert!(trapz1d_from_values(&[], 0.0, 1.0).is_err());
        assert!(lebesgue1d_from_values(&[], 0.0, 1.0, 8).is_err());
    }

    #[test]
    fn wrong_2d_length_returns_error_instead_of_panicking() {
        let values = vec![0.0; 3];
        assert!(trapz2d_from_values(&values, (0.0, 1.0), (0.0, 1.0), 1, 1).is_err());
    }

    #[test]
    fn lebesgue_rejects_zero_layers() {
        let values = vec![0.0, 1.0, 2.0];
        assert!(lebesgue1d_from_values(&values, 0.0, 2.0, 0).is_err());
    }

    #[test]
    fn lebesgue1d_of_constant_one_equals_interval_length() {
        // 回归:旧实现每个连续满足区间只计一个 h,常数函数被低估约 n 倍.
        let values = vec![1.0; 641];
        let value = lebesgue1d_from_values(&values, 0.0, 1.0, 16).unwrap();

        assert!((value - 1.0).abs() < 1e-9);
    }

    #[test]
    fn lebesgue1d_of_linear_function_approximates_half() {
        // f(x)=x 在 [0,1] 上,测度 {x: f(x) > t} 应约为 1-t;
        // 用左端点格子法近似,常数项允许端点采样带来的小误差.
        let n = 800usize;
        let values: Vec<f64> = (0..=n).map(|i| i as f64 / n as f64).collect();
        let value = lebesgue1d_from_values(&values, 0.0, 1.0, 64).unwrap();

        assert!((value - 0.5).abs() < 1e-2);
    }

    /// 掩码语义回归:1D trapz/simpson 对"部分定义域"被积函数不再整条报错,
    /// 而是对定义域部分积分(与 region/solid/lebesgue 同约定,见文件头).
    /// sqrt(x-0.5) 在 [0.5,1] 上的积分为 (2/3)·(0.5)^1.5 ≈ 0.23570.
    #[test]
    fn masked_1d_newton_cotes_integrates_partial_domain() {
        let n = 512usize;
        let values: Vec<f64> = (0..=n)
            .map(|i| {
                let x = i as f64 / n as f64;
                if x < 0.5 {
                    f64::NAN
                } else {
                    (x - 0.5).sqrt()
                }
            })
            .collect();
        let analytic = 2.0 / 3.0 * (0.5f64).powf(1.5);

        let trapz = trapz1d_from_values(&values, 0.0, 1.0).expect("trapz 掩码不应报错");
        let simpson = simpson1d_from_values(&values, 0.0, 1.0).expect("simpson 掩码不应报错");
        for value in [trapz, simpson] {
            assert!(
                (value - analytic).abs() < 5e-3,
                "掩码值 {value} vs 解析 {analytic}"
            );
        }
    }

    /// rectangle lebesgue 支持 n≠m(202609 审查前隐含 nx==ny,非方阵报长度错).
    #[test]
    fn lebesgue2d_accepts_rectangular_grids() {
        // [0,2]×[0,1] 上 f≡1,nx=4,ny=2:面积应恰为 2.
        let values = vec![1.0; 4 * 2];
        let value = lebesgue2d_from_values(&values, (0.0, 2.0), (0.0, 1.0), 4, 2, 16).unwrap();
        assert!((value - 2.0).abs() < 1e-9, "矩形面积 {value}");

        // 长度与 n×m 不匹配仍报结构性错误.
        let short = vec![1.0; 7];
        assert!(lebesgue2d_from_values(&short, (0.0, 2.0), (0.0, 1.0), 4, 2, 16).is_err());
    }
}
