//! 运行时数值求值:把编译后的 `Expr` 树按变量上下文逐点解释;
//! 负底数 + 有理指数的实值幂(`real_pow`)也在这里统一实现.
//!
//! 编码注意:
//! - **元数不在本文件校验**:`compile_runtime_expr` 的 `validate_supported`
//!   已经保证每个 `Call` 的元数正确(`builtins::check_function_arity`,
//!   单事实来源,202609 审查 SYM-P2.1),解释器按一元函数直接取 `values[0]`;
//! - 非有限结果返回 `Ok(None)`(掩码语义),不是 `Err`;见 `eval_core.rs`
//!   文件头契约.

use std::collections::HashMap;

use super::parser::{parse_expr, rewrite_aliases, validate_supported};
use super::{BinOp, Expr, RuntimeExpr, UnaryOp};
use crate::builtins;

pub(crate) fn compile_runtime_expr(source: &str) -> Result<RuntimeExpr, String> {
    let parsed = parse_expr(source)?;
    let rewritten = rewrite_aliases(&parsed)?;
    validate_supported(&rewritten)?;
    Ok(rewritten)
}

fn finite_value(value: f64) -> Option<f64> {
    if value.is_finite() {
        Some(value)
    } else {
        None
    }
}

/// 实数幂语义:负底数的非整数次幂只在指数是"约分后分母为奇数"的有理数
/// m/n 时有实值((−x)^(m/n) = (−1)^m·|x|^(m/n));否则返回 NaN.
/// 避免 `(-8)^(1/3)` 之类数学上可定义的实值运算被 `powf` 一律给 NaN
/// (见 prompt/review_report.md SYM-P1.1 的字符串往返教训与 `eval_core.rs`
/// 的回归用例).正底/整数指数仍直接走 `powf`.
///
/// 编码注意:`odd_denominator_rational` 是"容差内最接近奇分母有理数"的
/// 识别器,不是精确判定;因此微小但非零的指数(如 1e-9)若被归约为 0/1
/// 会错误给出 ≈1 的实值,而 (−x)^ε 在 ε->0 沿奇分母逼近的极限不存在,
/// 应为无实值 NaN.m==0 候选在识别器内被跳过以堵住这条路径.
pub(crate) fn real_pow(base: f64, exp: f64) -> f64 {
    if base >= 0.0 || !exp.is_finite() || exp.fract() == 0.0 || !base.is_finite() {
        return base.powf(exp);
    }
    match odd_denominator_rational(exp) {
        Some((num, _)) => {
            let magnitude = base.abs().powf(exp);
            if num % 2 == 0 {
                magnitude
            } else {
                -magnitude
            }
        }
        None => f64::NAN,
    }
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let rest = a % b;
        a = b;
        b = rest;
    }
    a
}

/// 识别指数所用分母上限(奇数扫描的终点,`(1..=MAX_ODD_DEN).step_by(2)`).
const MAX_ODD_DEN: u64 = 1023;
/// 容差:相对尺度上的 1e-9(见 [`odd_denominator_rational`]).
const ODD_RATIONAL_REL_TOL: f64 = 1e-9;
/// 先按"简单分母"扫描的终点:指数写成 1/3,2/3,1/5 这类常见有理数时,
/// 命中都在这个范围内,不需要跑到 1023.
const SIMPLE_ODD_DEN: u64 = 33;

/// 把指数识别为约分后分母为奇数的有理数 `m/n`.
///
/// 只在 |exp − m/n| 足够小(相对 1e-9)时判定成立,避免把任意浮点小数
/// 误认成"奇数分母有理数"(如 0.5 不应命中任何奇数分母).
///
/// 成本与加速(202609 审查 SYM-P3.4):
/// - 返回 `None` 的分支必须扫满,是热点(曲面网格十万点时是 5e7 次量级);
/// - 两段扫描:先在 `n <= SIMPLE_ODD_DEN` 里找(覆盖全部常见有理指数),
///   未命中再扫到 [`MAX_ODD_DEN`].判定顺序与阈值不变,所以**结果与原单段
///   扫描逐位一致**(用 20 万随机指数 + 边界值对拍验证过);
/// - 前置量级判断:`|x| <= 1/(2*MAX_ODD_DEN)` 时任何 `n` 都只能让
///   `x*n` 舍入到 0(m==0 分支必被跳过),直接判无实值.这既省掉整段扫描,
///   也顺手挡掉了「x 很小而 n 很大时 `x*n` 仍有限,但 `round()` 已丢光精度」
///   的极端输入.
fn odd_denominator_rational(x: f64) -> Option<(i64, u64)> {
    if !x.is_finite() {
        return None;
    }
    if x == 0.0 {
        return Some((0, 1));
    }
    let magnitude = x.abs();
    if magnitude <= 1.0 / (2.0 * MAX_ODD_DEN as f64) {
        return None;
    }
    // 容差随量级缩放:常量指数(|x|<=1)用绝对 1e-9,更大的指数按相对比.
    let tolerance = ODD_RATIONAL_REL_TOL * magnitude.max(1.0);

    let scan = |max_odd_den: u64| -> Option<(i64, u64)> {
        for n in (1u64..=max_odd_den).step_by(2) {
            let m = (x * n as f64).round();
            // m==0 意味着 x ≈ 0/1:微小但非零的指数并不等于 0,(−x)^ε 沿奇分母
            // 有理数逼近 0 的极限不存在,应判无实值;x==0 已在函数开头返回.
            // 若在这里放行,(-8)^(1e-9) 会被归约为指数 0 而错误返回 ≈1.
            if m == 0.0 {
                continue;
            }
            if (x - m / n as f64).abs() > tolerance {
                continue;
            }
            let g = gcd(m.abs() as u64, n);
            let reduced_den = n / g;
            if reduced_den % 2 == 1 {
                return Some((m as i64 / g as i64, reduced_den));
            }
        }
        None
    };

    scan(SIMPLE_ODD_DEN).or_else(|| scan(MAX_ODD_DEN))
}

fn evaluate_expr_inner(
    expr: &Expr,
    variables: &HashMap<String, f64>,
) -> Result<Option<f64>, String> {
    match expr {
        Expr::Num(value) => Ok(finite_value(*value)),
        Expr::Sym(name) => {
            // 数值常量名单收口在 builtins;其余名字按变量解析.
            let value = match builtins::constant_value(name) {
                Some(value) => value,
                None => variables
                    .get(name)
                    .copied()
                    .ok_or_else(|| format!("变量 '{}' 未定义", name))?,
            };
            Ok(finite_value(value))
        }
        Expr::Unary(UnaryOp::Neg, operand) => {
            Ok(evaluate_expr_inner(operand, variables)?.map(|value| -value))
        }
        Expr::Binary(op, left, right) => {
            let left = evaluate_expr_inner(left, variables)?;
            let right = evaluate_expr_inner(right, variables)?;
            match (left, right) {
                (Some(left), Some(right)) => {
                    let value = match op {
                        BinOp::Add => left + right,
                        BinOp::Sub => left - right,
                        BinOp::Mul => left * right,
                        BinOp::Div => left / right,
                        BinOp::Pow => real_pow(left, right),
                    };
                    Ok(finite_value(value))
                }
                _ => Ok(None),
            }
        }
        Expr::Call(name, args) => {
            let mut values = Vec::with_capacity(args.len());
            for arg in args {
                let Some(value) = evaluate_expr_inner(arg, variables)? else {
                    return Ok(None);
                };
                values.push(value);
            }
            // 元数由 `compile_runtime_expr -> validate_supported` 保证为 1
            // (单事实来源,202609 审查 SYM-P2.1);取值仍用 `first()` 而不是索引,
            // 保证任何构造路径下解释器都不会越界 panic(编码规范第 5 条).
            let Some(value) = values.first().copied() else {
                return Err(format!("函数 {name} 只接受 1 个参数,当前收到 0 个"));
            };
            let value = builtins::apply_unary(name, value)?;
            Ok(finite_value(value))
        }
        Expr::List(_) => Err("不能直接对数组表达式求值".to_string()),
    }
}

pub(crate) fn evaluate_runtime_expr(
    expr: &RuntimeExpr,
    variables: &HashMap<String, f64>,
) -> Result<Option<f64>, String> {
    evaluate_expr_inner(expr, variables)
}

// ============================================================
// 回归测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn odd_denominator_rational_recognition() {
        assert_eq!(odd_denominator_rational(1.0 / 3.0), Some((1, 3)));
        assert_eq!(odd_denominator_rational(-2.0 / 3.0), Some((-2, 3)));
        assert_eq!(odd_denominator_rational(2.0 / 5.0), Some((2, 5)));
        // 0.5 = 1/2:约分后分母为偶,不应被识别为可实值化的有理指数.
        assert_eq!(odd_denominator_rational(0.5), None);
        // 无理数/一般小数不被误认.
        assert_eq!(odd_denominator_rational(std::f64::consts::SQRT_2), None);
    }

    #[test]
    fn real_power_returns_real_values_for_odd_denominators() {
        assert!((real_pow(-8.0, 1.0 / 3.0) - -2.0).abs() < 1e-12);
        assert!((real_pow(-8.0, 2.0 / 3.0) - 4.0).abs() < 1e-12);
        assert!((real_pow(-8.0, -1.0 / 3.0) - -0.5).abs() < 1e-12);
        assert!((real_pow(-1.0, 0.5)).is_nan(), "(-1)^0.5 无实值");
        assert!((real_pow(2.0, 1.0 / 3.0) - 2.0f64.powf(1.0 / 3.0)).abs() < 1e-12);
    }

    #[test]
    fn tiny_nonzero_exponents_are_not_rounded_to_zero() {
        // 202609 审查 SYM-P1.1 回归:微小但非零的指数不得被归约为 0/1 而返回 ≈1;
        // 1e-9 = 1/10^9 约分后分母为偶,按实数语义应无实值.
        assert!(
            real_pow(-8.0, 1e-9).is_nan(),
            "(-8)^1e-9 不应被当作 (-8)^0 ≈ 1"
        );
        assert!(real_pow(-8.0, -1e-20).is_nan());
        // 真正的奇分母小指数(1/1001)仍给出负实值.
        let value = real_pow(-8.0, 1.0 / 1001.0);
        assert!(value < 0.0 && (value + 8.0f64.powf(1.0 / 1001.0)).abs() < 1e-9);
    }
}
