//! 常量求值(用于 matrix 条目)与代数化简(折叠,去幺元/零元,乘积因子).
//!
//! 行为契约(202609 审查 SYM-P3.6):
//! - **不做多项式正规化**:没有同类项合并,没有通分,没有因式分解.
//!   例如 `d/dx (x / x)` 输出 `(x - x) / x ^ 2`,`d/dx (x+1)/(x-1)` 输出
//!   `(x - 1 - (x + 1)) / (x - 1) ^ 2`--值正确,只是不好看.
//!   这是**能力边界而不是 bug**:求导链式法则的输出保持可读的最小化简,
//!   真正的多项式正规化需要新的数据结构,不要在这里零敲碎打地加特例;
//! - 化简结果对实数语义**不等价变换要谨慎**:只在 `is_finite()` 时才折叠
//!   常量(`1/0`,`0/0` 保持原样,交给消费方按掩码/报错语义处理);
//! - 在"最小化简"之上另有四条**形状**规则,只为把求导链式法则的产物收成
//!   人能读的一行(202609 新增,`d/dx (x^3 + 7/x^4 - 2/x)` 需要它):
//!   1) `(x^a)^b -> x^(a*b)`,仅当外层指数 b 是整数(实数语义下唯一安全的);
//!   2) 同底数幂相除/相乘 `x^m / x^n -> x^(m-n)`,`x^m * x^n -> x^(m+n)`,
//!      指数必须是常数;
//!   3) 数值系数并进分数分子 `c * (u / v) -> (c*u) / v`(单个分数因子);
//!   4) `A + (-c)X -> A - cX`,`A - (-c)X -> A + cX`.
//!
//!   这四条仍然不是多项式正规化:没有同类项合并,也没有通分/因式分解.
//!
//! 编码注意:
//! - `pi`/`e` 等符号常量在表达式归一化阶段(rewrite_aliases)已被折叠成 Num,
//!   因此 evaluate_constant 里不再内联一份常量表(202609 审查去掉重复);
//!   残留的 Sym 一律视为未绑定变量并报错;
//! - 乘积化简的数字因子在任意位置都合并成单一系数,结果不随书写顺序漂移.

use super::eval::real_pow;
use super::{BinOp, Expr, UnaryOp};
use crate::builtins;

pub(crate) fn evaluate_constant(expr: &Expr) -> Result<f64, String> {
    match expr {
        Expr::Num(value) => Ok(*value),
        // pi/e 等常量在 rewrite_aliases 阶段已折叠为 Num,这里不重复登记;
        // 任何残留 Sym 都是未绑定变量(或调用方忘了先归一化).
        Expr::Sym(name) => Err(format!("矩阵条目包含未绑定变量 {name}")),
        Expr::Unary(UnaryOp::Neg, operand) => Ok(-evaluate_constant(operand)?),
        Expr::Binary(op, left, right) => {
            let lhs = evaluate_constant(left)?;
            let rhs = evaluate_constant(right)?;
            match op {
                BinOp::Add => Ok(lhs + rhs),
                BinOp::Sub => Ok(lhs - rhs),
                BinOp::Mul => Ok(lhs * rhs),
                BinOp::Div => Ok(lhs / rhs),
                BinOp::Pow => Ok(real_pow(lhs, rhs)),
            }
        }
        Expr::Call(name, args) => {
            let values = args
                .iter()
                .map(evaluate_constant)
                .collect::<Result<Vec<_>, _>>()?;
            if values.len() != 1 {
                return Err(format!("矩阵条目包含不支持的函数 {name}"));
            }
            builtins::apply_unary(name, values[0])
                .map_err(|_| format!("矩阵条目包含不支持的函数 {name}"))
        }
        Expr::List(_) => Err("矩阵条目中不能包含嵌套数组".to_string()),
    }
}

// ============================================================
// 化简
// ============================================================

pub(crate) fn simplify(expr: Expr) -> Expr {
    match expr {
        Expr::Unary(UnaryOp::Neg, operand) => {
            let operand = simplify(*operand);
            match operand {
                Expr::Num(value) => Expr::Num(-value),
                Expr::Unary(UnaryOp::Neg, inner) => *inner,
                other => Expr::Unary(UnaryOp::Neg, Box::new(other)),
            }
        }
        Expr::Binary(op, left, right) => {
            let left = simplify(*left);
            let right = simplify(*right);
            simplify_binary(op, left, right)
        }
        Expr::Call(name, args) => {
            let args = args.into_iter().map(simplify).collect();
            simplify_call(&name, args)
        }
        Expr::List(items) => Expr::List(items.into_iter().map(simplify).collect()),
        other => other,
    }
}

fn simplify_binary(op: BinOp, left: Expr, right: Expr) -> Expr {
    if let (Expr::Num(lhs), Expr::Num(rhs)) = (&left, &right) {
        let value = match op {
            BinOp::Add => lhs + rhs,
            BinOp::Sub => lhs - rhs,
            BinOp::Mul => lhs * rhs,
            BinOp::Div => lhs / rhs,
            BinOp::Pow => real_pow(*lhs, *rhs),
        };
        if value.is_finite() {
            return Expr::Num(value);
        }
    }

    match op {
        BinOp::Add => {
            if is_zero(&left) {
                return right;
            }
            if is_zero(&right) {
                return left;
            }
            // `A + (-c)X -> A - cX`,把负号提到运算符上,避免 `... + -28 / x^5`.
            if let Some(positive) = positive_lead(&right) {
                return Expr::Binary(BinOp::Sub, Box::new(left), Box::new(positive));
            }
        }
        BinOp::Sub => {
            if is_zero(&right) {
                return left;
            }
            if is_zero(&left) {
                return Expr::Unary(UnaryOp::Neg, Box::new(right));
            }
            // `A - (-c)X -> A + cX`,避免 `... - -2 / x^2`.
            if let Some(positive) = positive_lead(&right) {
                return Expr::Binary(BinOp::Add, Box::new(left), Box::new(positive));
            }
        }
        BinOp::Mul => {
            if is_zero(&left) || is_zero(&right) {
                return Expr::Num(0.0);
            }
            if is_one(&left) {
                return right;
            }
            if is_one(&right) {
                return left;
            }
            return merge_coefficient_into_quotient(simplify_mul(left, right));
        }
        BinOp::Div => {
            if is_zero(&left) {
                return Expr::Num(0.0);
            }
            if is_one(&right) {
                return left;
            }
            if let Some(combined) = combine_power_quotient(&left, &right) {
                return combined;
            }
        }
        BinOp::Pow => {
            if is_zero(&right) {
                return Expr::Num(1.0);
            }
            if is_one(&right) {
                return left;
            }
            if let Some(folded) = fold_integer_power_of_power(&left, &right) {
                return folded;
            }
        }
    }

    Expr::Binary(op, Box::new(left), Box::new(right))
}

/// `(x^a)^b -> x^(a*b)`,仅当外层指数 b 是整数.
///
/// 实数语义下 `(x^a)^b = x^(a*b)` 只在 b 为整数时普遍成立
/// (`((-1)^2)^(1/2) = 1`,而 `(-1)^(2*1/2) = -1`),非整数外层指数保持原样.
/// 这条规则同时也是"打平嵌套幂"的兜底:打印器虽然已给 `(x ^ a) ^ b` 补括号,
/// 但能用指数直接算出来的就不要再留一层括号.
fn fold_integer_power_of_power(left: &Expr, right: &Expr) -> Option<Expr> {
    let Expr::Num(outer) = right else {
        return None;
    };
    if !outer.is_finite() || outer.fract() != 0.0 {
        return None;
    }
    let Expr::Binary(BinOp::Pow, base, inner) = left else {
        return None;
    };
    let exponent = simplify(Expr::Binary(
        BinOp::Mul,
        inner.clone(),
        Box::new(Expr::Num(*outer)),
    ));
    Some(simplify_binary(BinOp::Pow, base.as_ref().clone(), exponent))
}

/// 同底数幂相除:`x^3 / x^8 -> 1 / x^5`,`x^8 / x^3 -> x^5`,`x^3 / x^3 -> 1`.
///
/// 分子最左侧的数值系数一起收进结果的分子,所以
/// `(-7) * (4 x^3 / x^8)` 会先并成 `(-28 x^3) / x^8` 再收成 `-28 / x^5`.
/// 指数必须是常数:`x^m / x^n = x^(m-n)` 在符号指数下只在 x > 0 成立.
fn combine_power_quotient(left: &Expr, right: &Expr) -> Option<Expr> {
    let Expr::Binary(BinOp::Pow, right_base, right_exponent) = right else {
        return None;
    };
    let Expr::Num(right_exponent) = right_exponent.as_ref() else {
        return None;
    };
    let (coefficient, core) = split_number_coefficient(left);
    let Expr::Binary(BinOp::Pow, left_base, left_exponent) = &core else {
        return None;
    };
    let Expr::Num(left_exponent) = left_exponent.as_ref() else {
        return None;
    };
    if left_base != right_base {
        return None;
    }

    let exponent = left_exponent - right_exponent;
    let combined = if exponent == 0.0 {
        Expr::Num(1.0)
    } else if exponent > 0.0 {
        Expr::Binary(BinOp::Pow, left_base.clone(), Box::new(Expr::Num(exponent)))
    } else {
        Expr::Binary(
            BinOp::Div,
            Box::new(Expr::Num(1.0)),
            Box::new(Expr::Binary(
                BinOp::Pow,
                left_base.clone(),
                Box::new(Expr::Num(-exponent)),
            )),
        )
    };
    Some(attach_number_coefficient(coefficient, combined))
}

/// `c * (u / v) -> (c * u) / v`(c 是数值常数),只在乘积恰好只有一个分数
/// 因子时合并.
///
/// 目的是让 `-7 * (4 x^3 / x^8)` 的数字因子与分数分子先并成 `-28 x^3 / x^8`,
/// 后续同底数幂规则才能把它收成 `-28 / x^5`;不碰 `a * (b / c)` 这类通分.
fn merge_coefficient_into_quotient(expr: Expr) -> Expr {
    let Expr::Binary(BinOp::Mul, left, right) = &expr else {
        return expr;
    };
    let Expr::Num(coefficient) = left.as_ref() else {
        return expr;
    };
    let Expr::Binary(BinOp::Div, numerator, denominator) = right.as_ref() else {
        return expr;
    };
    simplify(Expr::Binary(
        BinOp::Div,
        Box::new(Expr::Binary(
            BinOp::Mul,
            Box::new(Expr::Num(*coefficient)),
            numerator.clone(),
        )),
        denominator.clone(),
    ))
}

/// 拆出乘积最左侧的数值系数(化简把系数固定放在最左边);没有则为 1.
fn split_number_coefficient(expr: &Expr) -> (f64, Expr) {
    if let Expr::Binary(BinOp::Mul, left, right) = expr {
        if let Expr::Num(value) = left.as_ref() {
            return (*value, right.as_ref().clone());
        }
    }
    (1.0, expr.clone())
}

/// 把数值系数并回化简结果:优先并进分式分子,保持 `-28 / x^5` 这种单一分式.
fn attach_number_coefficient(coefficient: f64, expr: Expr) -> Expr {
    if coefficient == 1.0 {
        return expr;
    }
    match expr {
        Expr::Binary(BinOp::Div, numerator, denominator) => simplify(Expr::Binary(
            BinOp::Div,
            Box::new(Expr::Binary(
                BinOp::Mul,
                Box::new(Expr::Num(coefficient)),
                numerator,
            )),
            denominator,
        )),
        other => simplify(Expr::Binary(
            BinOp::Mul,
            Box::new(Expr::Num(coefficient)),
            Box::new(other),
        )),
    }
}

/// 若首项数值系数为负,返回把该负号翻正后的等价表达式.
///
/// 只认化简自身会产出的三种形态:`Num`,`数值系数 * X`,`数值分子 / Y`
/// (系数总是被 `simplify_mul` 固定在最左边).用于把
/// `3x^2 + (-28/x^5) - (-2/x^2)` 收敛成 `3x^2 - 28/x^5 + 2/x^2`.
fn positive_lead(expr: &Expr) -> Option<Expr> {
    match expr {
        Expr::Num(value) if *value < 0.0 => Some(Expr::Num(-value)),
        Expr::Binary(BinOp::Mul, left, right) => match left.as_ref() {
            Expr::Num(value) if *value < 0.0 => Some(Expr::Binary(
                BinOp::Mul,
                Box::new(Expr::Num(-value)),
                right.clone(),
            )),
            _ => None,
        },
        Expr::Binary(BinOp::Div, numerator, denominator) => match numerator.as_ref() {
            Expr::Num(value) if *value < 0.0 => Some(Expr::Binary(
                BinOp::Div,
                Box::new(Expr::Num(-value)),
                denominator.clone(),
            )),
            _ => None,
        },
        _ => None,
    }
}

fn simplify_call(name: &str, args: Vec<Expr>) -> Expr {
    if args.iter().all(|arg| matches!(arg, Expr::Num(_))) {
        if let Ok(value) = evaluate_constant(&Expr::Call(name.to_string(), args.clone())) {
            if value.is_finite() {
                return Expr::Num(value);
            }
        }
    }
    Expr::Call(name.to_string(), args)
}

fn is_zero(expr: &Expr) -> bool {
    matches!(expr, Expr::Num(value) if *value == 0.0)
}

fn is_one(expr: &Expr) -> bool {
    matches!(expr, Expr::Num(value) if *value == 1.0)
}

fn simplify_mul(left: Expr, right: Expr) -> Expr {
    let mut factors = Vec::new();
    collect_mul_factors(left, &mut factors);
    collect_mul_factors(right, &mut factors);

    let mut negative = false;
    let mut clean_factors: Vec<Expr> = Vec::new();
    for factor in factors {
        if let Expr::Unary(UnaryOp::Neg, inner) = factor {
            negative = !negative;
            if !matches!(*inner, Expr::Num(_)) {
                clean_factors.push(*inner);
            }
        } else {
            clean_factors.push(factor);
        }
    }

    // 数字因子无论出现在哪个位置都先合并成一个系数:保证 `2 * 3 * x`
    // 与 `x * 2 * 3` 化简出同一棵树(202609 审查前数字只在"连续前缀"时
    // 合并,输出随输入书写顺序漂移,3*(2*x) 不会被收成 6*x).
    let mut coefficient = 1.0;
    let mut terms: Vec<Expr> = Vec::new();
    for factor in clean_factors {
        match factor {
            Expr::Num(value) => coefficient *= value,
            other => terms.push(other),
        }
    }
    if coefficient == 0.0 {
        return Expr::Num(0.0);
    }
    let mut terms = merge_power_factors(terms);

    let mut product: Expr = if coefficient == 1.0 && !terms.is_empty() {
        terms.remove(0)
    } else {
        Expr::Num(coefficient)
    };
    for term in terms {
        product = Expr::Binary(BinOp::Mul, Box::new(product), Box::new(term));
    }

    if negative {
        product = Expr::Unary(UnaryOp::Neg, Box::new(product));
    }
    product
}

/// 同底数幂相乘:`x^m * x^n -> x^(m+n)`,指数必须是常数.
///
/// 与同底数幂相除(`combine_power_quotient`)成对:两者把幂法则/商法则留下的
/// `x^3 * x^4` 与 `x^3 / x^8` 收成一个幂,所以 `d/dx 7/(x^4)^2` 得到
/// `-56 / x^9` 而不是 `-56 * x^3 * x^4 / x^16`.符号指数不动:
/// `x^m * x^n = x^(m+n)` 只在 x > 0 时无条件成立.
fn merge_power_factors(terms: Vec<Expr>) -> Vec<Expr> {
    let mut merged: Vec<Expr> = Vec::new();
    for term in terms {
        let Expr::Binary(BinOp::Pow, base, exponent) = &term else {
            merged.push(term);
            continue;
        };
        let Expr::Num(exponent) = exponent.as_ref() else {
            merged.push(term);
            continue;
        };

        let mut combined = false;
        for existing in merged.iter_mut() {
            let replacement = match existing {
                Expr::Binary(BinOp::Pow, existing_base, existing_exponent)
                    if existing_base == base =>
                {
                    match existing_exponent.as_ref() {
                        Expr::Num(value) => {
                            let total = value + exponent;
                            if total == 1.0 {
                                Some(base.as_ref().clone())
                            } else if total == 0.0 {
                                Some(Expr::Num(1.0))
                            } else {
                                Some(Expr::Binary(
                                    BinOp::Pow,
                                    Box::new(base.as_ref().clone()),
                                    Box::new(Expr::Num(total)),
                                ))
                            }
                        }
                        _ => None,
                    }
                }
                _ => None,
            };
            if let Some(replacement) = replacement {
                *existing = replacement;
                combined = true;
                break;
            }
        }
        if !combined {
            merged.push(term);
        }
    }
    merged
}

fn collect_mul_factors(expr: Expr, out: &mut Vec<Expr>) {
    match expr {
        Expr::Binary(BinOp::Mul, left, right) => {
            collect_mul_factors(*left, out);
            collect_mul_factors(*right, out);
        }
        Expr::Num(1.0) => {}
        other => out.push(other),
    }
}
