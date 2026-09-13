//! 文本/LaTeX 统一打印器:优先级与加括号规则只写一份(用 `PrintMode`
//! 区分两种渲染),LaTeX 的函数/乘积等具体排版在 `latex` 子模块.
//!
//! 数字输出契约(两条路径,精度要求不同,不要合并):
//! - Text(可执行串):**必须 round-trip**--归一化产物会作为字符串重新进入
//!   `compile_runtime_expr` / TS `evaluate_scalar`,打印丢精度就是求值丢精度.
//!   整数走 `as i64`,其余走 Rust f64 的最短 round-trip 表示(`{}` /
//!   `{:e}`),词法器(parser.rs 的 `lex_number`)能回读 `e`/`E` 指数.
//! - LaTeX(展示):可以美化,保持 15 位小数 + 去尾零,数值语义交给 Text 路径.
//!
//! 历史坑(202609 审查 SYM-P1.1):两条路径共用 `format!("{value:.15}")` 时,
//! `|x| < 5e-16` 打印成 `0`,`5e-16` 打印成 `1e-15`,
//! `pi` 打印成 15 位截断值;归一化串回读后语义与原树不一致
//! (`(-8)^(1e-16)` 变成 `(-8) ^ 0`),`1/180` 之类常量还会一路累积误差.

use std::f64::consts::PI;

use super::latex::{latex_call, latex_number, latex_pow_base, latex_product, latex_symbol};
use super::{BinOp, Expr, UnaryOp};

fn is_atomic(expr: &Expr) -> bool {
    matches!(expr, Expr::Num(_) | Expr::Sym(_))
}

pub(crate) fn parenthesize(inner: &str, needed: bool) -> String {
    if needed {
        format!("({inner})")
    } else {
        inner.to_string()
    }
}

/// 十进制展示串:`{:.15}`(15 位小数)加去尾零.
///
/// **只用于 LaTeX 展示**,不要拿它生成可执行串:15 位小数对
/// `|x| < 5e-16` 会塌缩成 `0`,对任意 `x` 也不保证 round-trip(SYM-P1.1).
fn format_decimal_for_display(value: f64) -> String {
    let mut text = format!("{value:.15}");
    while text.contains('.') && text.ends_with('0') {
        text.pop();
    }
    if text.ends_with('.') {
        text.pop();
    }
    text
}

/// 可执行文本串:f64 的最短 round-trip 表示(回读后与原值按位相等).
///
/// 量级过大/过小时改用 `{:e}` 指数记法,避免 `1e300` 变成 301 位十进制串
/// (SYM-P3.3);词法器只把 `e`/`E` 当指数读取(见 `parser.rs` 的 `lex_number`),
/// 所以 `1e-20`,`2.5e300` 都能安全回读.
fn format_exact(value: f64) -> String {
    if value == 0.0 {
        // 统一 0 / -0:数值上等价,避免归一化串出现 "-0" 这种无意义形态.
        return "0".to_string();
    }
    let magnitude = value.abs();
    if magnitude < 1e-4 || magnitude >= 1e16 {
        format!("{value:e}")
    } else {
        format!("{value}")
    }
}

/// 数值打印:整数保持十进制可读形态,其余走 round-trip 精确路径.
///
/// `format!("{value}")` 对有限 f64 就是最短 round-trip 表示,整数分支只是
/// 去掉 `2.0 -> 2` 尾巴;两者都不会丢精度,这是函数契约.
fn format_text_number(value: f64) -> String {
    if value == value.trunc() && value.abs() < i64::MAX as f64 {
        format!("{}", value as i64)
    } else {
        format_exact(value)
    }
}

/// LaTeX 展示用数字:保留 `\pi` / `e` 符号形式,其余沿用去尾零的十进制美化.
pub(crate) fn format_number_for_latex(value: f64) -> String {
    if value == PI {
        "\\pi".to_string()
    } else if value == std::f64::consts::E {
        "e".to_string()
    } else {
        format_decimal_for_display(value)
    }
}

/// Text 模式数字:可执行串的唯一入口,契约是 round-trip 精确.
pub(crate) fn format_number(value: f64) -> String {
    format_text_number(value)
}

#[derive(Clone, Copy)]
pub(crate) enum PrintMode {
    Text,
    Latex,
}

fn expr_prec(expr: &Expr) -> u8 {
    match expr {
        Expr::Num(_) | Expr::Sym(_) | Expr::Call(_, _) | Expr::List(_) => 100,
        Expr::Unary(_, _) => 60,
        Expr::Binary(op, _, _) => op.prec(),
    }
}

fn binary_child(expr: &Expr, mode: PrintMode, op: BinOp, is_right: bool) -> String {
    let child_prec = expr_prec(expr);
    // 同优先级子节点是否要括号取决于结合性:
    // - `-` / `/` 左结合,只有右侧同级子节点需要(a - (b - c),a / (b / c));
    // - `^` 右结合,**底数(左侧)同级也要括号**:`(x ^ 2) ^ 3` 少写括号会
    //   重读成 `x ^ (2 ^ 3)`(= x^8,值从 x^6 变成 x^8).202609 修复前
    //   Text 模式漏了这个括号,`7 / x ^ 4` 求导得到的分母被打印成
    //   `x ^ 4 ^ 2`,回读后从 x^8 变成 x^16.
    let needs_parentheses = child_prec < op.prec()
        || (child_prec == op.prec()
            && match op {
                BinOp::Sub | BinOp::Div => is_right,
                BinOp::Pow => true,
                _ => false,
            });
    parenthesize(&format_expr(expr, mode, 0), needs_parentheses)
}

/// 唯一树打印入口.
///
/// 文本模式生成归一化后可执行的字符串;LaTeX 模式生成 UI 排版字符串.
/// 优先级与加括号规则在这里只写一份,两种模式只保留叶子/运算符渲染差异.
pub(crate) fn format_expr(expr: &Expr, mode: PrintMode, parent_prec: u8) -> String {
    match expr {
        Expr::Num(value) => match mode {
            PrintMode::Text => format_number(*value),
            PrintMode::Latex => latex_number(*value),
        },
        Expr::Sym(name) => match mode {
            PrintMode::Text => name.clone(),
            PrintMode::Latex => latex_symbol(name),
        },
        Expr::List(items) => {
            let separator = match mode {
                PrintMode::Text => ", ",
                PrintMode::Latex => ",\\ ",
            };
            let body = items
                .iter()
                .map(|item| format_expr(item, mode, 0))
                .collect::<Vec<_>>()
                .join(separator);
            format!("[{body}]")
        }
        Expr::Unary(UnaryOp::Neg, operand) => {
            let body = format_expr(operand, mode, 0);
            let text = match mode {
                PrintMode::Text => {
                    if is_atomic(operand) || matches!(operand.as_ref(), Expr::Call(_, _)) {
                        format!("-{body}")
                    } else {
                        format!("-({body})")
                    }
                }
                PrintMode::Latex => {
                    // 202609 审查 SYM-P3.7:LaTeX 的 `-` 没有可回读的优先级语义,
                    // `--x` 会排成"两个负号"而误读;这里把负号操作数同样按
                    // "会不会和前缀负号连在一起"加括号(`-(-x)`,`-(a + b)`).
                    let needs_parentheses = match operand.as_ref() {
                        Expr::Unary(UnaryOp::Neg, _) => true,
                        Expr::Binary(op, _, _) => matches!(op, BinOp::Add | BinOp::Sub),
                        _ => false,
                    };
                    if needs_parentheses {
                        format!("-({body})")
                    } else {
                        format!("-{body}")
                    }
                }
            };
            parenthesize(&text, 60 < parent_prec)
        }
        Expr::Call(name, args) => {
            let separator = match mode {
                PrintMode::Text => ", ",
                PrintMode::Latex => ",\\ ",
            };
            let arg_texts: Vec<String> = args.iter().map(|arg| format_expr(arg, mode, 0)).collect();
            let body = arg_texts.join(separator);
            match mode {
                PrintMode::Text => format!("{name}({body})"),
                PrintMode::Latex => latex_call(name, args, &arg_texts),
            }
        }
        Expr::Binary(op, left, right) => {
            let prec = op.prec();
            let text = match op {
                BinOp::Add | BinOp::Sub => format!(
                    "{} {} {}",
                    binary_child(left, mode, *op, false),
                    op.text(),
                    binary_child(right, mode, *op, true),
                ),
                BinOp::Mul | BinOp::Div | BinOp::Pow => match mode {
                    PrintMode::Text => format!(
                        "{} {} {}",
                        binary_child(left, mode, *op, false),
                        op.text(),
                        binary_child(right, mode, *op, true),
                    ),
                    PrintMode::Latex => match op {
                        BinOp::Mul => latex_product(expr),
                        BinOp::Div => format!(
                            "\\frac{{{}}}{{{}}}",
                            format_expr(left, PrintMode::Latex, 0),
                            format_expr(right, PrintMode::Latex, 0),
                        ),
                        BinOp::Pow => format!(
                            "{}^{{{}}}",
                            latex_pow_base(left),
                            format_expr(right, PrintMode::Latex, 0),
                        ),
                        _ => unreachable!(),
                    },
                },
            };
            parenthesize(&text, prec < parent_prec)
        }
    }
}

impl Expr {
    fn to_string_with_prec(&self, parent_prec: u8) -> String {
        format_expr(self, PrintMode::Text, parent_prec)
    }
}

impl std::fmt::Display for Expr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_string_with_prec(0))
    }
}
