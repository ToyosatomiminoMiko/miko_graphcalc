//! LaTeX 输出(仅用于 UI 公式展示).
//!
//! 注意:这里不复用 `rewrite_aliases` + `to_string` 的数值归一化路径,
//! 因为那条路径会把 `pi` / `e` / `deg(180)` 展开成小数.LaTeX 打印器
//! 直接从同一棵 Expr 树生成排版字符串,保留符号形式,并处理函数名,
//! 隐式乘法与分数的 LaTeX 记法.

use super::parser::{parse_expr, rewrite_aliases, validate_supported};
use super::printing::{format_expr, format_number_for_latex, parenthesize, PrintMode};
use super::{BinOp, Expr, UnaryOp};
use crate::builtins;

pub(crate) fn latex_number(value: f64) -> String {
    format_number_for_latex(value)
}

fn latex_greek(name: &str) -> Option<&'static str> {
    Some(match name {
        "alpha" => "\\alpha",
        "beta" => "\\beta",
        "gamma" => "\\gamma",
        "delta" => "\\delta",
        "epsilon" => "\\epsilon",
        "zeta" => "\\zeta",
        "eta" => "\\eta",
        "theta" => "\\theta",
        "iota" => "\\iota",
        "kappa" => "\\kappa",
        "lambda" => "\\lambda",
        "mu" => "\\mu",
        "nu" => "\\nu",
        "xi" => "\\xi",
        "omicron" => "\\omicron",
        "rho" => "\\rho",
        "sigma" => "\\sigma",
        "tau" => "\\tau",
        "upsilon" => "\\upsilon",
        "phi" => "\\phi",
        "chi" => "\\chi",
        "psi" => "\\psi",
        "omega" => "\\omega",
        "Gamma" => "\\Gamma",
        "Delta" => "\\Delta",
        "Theta" => "\\Theta",
        "Lambda" => "\\Lambda",
        "Xi" => "\\Xi",
        "Pi" => "\\Pi",
        "Sigma" => "\\Sigma",
        "Upsilon" => "\\Upsilon",
        "Phi" => "\\Phi",
        "Psi" => "\\Psi",
        "Omega" => "\\Omega",
        _ => return None,
    })
}

pub(crate) fn latex_symbol(name: &str) -> String {
    if let Some(rendered) = builtins::constant_latex(name) {
        return rendered.to_string();
    }

    // 导数记号的展示名(`y'` / `y''` / `y_1'`):`'` 不是合法标识符字符,所以
    // 正常输入永远不会走到这里,不存在与用户符号冲突(见 symbolic/ode.rs 的
    // `prime_view_inner`,归一化阶段的撞名检查另有一道).
    if let Some(index) = name.find('\'') {
        let (base, primes) = name.split_at(index);
        return format!("{}{}", latex_symbol(base), primes);
    }

    if let Some((head, tail)) = name.split_once('_') {
        return format!("{}_{{{}}}", latex_symbol(head), tail.replace('_', "\\_"));
    }
    if let Some(greek) = latex_greek(name) {
        return greek.to_string();
    }
    if name.len() == 1 {
        return name.to_string();
    }
    format!("\\mathit{{{name}}}")
}

fn latex_join_args(arg_texts: &[String]) -> String {
    arg_texts.join(",\\ ")
}

/// 幂运算底数:是否加括号走 `printing` 的共享判定(与 Text 模式同源).
///
/// 覆盖:负数字面量/前缀负号(`(-2)^{x}`),加减乘除形态(`(a + b)^{2}`),
/// 底数本身是幂(`(x^{2})^{3}`,`(e^{x})^{2}`,避免 LaTeX 双上标报错).
pub(crate) fn latex_pow_base(expr: &Expr) -> String {
    let text = to_latex(expr, 0);
    parenthesize(
        &text,
        crate::symbolic::printing::power_base_needs_parentheses(expr, PrintMode::Latex),
    )
}

/// `name(...)` 的 LaTeX 兜底:元数不对(缺参/多参)时退化成
/// `\operatorname{name}\left(...\right)`,绝不索引不存在的参数.
///
/// 元数校验的**权威入口**是 `parser::validate_supported`(SYM-P2.1);这里的兜底
/// 是第二道防线:打印器在任何输入下都不允许 panic(编码规范第 5 条),
/// 而且 `latex_expression` 是独立入口,不能假设调用方一定先跑过归一化.
fn latex_operatorname_fallback(name: &str, arg_texts: &[String]) -> String {
    format!(
        "\\operatorname{{{name}}}\\left({}\\right)",
        latex_join_args(arg_texts)
    )
}

/// 取恰好一个参数;元数不符时返回 `None`.
fn single_arg<'a>(args: &'a [Expr], arg_texts: &'a [String]) -> Option<&'a str> {
    if args.len() == 1 {
        arg_texts.first().map(String::as_str)
    } else {
        None
    }
}

/// 函数调用的 LaTeX 排版.
///
/// 202609 审查 SYM-P1.2:`sqrt()` 这类空参调用曾直接 `arg_texts[0]` 越界 panic
/// (wasm 上是 abort,页面把异常吞掉后公式静默降级成纯文本).现在所有分支都
/// 先查参数个数,元数不符一律走 `\operatorname` 兜底.
pub(crate) fn latex_call(name: &str, args: &[Expr], arg_texts: &[String]) -> String {
    match builtins::alias_latex_kind(name) {
        Some(builtins::AliasLatexKind::SuperscriptPower) if args.len() == 2 => {
            format!("{}^{{{}}}", latex_pow_base(&args[0]), arg_texts[1])
        }
        Some(builtins::AliasLatexKind::Degree) if args.len() == 1 => {
            format!("{}^{{\\circ}}", latex_pow_base(&args[0]))
        }
        Some(builtins::AliasLatexKind::NaturalLog) if args.len() == 1 => {
            format!("\\ln\\left({}\\right)", arg_texts[0])
        }
        _ => match builtins::latex_style(name) {
            // Named 分支天生按参数个数拼接,元数不符也能排版(`\sin\left(\right)`).
            Some(builtins::LatexStyle::Named(function)) => {
                format!("{function}\\left({}\\right)", latex_join_args(arg_texts))
            }
            // 以下形态的排版模板都只能容纳恰好一个参数,多参同样退化成
            // `\operatorname`(不再静默丢参,见审查 SYM-P2.1).
            Some(builtins::LatexStyle::Exp) => match single_arg(args, arg_texts) {
                Some(argument) => format!("e^{{{argument}}}"),
                None => latex_operatorname_fallback(name, arg_texts),
            },
            Some(builtins::LatexStyle::Sqrt) => match single_arg(args, arg_texts) {
                Some(argument) => format!("\\sqrt{{{argument}}}"),
                None => latex_operatorname_fallback(name, arg_texts),
            },
            Some(builtins::LatexStyle::NthRoot(degree)) => match single_arg(args, arg_texts) {
                Some(argument) => format!("\\sqrt[{degree}]{{{argument}}}"),
                None => latex_operatorname_fallback(name, arg_texts),
            },
            Some(builtins::LatexStyle::Abs) => match single_arg(args, arg_texts) {
                Some(argument) => format!("\\left|{argument}\\right|"),
                None => latex_operatorname_fallback(name, arg_texts),
            },
            Some(builtins::LatexStyle::LogBase(base)) => match single_arg(args, arg_texts) {
                Some(argument) => format!("\\log_{{{base}}}\\left({argument}\\right)"),
                None => latex_operatorname_fallback(name, arg_texts),
            },
            None => latex_operatorname_fallback(name, arg_texts),
        },
    }
}

fn latex_product_factor(expr: &Expr) -> String {
    match expr {
        Expr::Binary(BinOp::Add | BinOp::Sub, _, _) => parenthesize(&to_latex(expr, 0), true),
        Expr::Unary(UnaryOp::Neg, _) => parenthesize(&to_latex(expr, 0), true),
        _ => to_latex(expr, 0),
    }
}

fn collect_latex_factors(expr: &Expr, negative: &mut bool, factors: &mut Vec<Expr>) {
    match expr {
        Expr::Binary(BinOp::Mul, left, right) => {
            collect_latex_factors(left, negative, factors);
            collect_latex_factors(right, negative, factors);
        }
        Expr::Unary(UnaryOp::Neg, operand) => {
            *negative = !*negative;
            collect_latex_factors(operand, negative, factors);
        }
        Expr::Num(value) if *value < 0.0 => {
            *negative = !*negative;
            factors.push(Expr::Num(-value));
        }
        other => factors.push(other.clone()),
    }
}

pub(crate) fn latex_product(expr: &Expr) -> String {
    let mut negative = false;
    let mut factors = Vec::new();
    collect_latex_factors(expr, &mut negative, &mut factors);

    let mut body = String::new();
    for (index, factor) in factors.iter().enumerate() {
        if index > 0 {
            let previous_is_number = matches!(factors[index - 1], Expr::Num(_));
            let current_is_number = matches!(factor, Expr::Num(_));
            body.push_str(if previous_is_number && current_is_number {
                " \\cdot "
            } else {
                "\\,"
            });
        }
        body.push_str(&latex_product_factor(factor));
    }
    if negative {
        format!("-{body}")
    } else {
        body
    }
}

fn to_latex(expr: &Expr, parent_prec: u8) -> String {
    format_expr(expr, PrintMode::Latex, parent_prec)
}

/// 表达式 -> LaTeX(UI 公式展示).
///
/// 行为契约:
/// - 元数/未知函数的校验仍走 `rewrite_aliases` + `validate_supported`
///   (别名展开后的树才是"可求值形态",元数不符在这里报错,见 SYM-P2.1);
/// - **排版用解析出的原树**:别名(`pow`/`deg`/`log`)保留符号形式,
///   `latex_call` 才能按 `AliasLatexKind` 排出 `a^{b}` / `x^{\circ}` / `\ln`.
///   202609 修复前直接用展开后的树排版,`deg(180)` 退化成
///   `180 \cdot 0.017453292519943`,`AliasLatexKind` 三个分支全部不可达;
/// - 错误是 `Err(String)`,不 panic(SYM-P1.2);
/// - `pi` / `e` 不折叠成小数:展示层保留符号形式,数值语义由 Text 路径负责.
pub fn latex_expression(expr: &str) -> Result<String, String> {
    let parsed = parse_expr(expr)?;
    // 校验用展开后的树(元数是"求值形态"的属性),排版用原树(保留别名写法).
    let rewritten = rewrite_aliases(&parsed)?;
    validate_supported(&rewritten)?;
    Ok(to_latex(&parsed, 0))
}
