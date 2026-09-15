use crate::eval_core::CompiledEvaluator;

// ================================================================
// field_core - 标量场 / 向量场的梯度\散度\旋度\拉普拉斯数值核心
//
// 架构流程:
//   Rust 符号引擎负责解析表达式并生成符号偏导表达式
//     -> Rust 负责在给定点和系数下做数值求值
//     -> wasm-bindgen 暴露给 Worker / 主线程
//
// 这里只做数值计算,不处理 UI,也不重复实现符号微分.
// evaluate(求值方法)
//
// ∇(Nabla)的定义:
// ∇ = ∂/∂x + ∂/∂y + ∂/∂z
// ================================================================

/// 在给定系数和坐标下求值一个标量表达式.
///
/// 该接口供编译期仍然需要在 TS 侧完成的 point / vector 坐标/transform
/// 参数以及 analysis `at` 坐标使用,避免这些数值求值依赖外部 JS 数学库.
pub fn evaluate_scalar(
    expr: &str,
    coeff_names: &[String],
    coeff_values: &[f64],
    x: f64,
    y: f64,
    z: f64,
) -> Result<f64, String> {
    let mut evaluator = CompiledEvaluator::new(expr, coeff_names, coeff_values)?;
    evaluator.eval_at_strict(x, y, z)
}

// ================================================================
// 梯度
// ================================================================

/// 计算二维标量场 `f(x, y)` 在点 `(x, y)` 处的梯度值
///
/// # 公式
/// ∇f = (∂f/∂x, ∂f/∂y)
///
/// # 参数
/// * `surface_expr` - 标量场 `f` 的表达式(用于求 `f0 = f(x,y)`)
/// * `fx_expr`    - ∂f/∂x 的表达式
/// * `fy_expr`    - ∂f/∂y 的表达式
/// * `coeff_names` - 系数变量名列表
/// * `coeff_values` - 对应的系数值
/// * `x`           - 点的 x 坐标
/// * `y`           - 点的 y 坐标
///
/// # 返回
/// `(f0, fx, fy)`,其中:
/// - `f0` = f(x, y)
/// - `fx` = ∂f/∂x (x, y)
/// - `fy` = ∂f/∂y (x, y)
pub fn evaluate_gradient_point(
    surface_expr: &str,
    fx_expr: &str,
    fy_expr: &str,
    coeff_names: &[String],
    coeff_values: &[f64],
    x: f64,
    y: f64,
) -> Result<(f64, f64, f64), String> {
    let mut surface_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(surface_expr, coeff_names, coeff_values)?;
    let mut fx_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(fx_expr, coeff_names, coeff_values)?;
    let mut fy_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(fy_expr, coeff_names, coeff_values)?;

    let f0: f64 = surface_evaluator.eval_at_strict(x, y, 0.0)?;
    let fx: f64 = fx_evaluator.eval_at_strict(x, y, 0.0)?;
    let fy: f64 = fy_evaluator.eval_at_strict(x, y, 0.0)?;

    Ok((f0, fx, fy))
}

// ================================================================
// 散度
// ================================================================

/// 计算三维向量场 `F(x, y, z) = (P, Q, R)` 在点 `(x, y, z)` 处的散度
///
/// # 公式
/// ∇·F = ∂P/∂x + ∂Q/∂y + ∂R/∂z
///
/// # 参数
/// * `dpx_expr` - ∂P/∂x 的表达式
/// * `dqy_expr` - ∂Q/∂y 的表达式
/// * `drz_expr` - ∂R/∂z 的表达式
/// * `coeff_names` - 系数变量名列表
/// * `coeff_values` - 对应的系数值
/// * `x`, `y`, `z` - 点的坐标
///
/// # 返回
/// 散度值 `∇·F`
#[allow(clippy::too_many_arguments)]
pub fn evaluate_divergence_point(
    dpx_expr: &str,
    dqy_expr: &str,
    drz_expr: &str,
    coeff_names: &[String],
    coeff_values: &[f64],
    x: f64,
    y: f64,
    z: f64,
) -> Result<f64, String> {
    let mut dpx_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(dpx_expr, coeff_names, coeff_values)?;
    let mut dqy_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(dqy_expr, coeff_names, coeff_values)?;
    let mut drz_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(drz_expr, coeff_names, coeff_values)?;

    let dpx: f64 = dpx_evaluator.eval_at_strict(x, y, z)?;
    let dqy: f64 = dqy_evaluator.eval_at_strict(x, y, z)?;
    let drz: f64 = drz_evaluator.eval_at_strict(x, y, z)?;

    Ok(dpx + dqy + drz)
}

// ================================================================
// 拉普拉斯算子
// ================================================================

/// 计算三维标量场 `f(x, y, z)` 在点 `(x, y, z)` 处的拉普拉斯算子值
///
/// # 公式
/// ∇²f = ∇·(∇f) = ∂²f/∂x² + ∂²f/∂y² + ∂²f/∂z²
///
/// # 参数
/// * `fxx_expr` - ∂²f/∂x² 的表达式
/// * `fyy_expr` - ∂²f/∂y² 的表达式
/// * `fzz_expr` - ∂²f/∂z² 的表达式
/// * `coeff_names` - 系数变量名列表
/// * `coeff_values` - 对应的系数值
/// * `x`, `y`, `z` - 点的坐标
///
/// # 返回
/// 拉普拉斯算子值 `∇²f`(标量)
///
/// # 维度口径
/// 与 [`evaluate_gradient_point`] 一致:一元 curve 的 `fyy`/`fzz` 传 `"0"`,
/// 曲面 `z = f(x, y)` 的 `fzz` 传 `"0"`;调用方按源对象的维度给出真实的
/// 二阶偏导表达式,本函数只求三项之和,不做维度推断.
#[allow(clippy::too_many_arguments)]
pub fn evaluate_laplacian_point(
    fxx_expr: &str,
    fyy_expr: &str,
    fzz_expr: &str,
    coeff_names: &[String],
    coeff_values: &[f64],
    x: f64,
    y: f64,
    z: f64,
) -> Result<f64, String> {
    let mut fxx_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(fxx_expr, coeff_names, coeff_values)?;
    let mut fyy_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(fyy_expr, coeff_names, coeff_values)?;
    let mut fzz_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(fzz_expr, coeff_names, coeff_values)?;

    let fxx: f64 = fxx_evaluator.eval_at_strict(x, y, z)?;
    let fyy: f64 = fyy_evaluator.eval_at_strict(x, y, z)?;
    let fzz: f64 = fzz_evaluator.eval_at_strict(x, y, z)?;

    Ok(fxx + fyy + fzz)
}

// ================================================================
// 旋度
// ================================================================

/// 计算三维向量场 `F(x, y, z) = (P, Q, R)` 在点 `(x, y, z)` 处的旋度
///
/// # 公式
/// ∇×F = ( ∂R/∂y - ∂Q/∂z,
///          ∂P/∂z - ∂R/∂x,
///          ∂Q/∂x - ∂P/∂y )
///
/// # 参数
/// * `dr_dy_expr` - ∂R/∂y 的表达式
/// * `dq_dz_expr` - ∂Q/∂z 的表达式
/// * `dp_dz_expr` - ∂P/∂z 的表达式
/// * `dr_dx_expr` - ∂R/∂x 的表达式
/// * `dq_dx_expr` - ∂Q/∂x 的表达式
/// * `dp_dy_expr` - ∂P/∂y 的表达式
/// * `coeff_names` - 系数变量名列表
/// * `coeff_values` - 对应的系数值
/// * `x`, `y`, `z` - 点的坐标
///
/// # 返回
/// `(curl_x, curl_y, curl_z)`,即旋度的三个分量
#[allow(clippy::too_many_arguments)]
pub fn evaluate_curl_point(
    dr_dy_expr: &str,
    dq_dz_expr: &str,
    dp_dz_expr: &str,
    dr_dx_expr: &str,
    dq_dx_expr: &str,
    dp_dy_expr: &str,
    coeff_names: &[String],
    coeff_values: &[f64],
    x: f64,
    y: f64,
    z: f64,
) -> Result<(f64, f64, f64), String> {
    let mut dr_dy_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(dr_dy_expr, coeff_names, coeff_values)?;
    let mut dq_dz_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(dq_dz_expr, coeff_names, coeff_values)?;
    let mut dp_dz_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(dp_dz_expr, coeff_names, coeff_values)?;
    let mut dr_dx_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(dr_dx_expr, coeff_names, coeff_values)?;
    let mut dq_dx_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(dq_dx_expr, coeff_names, coeff_values)?;
    let mut dp_dy_evaluator: CompiledEvaluator =
        CompiledEvaluator::new(dp_dy_expr, coeff_names, coeff_values)?;

    let dr_dy: f64 = dr_dy_evaluator.eval_at_strict(x, y, z)?;
    let dq_dz: f64 = dq_dz_evaluator.eval_at_strict(x, y, z)?;
    let dp_dz: f64 = dp_dz_evaluator.eval_at_strict(x, y, z)?;
    let dr_dx: f64 = dr_dx_evaluator.eval_at_strict(x, y, z)?;
    let dq_dx: f64 = dq_dx_evaluator.eval_at_strict(x, y, z)?;
    let dp_dy: f64 = dp_dy_evaluator.eval_at_strict(x, y, z)?;

    Ok((dr_dy - dq_dz, dp_dz - dr_dx, dq_dx - dp_dy))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_coeffs() -> (Vec<String>, Vec<f64>) {
        (Vec::new(), Vec::new())
    }

    #[test]
    fn scalar_evaluation_uses_coefficients_and_coordinates() {
        let names = vec!["a".to_string()];
        let values = vec![2.0];
        let value = evaluate_scalar("a * x + 1", &names, &values, 3.0, 0.0, 0.0).unwrap();

        assert!((value - 7.0).abs() < 1e-12);
        assert!(evaluate_scalar("unknown_symbol", &names, &values, 0.0, 0.0, 0.0).is_err());
    }

    #[test]
    fn gradient_of_quadratic_surface() {
        let (names, values) = no_coeffs();
        let (f0, fx, fy) =
            evaluate_gradient_point("x^2 + y^2", "2 * x", "2 * y", &names, &values, 3.0, 4.0)
                .unwrap();

        assert!((f0 - 25.0).abs() < 1e-9);
        assert!((fx - 6.0).abs() < 1e-9);
        assert!((fy - 8.0).abs() < 1e-9);
    }

    #[test]
    fn divergence_of_identity_field() {
        let (names, values) = no_coeffs();
        let value =
            evaluate_divergence_point("1", "1", "1", &names, &values, 2.0, -3.0, 7.0).unwrap();

        assert!((value - 3.0).abs() < 1e-9);
    }

    #[test]
    fn curl_of_rotational_field() {
        let (names, values) = no_coeffs();
        let (cx, cy, cz) = evaluate_curl_point(
            "0", "0", "0", "0", "1", "-1", &names, &values, 1.0, 2.0, 3.0,
        )
        .unwrap();

        assert!(cx.abs() < 1e-9);
        assert!(cy.abs() < 1e-9);
        assert!((cz - 2.0).abs() < 1e-9);
    }

    #[test]
    fn laplacian_of_radial_quadratic() {
        let (names, values) = no_coeffs();
        // f = x^2 + y^2:f_xx = 2, f_yy = 2, f_zz = 0 -> ∇²f = 4.
        let value =
            evaluate_laplacian_point("2", "2", "0", &names, &values, 3.0, 4.0, 0.0).unwrap();

        assert!((value - 4.0).abs() < 1e-9);
    }

    #[test]
    fn laplacian_of_harmonic_field_is_zero() {
        let (names, values) = no_coeffs();
        // f = x^2 - y^2 是调和函数:f_xx = 2, f_yy = -2, 和为 0.
        let value =
            evaluate_laplacian_point("2", "-2", "0", &names, &values, 1.0, 2.0, 0.0).unwrap();

        assert!(value.abs() < 1e-9);
    }

    #[test]
    fn laplacian_keeps_coefficients_in_every_component() {
        let names = vec!["a".to_string(), "k".to_string()];
        let values = vec![3.0, 2.0];
        // 表达式可以显式引用系数名,三个分量各自代入同一份系数组.
        let value =
            evaluate_laplacian_point("a", "a", "k * 2", &names, &values, 0.0, 0.0, 0.0).unwrap();

        assert!((value - 10.0).abs() < 1e-9);
    }
}
