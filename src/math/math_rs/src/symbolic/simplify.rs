//! 常量求值(用于 matrix 条目)与代数化简(折叠,去幺元/零元,乘积因子).
//!
//! 行为契约(202609 审查 SYM-P3.6):
//! - **不做多项式正规化**:没有同类项合并,没有通分,没有因式分解.
//!   例如 `d/dx (x / x)` 输出 `(x - x) / x ^ 2`,`d/dx (x+1)/(x-1)` 输出
//!   `(x - 1 - (x + 1)) / (x - 1) ^ 2`--值正确,只是不好看.
//!   这是**能力边界而不是 bug**:求导链式法则的输出保持可读的最小化简,
//!   真正的多项式正规化需要新的数据结构,不要在这里零敲碎打地加特例;
//! - **化简不得改变定义域/取值**(202609 审查 P1-1..P1-3):每条形状规则都带
//!   前提,不满足就保持原样.常量折叠只在 `is_finite()` 时发生(`1/0`,`0/0`
//!   保持原样);`0 * f`/`0 / f` 只在另一侧可证有限/非零时折叠;
//! - 在"最小化简"之上另有四条**形状**规则,只为把求导链式法则的产物收成
//!   人能读的一行(202609 新增,`d/dx (x^3 + 7/x^4 - 2/x)` 需要它):
//!   1) `(x^a)^b -> x^(a*b)`,要求**外层指数是整数且内层指数是常数**
//!      (只要求外层整数不够:`((-8)^0.5)^2 = NaN` 而 `(-8)^1 = -8`);
//!   2) 同底数幂相除/相乘 `x^m / x^n -> x^(m-n)`,`x^m * x^n -> x^(m+n)`,
//!      要求**指数是常数**(`Unary(Neg, Num)` 先归一成 `Num`)且
//!      **底数可证为正或所有指数同号**(异号会在 `x = 0` 处把 `0 * inf = NaN`
//!      静默变成 `x^0 = 1`);
//!   3) 数值系数并进分数分子 `c * (u / v) -> (c*u) / v`(单个分数因子);
//!   4) `A + (-c)X -> A - cX`,`A - (-c)X -> A + cX`,以及 `A - A -> 0`.
//!
//!   这四条仍然不是多项式正规化:没有同类项合并,也没有通分/因式分解.
//!
//! 编码注意:
//! - `pi`/`e` 等符号常量在表达式归一化阶段(rewrite_aliases)已被折叠成 Num,
//!   因此 evaluate_constant 里不再内联一份常量表(202609 审查去掉重复);
//!   残留的 Sym 一律视为未绑定变量并报错;
//! - 乘积化简的数字因子在任意位置都合并成单一系数,结果不随书写顺序漂移;
//! - 求值内核与 `eval.rs` 共用(`evaluate_with_lookup`),两条路径只差
//!   "符号怎么解析"与错误文案(202609 审查 P3-2 去重).

use super::eval::{evaluate_with_lookup, real_pow, EvalError};
use super::{BinOp, Expr, UnaryOp};

/// 常量求值(矩阵条目等"结构参数"路径).
///
/// 返回 `Ok(None)` 表示结果是**非有限数值**(`1/0`,`0/0`);调用方(矩阵解析)
/// 按"结构参数不允许 inf/NaN"报带行列下标的错,所以这里既不能折成 0,也不该
/// 统一成错误文案.未绑定变量/不支持函数仍是明确的 `Err`.
pub(crate) fn evaluate_constant(expr: &Expr) -> Result<Option<f64>, String> {
    match evaluate_with_lookup(expr, &|_name| None) {
        Ok(value) => Ok(value),
        // pi/e 等常量在 rewrite_aliases 阶段已折叠为 Num,这里不重复登记;
        // 任何残留 Sym 都是未绑定变量(或调用方忘了先归一化).
        Err(EvalError::UnboundSymbol(name)) => Err(format!("矩阵条目包含未绑定变量 {name}")),
        Err(EvalError::UnsupportedCall(name)) => Err(format!("矩阵条目包含不支持的函数 {name}")),
        Err(EvalError::ListNotEvaluable) => Err("矩阵条目中不能包含嵌套数组".to_string()),
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
            // `A - A -> 0`:结构相同即数学相同,对任意定义域都成立(含 A 为
            // 未定义时两侧同为 NaN,掩码语义下都算"不贡献测度").这条同时
            // 让 `0 / (x - x)` 收敛成 `0 / 0`(保持无定义)而不是在求导后
            // 变成 `0 / x - 0 / x` 之类的碎片.
            if left == right {
                return Expr::Num(0.0);
            }
            // `A - (-c)X -> A + cX`,避免 `... - -2 / x^2`.
            if let Some(positive) = positive_lead(&right) {
                return Expr::Binary(BinOp::Add, Box::new(left), Box::new(positive));
            }
        }
        BinOp::Mul => {
            // `0 * f -> 0` 只在 f 可证为有限数值时成立:实数语义下
            // `0 * inf = NaN`,`0 * NaN = NaN`,无条件折叠会把"该点无定义"
            // 静默变成 0.数值互乘已在函数开头按 Num/Num 折叠.
            if (is_zero(&left) && is_finite_constant(&right))
                || (is_zero(&right) && is_finite_constant(&left))
            {
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
            // `0 / c -> 0` 只在 c 是非零有限常数时成立:`0 / 0` 与 `0 / inf`
            // 都不是 0,分母含变量时还可能是 0(见 SYM 审查 P1-3).
            if is_zero(&left) && is_nonzero_constant(&right) {
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

/// `(x^a)^b -> x^(a*b)`,仅当**外层指数是整数且内层指数是常数**.
///
/// 实数语义下 `(x^a)^b = x^(a*b)` 需要前提:只要求 b 为整数是不够的
/// (`((-8)^0.5)^2 = NaN`,而 `(-8)^(0.5*2) = -8`,定义域被静默扩大).
/// 内层指数是常数时 `a*b` 本身可算,规则才落在"整数次幂可结合"的成立区间;
/// 内层是符号(如 `(x^a)^2`)时保持原样,不做定义域扩张.
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
    let Expr::Num(_) = inner.as_ref() else {
        return None;
    };
    let exponent = simplify(Expr::Binary(
        BinOp::Mul,
        inner.clone(),
        Box::new(Expr::Num(*outer)),
    ));
    Some(simplify_binary(BinOp::Pow, base.as_ref().clone(), exponent))
}

/// 指数是否为"可安全合并"的常数.
///
/// 只有 `Num` 形态可合并:`x^m * x^n = x^(m+n)` 在 `x <= 0` 或 `x = 0` 时
/// 不成立(`0^0.5 * 0^-0.5 = 0 * inf = NaN`,合并后成 `0^0 = 1`),所以合并
/// 的前提是底数可证为正.`Unary(Neg, Num)`(如 `x^-1` 的指数)先归一成
/// `Num(-1)` 再参与判定.
fn constant_exponent(exponent: &Expr) -> Option<f64> {
    match exponent {
        Expr::Num(value) => Some(*value),
        Expr::Unary(UnaryOp::Neg, inner) => match inner.as_ref() {
            Expr::Num(value) => Some(-*value),
            _ => None,
        },
        _ => None,
    }
}

/// 底数是否可证为正(合并同底数幂的前提之一).
///
/// 只认能一眼判定的形态:正数值常量,正数内置常量(`pi`/`e`),`exp(...)`,
/// `sqrt(...)`,以及指数为数值常数的幂(如 `e^2`).
fn base_is_provably_positive(base: &Expr) -> bool {
    match base {
        Expr::Num(value) => *value > 0.0,
        Expr::Sym(name) => matches!(
            crate::builtins::constant_value(name),
            Some(value) if value > 0.0
        ),
        Expr::Call(name, _) => matches!(
            crate::builtins::latex_style(name),
            Some(crate::builtins::LatexStyle::Exp) | Some(crate::builtins::LatexStyle::Sqrt)
        ),
        Expr::Binary(BinOp::Pow, _, exponent) => constant_exponent(exponent).is_some(),
        _ => false,
    }
}

/// 合并同底数幂是否安全:除了底数可证为正,还允许"所有指数同号".
///
/// 危险只在指数之和**跨过 0** 时出现:此时 `x^m * x^n` 在 `x = 0` 处是
/// `0 * inf` 或 `inf * 0`(NaN/无定义),而 `x^(m+n)` 变成 `x^0 = 1`(有定义)
/// 或 `x^正数 = 0`--静默把"无定义"变成"有值".
///
/// 指数同号时合并是保值的:`x^3 * x^4 = x^7`(`0` 对 `0`),
/// `x^3 / x^8 = x^-5`(`inf` 对 `inf`,两侧在 `x=0` 都无定义).指数必须在
/// 数值上可比较,所以符号指数一律不合并.
fn power_merge_is_safe(base: &Expr, exponents: &[f64]) -> bool {
    if base_is_provably_positive(base) {
        return true;
    }
    let mut has_positive = false;
    let mut has_negative = false;
    for exponent in exponents {
        if *exponent > 0.0 {
            has_positive = true;
        } else if *exponent < 0.0 {
            has_negative = true;
        }
    }
    !(has_positive && has_negative)
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
    let right_exponent = constant_exponent(right_exponent)?;
    let (coefficient, core) = split_number_coefficient(left);
    let Expr::Binary(BinOp::Pow, left_base, left_exponent) = &core else {
        return None;
    };
    let left_exponent = constant_exponent(left_exponent)?;
    if left_base != right_base || !power_merge_is_safe(left_base, &[left_exponent, right_exponent])
    {
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
        if let Ok(Some(value)) = evaluate_constant(&Expr::Call(name.to_string(), args.clone())) {
            return Expr::Num(value);
        }
    }
    Expr::Call(name.to_string(), args)
}

fn is_zero(expr: &Expr) -> bool {
    matches!(expr, Expr::Num(value) if *value == 0.0)
}

/// 该节点是否为"可证有限"的数值常量.
///
/// 内置常量在求值时优先于变量,`pi`/`e` 都是有限值;变量与表达式一律不算
/// (它们可能是 inf/NaN).
fn is_finite_constant(expr: &Expr) -> bool {
    match expr {
        Expr::Num(value) => value.is_finite(),
        Expr::Sym(name) => {
            matches!(crate::builtins::constant_value(name), Some(v) if v.is_finite())
        }
        _ => false,
    }
}

/// 该节点是否"可证有限"(用来判断 `0 * f` 能否安全折成 0).
///
/// `1/x`/`sqrt(x)`/`ln(x)` 这类含变量或定义域受限的形态一律**不算**:
/// 它们在部分定义域上是 inf/NaN,`0 * f` 必须保持 NaN 而不是 0.
/// 只有数值常量与常量指数幂等显然有限的形态才算.
fn is_finite_expression(expr: &Expr) -> bool {
    match expr {
        Expr::Num(value) => value.is_finite(),
        Expr::Sym(name) => {
            matches!(crate::builtins::constant_value(name), Some(v) if v.is_finite())
        }
        Expr::Binary(BinOp::Pow, base, exponent) => {
            is_finite_expression(base) && is_finite_expression(exponent)
        }
        Expr::Binary(BinOp::Add | BinOp::Sub | BinOp::Mul, left, right) => {
            is_finite_expression(left) && is_finite_expression(right)
        }
        // 除法/函数/变量/列表一律保守判为"不保证有限".
        _ => false,
    }
}

/// 该节点是否为"可证非零有限"的数值常量(`0 / c -> 0` 的前提).
fn is_nonzero_constant(expr: &Expr) -> bool {
    match expr {
        Expr::Num(value) => value.is_finite() && *value != 0.0,
        Expr::Sym(name) => {
            matches!(crate::builtins::constant_value(name), Some(v) if v.is_finite() && v != 0.0)
        }
        _ => false,
    }
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
        // 乘积的数值系数为 0 时也**不能无条件折成 0**:`0 * f` 在 f 非有限
        // (未定义/无穷)处是 NaN,折成 0 会把无定义静默变成有值
        // (`0 * ln(x-1)` 在 x≤1 处本该无定义).只有剩余因子全部可证有限时才折.
        if terms.iter().all(is_finite_expression) {
            return Expr::Num(0.0);
        }
        // 否则保留 0 因子,交给求值层按实数语义算 NaN.
        terms.insert(0, Expr::Num(0.0));
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

/// 同底数幂相乘:`x^m * x^n -> x^(m+n)`,要求指数是常数**且底数可证为正**.
///
/// 与同底数幂相除(`combine_power_quotient`)成对:两者把幂法则/商法则留下的
/// `e^3 * e^4` 收成一个幂.负数/零底数不合并:`x^m * x^n = x^(m+n)` 只在
/// x > 0 时无条件成立(`0^0.5 * 0^-0.5 = NaN` 而 `0^0 = 1`;`(-8)^0.5 *
/// (-8)^0.5 = NaN` 而 `(-8)^1 = -8`),静默扩大定义域比留下层幂更危险.
fn merge_power_factors(terms: Vec<Expr>) -> Vec<Expr> {
    let mut merged: Vec<Expr> = Vec::new();
    for term in terms {
        let Expr::Binary(BinOp::Pow, base, exponent) = &term else {
            merged.push(term);
            continue;
        };
        let Some(exponent) = constant_exponent(exponent) else {
            merged.push(term);
            continue;
        };

        let mut combined = false;
        for existing in merged.iter_mut() {
            let replacement = match existing {
                Expr::Binary(BinOp::Pow, existing_base, existing_exponent)
                    if existing_base == base =>
                {
                    match constant_exponent(existing_exponent) {
                        Some(value) if power_merge_is_safe(base, &[value, exponent]) => {
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
