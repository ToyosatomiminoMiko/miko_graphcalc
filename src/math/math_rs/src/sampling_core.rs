//! 采样层:曲线/曲面/向量场的网格求值,以及积分域的采样形状.
//!
//! 行为契约:
//! - 采样是"求值层",不做掩码决策:非有限值一律写成 `NaN` 占位(曲面/网格),
//!   或按调用方约定跳过(曲线,返回变长数组).积分消费核把 NaN 解释为
//!   "该点不贡献测度"(掩码语义,见 integral_core 头契约),渲染层把它当
//!   "无数据格"--两种消费方共用同一份 NaN 占位;
//! - 布局:二维/三维数组一律行主序(外层 y / 外层 z 中层 y,内层 x);
//!   含端点整格 (n+1)(m+1) 与单元端 n×m 两种形态见 SampleShape,
//!   由 integral_method::sample_shape_* 决定,采样侧不自行发明形状;
//! - 坐标都是世界坐标,系数名与坐标名冲突防护在 eval_core::build_base_context
//!   (1D 允许 y/z 作系数,2D 允许 z,因为对应维度不会覆写它们);
//! - 规模护栏:每个入口先过 config 的上限(MAX_GRID_N / MAX_CURVE_SAMPLES /
//!   MAX_VECTOR_FIELD_POINTS),在分配前报错.
//!
//! 编码注意:单元端点坐标用 integral_method::cell_end_at;线性插值用
//! uniform_nodes,不要在文件里手写第三句 `lo + (hi-lo)*i/n`.

use crate::config::{MAX_CURVE_SAMPLES, MAX_GRID_N, MAX_VECTOR_FIELD_POINTS};
use crate::eval_core::CompiledEvaluator;
use crate::integral_core::{validate_1d_interval, validate_2d_interval};
use crate::integral_method::SampleShape;

/// 均匀网格节点:`lo + (hi-lo)·(i/steps)`,i = 0..=steps(含两端).
///
/// 曲线/求交/求根的"世界坐标采样"都该走这里,别再各自手写同一句线性插值.
pub(crate) fn uniform_nodes(lo: f64, hi: f64, steps: usize) -> impl Iterator<Item = f64> {
    (0..=steps).map(move |i| lo + (hi - lo) * (i as f64 / steps as f64))
}

/// 连续相邻采样点之间,"可判定为断点"的相对跳变阈值.
///
/// 曲线折线不能只是逐点串联:像 `(1 + 1/x)^x` 这种在 x=0 附近定义域的
/// 函数,其正/负两支会被一条"横跨未定义区"的斜线错误连起来(用户称之为
/// "很烦人的连接线").采样层需要把曲线切成若干段,渲染层再把每段画成
/// 独立折线,不再跨断点连线.
///
/// 判定规则(见 [`sample_curve`]):
/// - 必然断:相邻两个有效采样点之间存在未定义(NaN)网格点(定义域空洞);
/// - 疑似断:相邻两个有效采样点跳变超过"中位相邻跳变"的
///   [`ASYMPTOTE_JUMP_FACTOR`] 倍,并且两点跨越了零(符号翻转).这正是
///   "渐近线恰好落在网格点之间,两侧都是有限值"的典型特征(例如
///   `1/(x - 0.03)` 从 -33 跳到 +4.5).要求符号翻转是为了把"曲线上升
///   逼近渐近线的那一段连续斜坡"排除在断点之外,避免把整条曲线剪成碎片.
///
/// 选值依据(默认 [-8,8] 实测):光滑函数如 `x^3`/`sin(x)` 的最大相邻跳变
/// 约是中位跳变的 1~7 倍;而 `1/(x-0.03)` 这类渐近线相邻跳变可达中位
/// 跳变的数十到上千倍.取 16 能在"别误断光滑陡峭区"和"别漏断渐近线"之间
/// 留出余量.
const ASYMPTOTE_JUMP_FACTOR: f64 = 16.0;

/// 计算结果:扁平的逐段顶点 + 每段起始顶点下标.
///
/// `points` 为 `[x, y, 0, ...]` 扁平数组;每个 `offsets[k]` 是第 k 段在
/// `points` 里的起始顶点下标,`offsets.len() == 段数 + 1` 且最后一项等于
/// 顶点总数.约定与 [`crate::intersection_core`] 的 `curve_offsets` 一致,
/// 渲染层据此把曲线画成多条互不相连的折线.
pub type CurvePoints = (Vec<f32>, Vec<u32>);

/// 采样一元函数 y = f(x),并在定义域空洞/竖直渐近线处把结果拆成多段.
///
/// 返回 `(points, offsets)`:见 [`CurvePoints`].非有限值与断点两侧的连接
/// 不再产生伪线段,因此渲染层无需再猜测哪里该断开.
pub fn sample_curve(
    expr: &str,
    coeff_names: &[String],
    coeff_values: &[f64],
    x_min: f64,
    x_max: f64,
    steps: usize,
) -> Result<CurvePoints, String> {
    validate_1d_interval(x_min, x_max)?;
    if steps == 0 {
        return Err("曲线采样需要 steps > 0".to_string());
    }
    if steps > MAX_CURVE_SAMPLES {
        return Err(format!("曲线采样 steps 超过上限 {MAX_CURVE_SAMPLES}"));
    }

    let mut evaluator: CompiledEvaluator = CompiledEvaluator::new(expr, coeff_names, coeff_values)?;

    // 第 1 遍:收集全部有效采样点及其网格下标.非有限点跳过,但会留下下标
    // 空洞,供第 3 遍识别定义域空洞.
    struct Sample {
        x: f32,
        y: f64,
        index: usize,
    }
    let mut samples: Vec<Sample> = Vec::with_capacity(steps + 1);
    for (index, x) in uniform_nodes(x_min, x_max, steps).enumerate() {
        if let Some(y) = evaluator.eval_1d(x)? {
            samples.push(Sample {
                x: x as f32,
                y,
                index,
            });
        }
    }
    let n = samples.len();

    // 第 2 遍:统计"网格相邻"的有效采样对的中位绝对跳变,作为这条曲线上
    // 正常跳变大小的稳健尺度.空洞两侧的跳变不参与统计,免得它们污染中位数.
    let mut jumps: Vec<f64> = Vec::with_capacity(n.saturating_sub(1));
    for w in samples.windows(2) {
        if w[1].index != w[0].index + 1 {
            continue;
        }
        jumps.push((w[1].y - w[0].y).abs());
    }
    let median_jump = median(&jumps);

    // 第 3 遍:把采样点写成扁平顶点流,并在断点处切开(写入新的段起点).
    let mut points: Vec<f32> = Vec::with_capacity(n * 3);
    let mut offsets: Vec<u32> = vec![0];
    for (i, s) in samples.iter().enumerate() {
        if i > 0 {
            let prev = &samples[i - 1];
            // 必然断:两点之间隔着至少一个未定义(被跳过)的网格点.
            let gap_break = s.index != prev.index + 1;
            // 疑似断:相邻但跳变远超这条曲线自身的正常尺度,并且两边跨越
            // 了零(正/负号翻转).这是"渐近线恰好落在网格点之间,两侧都是
            // 有限值"的典型特征:例如 `1/(x - 0.03)` 在 x=0 与 x=0.25 之间
            // 从 -33 跳到 +4.5.用"符号翻转"这一条件,是为了避免把曲线上升
            // 逼近渐近线的那一整段斜坡(同号,逐点放大跳变)误切成碎片.
            // 例如 `(1 + 1/x)^x` 在 x=-1 的左支是连续上升的正值,不该被
            // 剪成单点;它真正的断点是 x=0 附近的定义域空洞,由 gap_break 负责.
            let jump_break = !gap_break
                && median_jump > 0.0
                && ((s.y - prev.y).abs() > ASYMPTOTE_JUMP_FACTOR * median_jump)
                && ((s.y < 0.0) != (prev.y < 0.0));
            if gap_break || jump_break {
                offsets.push((points.len() / 3) as u32);
            }
        }
        points.push(s.x);
        points.push(s.y as f32);
        points.push(0.0);
    }
    offsets.push((points.len() / 3) as u32);

    Ok((points, offsets))
}

/// 中位数;空切片返回 0,避免除零/NaN 污染断点判断.
fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    } else {
        sorted[mid]
    }
}

/// 行优先遍历二维网格并逐点求值(外层 y,内层 x).
///
/// `include_end` 为 `true` 时包含右/上边界,共 `(nx + 1) * (ny + 1)` 个点;
/// 为 `false` 时只取前 `nx * ny` 个格点(黎曼左端点等"恰好 n×m 个采样点"
/// 的形态).两种形态共用同一条遍历/求值循环,避免同一段"外 y 内 x +
/// 非有限填 NaN"逻辑被复制多份.
#[allow(clippy::too_many_arguments)]
fn sample_surface_grid(
    expr: &str,
    coeff_names: &[String],
    coeff_values: &[f64],
    xa: f64,
    xb: f64,
    ya: f64,
    yb: f64,
    nx: usize,
    ny: usize,
    include_end: bool,
    count_error: &str,
) -> Result<Vec<f64>, String> {
    validate_2d_interval((xa, xb), (ya, yb))?;
    if nx == 0 || ny == 0 {
        return Err(count_error.to_string());
    }
    if nx > MAX_GRID_N || ny > MAX_GRID_N {
        return Err(format!("采样网格每轴步数超过上限 {MAX_GRID_N}"));
    }

    let mut evaluator: CompiledEvaluator = CompiledEvaluator::new(expr, coeff_names, coeff_values)?;

    let cols = if include_end { nx + 1 } else { nx };
    let rows = if include_end { ny + 1 } else { ny };
    let mut values: Vec<f64> = Vec::with_capacity(cols * rows);
    for j in 0..rows {
        let y = ya + (yb - ya) * (j as f64 / ny as f64);
        for i in 0..cols {
            let x = xa + (xb - xa) * (i as f64 / nx as f64);
            values.push(evaluator.eval_2d(x, y)?.unwrap_or(f64::NAN));
        }
    }
    Ok(values)
}

/// 在二维网格上采样曲面 z = f(x, y).
///
/// 返回行优先数组 `[f(x0,y0), f(x1,y0), ..., f(xn,ym)]`,长度为
/// `(nx + 1) * (ny + 1)`;非有限值会写成 `NaN`,由调用方决定跳过还是报错.
/// 求交功能需要把两个曲面/一个曲面的隐式差放到同一张网格上做等值线追踪,
/// 因此这里提供批量采样,避免每个网格点重复编译表达式.
#[allow(clippy::too_many_arguments)]
pub fn sample_surface_values(
    expr: &str,
    coeff_names: &[String],
    coeff_values: &[f64],
    xa: f64,
    xb: f64,
    ya: f64,
    yb: f64,
    nx: usize,
    ny: usize,
) -> Result<Vec<f64>, String> {
    sample_surface_grid(
        expr,
        coeff_names,
        coeff_values,
        xa,
        xb,
        ya,
        yb,
        nx,
        ny,
        true,
        "曲面采样需要 nx/ny 均大于 0",
    )
}

/// 采样"每个网格单元的采样端"上的函数值(黎曼端点法的 2D 推广).
///
/// 返回 n×m 行优先数组(外层 y,内层 x);`fx/fy` 是采样端在单元内的
/// 位置(单元边长 = 1):左端 (0,0),右端 (1,1),中点 (0.5,0.5).
/// 非有限值写为 NaN.
#[allow(clippy::too_many_arguments)]
fn sample_cell_ends(
    expr: &str,
    coeff_names: &[String],
    coeff_values: &[f64],
    xa: f64,
    xb: f64,
    ya: f64,
    yb: f64,
    nx: usize,
    ny: usize,
    fx: f64,
    fy: f64,
) -> Result<Vec<f64>, String> {
    validate_2d_interval((xa, xb), (ya, yb))?;
    if nx == 0 || ny == 0 {
        return Err("积分采样需要 n 和 m 均大于 0".to_string());
    }
    if nx > MAX_GRID_N || ny > MAX_GRID_N {
        return Err(format!("采样网格每轴步数超过上限 {MAX_GRID_N}"));
    }
    let mut evaluator: CompiledEvaluator = CompiledEvaluator::new(expr, coeff_names, coeff_values)?;
    let hx = (xb - xa) / nx as f64;
    let hy = (yb - ya) / ny as f64;
    let mut values = Vec::with_capacity(nx * ny);
    for j in 0..ny {
        let y = ya + (j as f64 + fy) * hy;
        for i in 0..nx {
            let x = xa + (i as f64 + fx) * hx;
            values.push(evaluator.eval_2d(x, y)?.unwrap_or(f64::NAN));
        }
    }
    Ok(values)
}

/// 在三维网格上采样向量场 F(x, y, z) = [P, Q, R].
///
/// 返回扁平数组 `[vx, vy, vz, vx, vy, vz, ...]`,长度为 `nx * ny * nz * 3`.
/// 单个分量非有限值时按 0 处理,便于渲染层隐藏零向量箭头.
#[allow(clippy::too_many_arguments)]
pub fn sample_vector_field(
    p_expr: &str,
    q_expr: &str,
    r_expr: &str,
    coeff_names: &[String],
    coeff_values: &[f64],
    x_min: f64,
    x_max: f64,
    y_min: f64,
    y_max: f64,
    z_min: f64,
    z_max: f64,
    nx: usize,
    ny: usize,
    nz: usize,
) -> Result<Vec<f32>, String> {
    validate_1d_interval(x_min, x_max)?;
    validate_1d_interval(y_min, y_max)?;
    validate_1d_interval(z_min, z_max)?;
    if nx == 0 || ny == 0 || nz == 0 {
        return Err("向量场采样需要 nx/ny/nz 均大于 0".to_string());
    }
    if nx > MAX_GRID_N || ny > MAX_GRID_N || nz > MAX_GRID_N {
        return Err(format!("向量场采样每轴格数超过上限 {MAX_GRID_N}"));
    }
    let total_points = nx as u64 * ny as u64 * nz as u64;
    if total_points > MAX_VECTOR_FIELD_POINTS as u64 {
        return Err(format!(
            "向量场采样总点数 {total_points} 超过上限 {MAX_VECTOR_FIELD_POINTS}"
        ));
    }

    let mut p_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(p_expr, coeff_names, coeff_values)?;
    let mut q_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(q_expr, coeff_names, coeff_values)?;
    let mut r_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(r_expr, coeff_names, coeff_values)?;

    let step_x = if nx > 1 {
        (x_max - x_min) / (nx - 1) as f64
    } else {
        0.0
    };
    let step_y = if ny > 1 {
        (y_max - y_min) / (ny - 1) as f64
    } else {
        0.0
    };
    let step_z = if nz > 1 {
        (z_max - z_min) / (nz - 1) as f64
    } else {
        0.0
    };

    let mut vectors = Vec::with_capacity(nx * ny * nz * 3);
    for iz in 0..nz {
        let z = z_min + iz as f64 * step_z;

        for iy in 0..ny {
            let y = y_min + iy as f64 * step_y;

            for ix in 0..nx {
                let x = x_min + ix as f64 * step_x;

                let vx = p_evaluator.eval_at(x, y, z)?.unwrap_or(0.0);
                let vy = q_evaluator.eval_at(x, y, z)?.unwrap_or(0.0);
                let vz = r_evaluator.eval_at(x, y, z)?.unwrap_or(0.0);

                vectors.push(vx as f32);
                vectors.push(vy as f32);
                vectors.push(vz as f32);
            }
        }
    }

    Ok(vectors)
}

pub fn sample_function_1d(
    expr: &str,
    coeff_names: &[String],
    coeff_values: &[f64],
    a: f64,
    b: f64,
    n: usize,
    sample_shape: SampleShape,
) -> Result<Vec<f64>, String> {
    validate_1d_interval(a, b)?;
    if n == 0 {
        return Err("积分采样需要 n > 0".to_string());
    }
    if n > MAX_GRID_N {
        return Err(format!("积分采样 n 超过上限 {MAX_GRID_N}"));
    }

    let mut evaluator = CompiledEvaluator::new(expr, coeff_names, coeff_values)?;

    match sample_shape {
        SampleShape::MidCell => {
            let h = (b - a) / n as f64;
            let mut values = Vec::with_capacity(n);
            for i in 0..n {
                let x = a + (i as f64 + 0.5) * h;
                values.push(evaluator.eval_1d(x)?.unwrap_or(f64::NAN));
            }
            Ok(values)
        }
        // 1D 的梯形/辛普森/黎曼端点/勒贝格统一取含端点整格 n+1 个点,
        // 由 from-values 核按方法消费(左端点/右端点/全部/分层).
        SampleShape::Grid => {
            let mut values = Vec::with_capacity(n + 1);
            for i in 0..=n {
                let x = a + (b - a) * (i as f64 / n as f64);
                values.push(evaluator.eval_1d(x)?.unwrap_or(f64::NAN));
            }
            Ok(values)
        }
        SampleShape::LeftCell | SampleShape::RightCell => {
            Err("左/右单元端采样是二维端点黎曼形态,一维由整格采样 + 核取端点实现".to_string())
        }
    }
}

/// 2D 矩形域采样核心.参数保持扁平是为了与 domain_integral/核函数的
/// 分组保持一致;wasm 边界的多参问题已由 lib.rs 的 JSON 请求结构
/// (`wasm_payloads`)收口,这里不需要请求结构体.
#[allow(clippy::too_many_arguments)]
pub fn sample_function_2d(
    expr: &str,
    coeff_names: &[String],
    coeff_values: &[f64],
    xa: f64,
    xb: f64,
    ya: f64,
    yb: f64,
    n: usize,
    m: usize,
    sample_shape: SampleShape,
) -> Result<Vec<f64>, String> {
    match sample_shape {
        // 单元端采样:每个网格单元取"采样端 = 方法端"的单个采样点.
        // 左端复用 sample_surface_grid 的左端点形态,右/中走 sample_cell_ends,
        // 三者在数值与可视化上同源.
        SampleShape::LeftCell => sample_surface_grid(
            expr,
            coeff_names,
            coeff_values,
            xa,
            xb,
            ya,
            yb,
            n,
            m,
            false,
            "积分采样需要 n 和 m 均大于 0",
        ),
        SampleShape::RightCell => sample_cell_ends(
            expr,
            coeff_names,
            coeff_values,
            xa,
            xb,
            ya,
            yb,
            n,
            m,
            1.0,
            1.0,
        ),
        SampleShape::MidCell => sample_cell_ends(
            expr,
            coeff_names,
            coeff_values,
            xa,
            xb,
            ya,
            yb,
            n,
            m,
            0.5,
            0.5,
        ),
        SampleShape::Grid => {
            sample_surface_values(expr, coeff_names, coeff_values, xa, xb, ya, yb, n, m)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curve_samples_known_linear_function() {
        let (points, offsets) = sample_curve("2 * x + 1", &[], &[], 0.0, 4.0, 4).unwrap();

        assert_eq!(points.len(), 15);
        assert_eq!(offsets, vec![0, 5]); // 连续,只一段
        assert_eq!(points[0], 0.0);
        assert_eq!(points[1], 1.0);
        assert_eq!(points[12], 4.0);
        assert_eq!(points[13], 9.0);
    }

    #[test]
    fn curve_keeps_coefficients_named_like_other_axes() {
        // y/z 在这里是系数而不是采样坐标;一元采样不能覆盖它们.
        let names: Vec<String> = vec!["y".to_string(), "z".to_string()];
        let values: Vec<f64> = vec![2.0, 3.0];
        let (points, _offsets): (Vec<f32>, Vec<u32>) =
            sample_curve("y * x + z", &names, &values, 0.0, 1.0, 1).unwrap();

        assert_eq!(points[1], 3.0);
        assert_eq!(points[4], 5.0);
    }

    #[test]
    fn curve_splits_at_undefined_gap() {
        // (1 + 1/x)^x 在 x=0 附近定义域为空:负半支收敛到 5.196,正半支从
        // 1.732 开始,中间隔着被跳过的 NaN 网格点,必须切成两段.
        let (points, offsets) = sample_curve("(1 + 1/x)^x", &[], &[], -8.0, 8.0, 64).unwrap();

        assert_eq!(offsets.first(), Some(&0));
        assert_eq!(offsets.last(), Some(&((points.len() / 3) as u32)));
        assert!(
            offsets.len() >= 3,
            "定义域空洞应至少切成两段,实际段数 {}",
            offsets.len() - 1
        );

        let vertices = points.len() / 3;
        assert!(vertices > 0);
        // 每个顶点都必须是有限值(不应出现 NaN/Inf 被塞进折线).
        for chunk in points.chunks(3) {
            assert!(
                chunk[0].is_finite() && chunk[1].is_finite(),
                "存在非有限顶点"
            );
        }
    }

    #[test]
    fn curve_splits_at_vertical_asymptote_with_finite_samples() {
        // 渐近线落在网格点之间(0.03),采样点两侧都是有限值,但跳变远超这条
        // 曲线自身的正常尺度,应按渐近线断开,而不是画一条近垂直的斜线.
        let (points, offsets) = sample_curve("1/(x - 0.03)", &[], &[], -8.0, 8.0, 64).unwrap();

        assert_eq!(offsets.first(), Some(&0));
        assert_eq!(offsets.last(), Some(&((points.len() / 3) as u32)));
        assert!(
            offsets.len() >= 3,
            "竖直渐近线应被拆成多段,实际段数 {}",
            offsets.len() - 1
        );
    }

    #[test]
    fn curve_does_not_split_smooth_steep_function() {
        // 平滑但陡的函数(三次多项式/缩放正弦)不应被误断成多段.
        for (expr, coeffs) in [("x^3", ("", "")), ("a * sin(x)", ("a", "1000"))] {
            let names: Vec<String> = if coeffs.0.is_empty() {
                Vec::new()
            } else {
                vec![coeffs.0.to_string()]
            };
            let values: Vec<f64> = if coeffs.1.is_empty() {
                Vec::new()
            } else {
                vec![coeffs.1.parse().unwrap()]
            };
            let (points, offsets) = sample_curve(expr, &names, &values, -8.0, 8.0, 64).unwrap();
            assert_eq!(
                offsets,
                vec![0u32, (points.len() / 3) as u32],
                "{expr} 是连续函数,不应被拆分"
            );
        }
    }

    #[test]
    fn vector_field_uses_zero_for_nonfinite_values() {
        let vectors = sample_vector_field(
            "x",
            "y",
            "z",
            &[],
            &[],
            -1.0,
            1.0,
            -1.0,
            1.0,
            -1.0,
            1.0,
            2,
            2,
            2,
        )
        .unwrap();

        assert_eq!(vectors.len(), 24);
        assert_eq!(vectors[0], -1.0);
        assert_eq!(vectors[1], -1.0);
        assert_eq!(vectors[2], -1.0);
    }

    #[test]
    fn surface_values_sample_row_major_grid() {
        let values = sample_surface_values("x + y", &[], &[], 0.0, 2.0, 0.0, 1.0, 2, 1).unwrap();

        assert_eq!(values.len(), 6);
        assert_eq!(values[0], 0.0); // (0, 0)
        assert_eq!(values[1], 1.0); // (1, 0)
        assert_eq!(values[2], 2.0); // (2, 0)
        assert_eq!(values[3], 1.0); // (0, 1)
        assert_eq!(values[4], 2.0); // (1, 1)
        assert_eq!(values[5], 3.0); // (2, 1)
    }
}
