//! 单变量,数值系数的多项式:方程求解内核的中间表示.
//!
//! 为什么单独一份:`symbolic/simplify.rs` 明确**不做多项式正规化**(没有同类项
//! 合并,没有展开,没有因式分解,见该文件头).而解方程的第一步恰恰是"移项,
//! 展开,合并同类项",所以求解内核自带一份 dense 系数表,而不是往 simplify
//! 里零敲碎打地加特例.
//!
//! 它是**内核内部**表示,不进 `Expr` 的公开面:对外只给
//! [`super::solve::SolveOutcome`](路线图 §7.1 的结论--步骤产物是独立类型).
//!
//! 保守边界(与"不追求完整 CAS"一致):
//! - 只认**单变量**;第二个未知量一律报错,让用户用 `variable` 选项明确;
//! - 系数必须是**数值**:参数名由调用方在 `coefficients` 里给值,不做符号系数
//!   的代数运算(那需要真正的符号多项式,超出本项目定位);
//! - 次数上限 [`MAX_SOLVE_DEGREE`]:超限给可读错误,不放任指数/乘法膨胀;
//! - 分母含未知量,非整数指数,含未知量的非多项式函数一律报"不是多项式方程".

use std::collections::HashMap;

use super::eval::real_pow;
use super::latex::latex_number;
use super::simplify::evaluate_constant;
use super::{BinOp, Expr, UnaryOp};

/// 内核接受的最高次数.
///
/// 求解本身目前只到二次(见 `solve.rs`);上限更大的意义是"构造多项式时
/// 就拦住爆炸":`(x+1)^50` 展开成 51 项没有意义,报错比算出来更好.
pub(crate) const MAX_SOLVE_DEGREE: usize = 8;

/// 单变量多项式 `c0 + c1 x + ... + cn x^n`.
///
/// `coeffs[i]` 是 `x^i` 的系数;末尾零项一律裁掉,因此:
/// - `coeffs.is_empty()` 是零多项式(次数记为 [`Poly::degree`] 的 `None`);
/// - `degree() == Some(coeffs.len() - 1)`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Poly {
    coeffs: Vec<f64>,
}

impl Poly {
    pub(crate) fn constant(value: f64) -> Self {
        Self::trimmed(vec![value])
    }

    /// 未知量本身 `x`.
    pub(crate) fn variable() -> Self {
        Self::trimmed(vec![0.0, 1.0])
    }

    /// 裁掉末尾零项:零多项式必须表示成空向量,否则 `degree()` 会把 0 当成次数.
    fn trimmed(mut coeffs: Vec<f64>) -> Self {
        while matches!(coeffs.last(), Some(last) if *last == 0.0) {
            coeffs.pop();
        }
        Self { coeffs }
    }

    /// 次数;零多项式没有次数,返回 `None`(调用方必须区分"0 次"与"零多项式").
    pub(crate) fn degree(&self) -> Option<usize> {
        self.coeffs.len().checked_sub(1)
    }

    pub(crate) fn is_zero(&self) -> bool {
        self.coeffs.is_empty()
    }

    /// `x^index` 的系数;越界为 0.
    pub(crate) fn coeff(&self, index: usize) -> f64 {
        self.coeffs.get(index).copied().unwrap_or(0.0)
    }

    pub(crate) fn add(&self, other: &Self) -> Self {
        let length = self.coeffs.len().max(other.coeffs.len());
        let mut coeffs = Vec::with_capacity(length);
        for index in 0..length {
            coeffs.push(self.coeff(index) + other.coeff(index));
        }
        Self::trimmed(coeffs)
    }

    pub(crate) fn sub(&self, other: &Self) -> Self {
        let length = self.coeffs.len().max(other.coeffs.len());
        let mut coeffs = Vec::with_capacity(length);
        for index in 0..length {
            coeffs.push(self.coeff(index) - other.coeff(index));
        }
        Self::trimmed(coeffs)
    }

    pub(crate) fn neg(&self) -> Self {
        Self::trimmed(self.coeffs.iter().map(|value| -value).collect())
    }

    pub(crate) fn scale(&self, factor: f64) -> Self {
        Self::trimmed(self.coeffs.iter().map(|value| value * factor).collect())
    }

    pub(crate) fn mul(&self, other: &Self) -> Result<Self, String> {
        let degree = self.degree().unwrap_or(0) + other.degree().unwrap_or(0);
        if degree > MAX_SOLVE_DEGREE {
            return Err(format!(
                "展开后次数 {degree} 超过求解内核上限 {MAX_SOLVE_DEGREE}"
            ));
        }
        let mut coeffs = vec![0.0; self.coeffs.len() + other.coeffs.len()];
        for (left_index, left) in self.coeffs.iter().enumerate() {
            for (right_index, right) in other.coeffs.iter().enumerate() {
                coeffs[left_index + right_index] += left * right;
            }
        }
        Ok(Self::trimmed(coeffs))
    }

    /// 非负整数次幂;次数超上限报错.
    pub(crate) fn pow_int(&self, exponent: usize) -> Result<Self, String> {
        let degree = self.degree().unwrap_or(0) * exponent;
        if degree > MAX_SOLVE_DEGREE {
            return Err(format!(
                "展开后次数 {degree} 超过求解内核上限 {MAX_SOLVE_DEGREE}"
            ));
        }
        let mut result = Self::constant(1.0);
        for _ in 0..exponent {
            result = result.mul(self)?;
        }
        Ok(result)
    }

    /// `Expr` -> 多项式.
    ///
    /// `coefficients` 是参数名 -> 当前值;出现的参数名必须在表里,否则报错
    /// (不把未声明符号静默当成常数 0).
    pub(crate) fn from_expr(
        expr: &Expr,
        variable: &str,
        coefficients: &HashMap<String, f64>,
    ) -> Result<Self, String> {
        match expr {
            Expr::Num(value) => Ok(Self::constant(*value)),
            Expr::Sym(name) => {
                if name == variable {
                    Ok(Self::variable())
                } else if let Some(value) = coefficients.get(name) {
                    Ok(Self::constant(*value))
                } else {
                    Err(format!(
                        "方程含未声明参数 {name}:请先用 param 声明,或用 variable 选项指定未知量"
                    ))
                }
            }
            Expr::Unary(UnaryOp::Neg, operand) => {
                Ok(Self::from_expr(operand, variable, coefficients)?.neg())
            }
            Expr::Binary(BinOp::Add, left, right) => Ok(Self::from_expr(
                left,
                variable,
                coefficients,
            )?
            .add(&Self::from_expr(right, variable, coefficients)?)),
            Expr::Binary(BinOp::Sub, left, right) => Ok(Self::from_expr(
                left,
                variable,
                coefficients,
            )?
            .sub(&Self::from_expr(right, variable, coefficients)?)),
            Expr::Binary(BinOp::Mul, left, right) => Self::from_expr(left, variable, coefficients)?
                .mul(&Self::from_expr(right, variable, coefficients)?),
            Expr::Binary(BinOp::Div, numerator, denominator) => {
                if contains_variable(denominator, variable) {
                    return Err("方程的分母含未知量,不是多项式方程".to_string());
                }
                let divisor = constant_value(denominator, coefficients)?;
                if divisor == 0.0 {
                    return Err("方程的分母为 0".to_string());
                }
                Ok(Self::from_expr(numerator, variable, coefficients)?.scale(1.0 / divisor))
            }
            Expr::Binary(BinOp::Pow, base, exponent) => {
                if contains_variable(exponent, variable) {
                    return Err("方程含未知量指数,不是多项式方程".to_string());
                }
                let value = constant_value(exponent, coefficients)?;
                if value < 0.0 || value.fract() != 0.0 {
                    return Err(format!(
                        "指数必须是 0..={MAX_SOLVE_DEGREE} 的整数,当前是 {value}"
                    ));
                }
                if value > MAX_SOLVE_DEGREE as f64 {
                    return Err(format!("指数 {value} 超过求解内核上限 {MAX_SOLVE_DEGREE}"));
                }
                Self::from_expr(base, variable, coefficients)?.pow_int(value as usize)
            }
            Expr::Call(name, _) => {
                if contains_variable(expr, variable) {
                    return Err(format!(
                        "方程含非多项式项 {name}(...);求解内核目前只处理多项式"
                    ));
                }
                Ok(Self::constant(constant_value(expr, coefficients)?))
            }
            Expr::List(_) => Err("方程里不能出现数组".to_string()),
        }
    }

    /// 多项式 -> LaTeX 标准形,如 `x^{2} - 5x + 6`,`2x - 3`.
    ///
    /// 约定与设计文档的递等式一致:隐式乘法写 `5x`,幂写 `x^{2}`,常数项
    /// 不带未知量;系数 1 在非常数项里省略.未知量走 `latex_symbol`,希腊字母
    /// 与多字符名与其它公式同源.
    pub(crate) fn to_latex(&self, variable: &str) -> String {
        if self.is_zero() {
            return "0".to_string();
        }
        let symbol = super::latex::latex_symbol(variable);
        let mut out = String::new();
        for degree in (0..self.coeffs.len()).rev() {
            let coefficient = self.coeffs[degree];
            if coefficient == 0.0 {
                continue;
            }
            let negative = coefficient < 0.0;
            let magnitude = coefficient.abs();
            if out.is_empty() {
                if negative {
                    out.push('-');
                }
            } else {
                out.push_str(if negative { " - " } else { " + " });
            }

            let omit_one = magnitude == 1.0 && degree > 0;
            if !omit_one {
                out.push_str(&latex_number(magnitude));
            }
            if degree > 0 {
                out.push_str(&symbol);
                if degree > 1 {
                    out.push_str(&format!("^{{{degree}}}"));
                }
            }
        }
        out
    }
}

/// 子树里是否出现未知量.
pub(crate) fn contains_variable(expr: &Expr, variable: &str) -> bool {
    match expr {
        Expr::Num(_) => false,
        Expr::Sym(name) => name == variable,
        Expr::Unary(_, operand) => contains_variable(operand, variable),
        Expr::Binary(_, left, right) => {
            contains_variable(left, variable) || contains_variable(right, variable)
        }
        Expr::Call(_, args) => args.iter().any(|arg| contains_variable(arg, variable)),
        Expr::List(items) => items.iter().any(|item| contains_variable(item, variable)),
    }
}

/// 把参数名替换成它的当前值(只替换,不求值).
fn substitute_coefficients(expr: &Expr, coefficients: &HashMap<String, f64>) -> Expr {
    match expr {
        Expr::Sym(name) => match coefficients.get(name) {
            Some(value) => Expr::Num(*value),
            None => expr.clone(),
        },
        Expr::Unary(op, operand) => Expr::Unary(
            *op,
            Box::new(substitute_coefficients(operand, coefficients)),
        ),
        Expr::Binary(op, left, right) => Expr::Binary(
            *op,
            Box::new(substitute_coefficients(left, coefficients)),
            Box::new(substitute_coefficients(right, coefficients)),
        ),
        Expr::Call(name, args) => Expr::Call(
            name.clone(),
            args.iter()
                .map(|arg| substitute_coefficients(arg, coefficients))
                .collect(),
        ),
        Expr::List(items) => Expr::List(
            items
                .iter()
                .map(|item| substitute_coefficients(item, coefficients))
                .collect(),
        ),
        Expr::Num(_) => expr.clone(),
    }
}

/// 常量子表达式的数值:先代入参数值,再走 `evaluate_constant`.
///
/// 刻意复用它而不是自己写数值求值:`evaluate_constant` 已经与 `eval.rs` 共用
/// 一套实数幂/函数语义(见 `simplify.rs` 文件头).
pub(crate) fn constant_value(
    expr: &Expr,
    coefficients: &HashMap<String, f64>,
) -> Result<f64, String> {
    let substituted = substitute_coefficients(expr, coefficients);
    match evaluate_constant(&substituted) {
        Ok(Some(value)) => Ok(value),
        Ok(None) => Err("方程里出现非有限数值(如 1/0)".to_string()),
        Err(message) => Err(message),
    }
}

/// 实数幂的薄封装:求解内核里只用于"判别式开方"这类整数判断.
pub(crate) fn integer_sqrt(value: f64) -> Option<i64> {
    if value.is_nan() || value < 0.0 || value.fract() != 0.0 {
        return None;
    }
    let root = real_pow(value, 0.5).round();
    if root < 0.0 || root > i64::MAX as f64 {
        return None;
    }
    let root = root as i64;
    if (root as f64) * (root as f64) == value {
        Some(root)
    } else {
        None
    }
}
