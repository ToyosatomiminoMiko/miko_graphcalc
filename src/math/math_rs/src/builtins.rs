use std::f64::consts::{E, PI};

use crate::symbolic::{BinOp, Expr, UnaryOp};

/// 当前 DSL 数值求值支持的内置函数.
///
/// 每个函数只在这里登记一次:求值,符号求导和 LaTeX 显示都从这一张表取.
/// 多参数/别名函数(pow,sec,log 等)在表达式归一化阶段改写为基础函数.
type UnaryMathFunction = fn(f64) -> f64;
type DerivativeFunction = fn(&Expr) -> Expr;

#[derive(Clone, Copy)]
pub(crate) enum LatexStyle {
    /// 普通函数名,例如 `\sin\left(...\right)`.
    Named(&'static str),
    /// 指数形式 `e^{...}`.
    Exp,
    /// 根号形式 `\sqrt{...}`.
    Sqrt,
    /// k 次根号形式 `\sqrt[k]{...}`.
    NthRoot(u8),
    /// 绝对值形式 `\left|...\right|`.
    Abs,
    /// 指定底数的对数,例如 `\log_{10}\left(...\right)`.
    LogBase(u8),
}

struct MathBuiltin {
    name: &'static str,
    /// 参数个数(元数).基础函数当前全为 1,但显式登记而不是默认 1:
    /// `validate_supported` 是唯一的元数校验入口(202609 审查 P2.1),
    /// 归一化/求导/LaTeX/求值四处不再各写一套检查.
    arity: u8,
    eval: UnaryMathFunction,
    derivative: DerivativeFunction,
    latex: LatexStyle,
}

fn num(value: f64) -> Expr {
    Expr::Num(value)
}

fn call(name: &str, args: Vec<Expr>) -> Expr {
    Expr::Call(name.to_string(), args)
}

fn bin(op: BinOp, left: Expr, right: Expr) -> Expr {
    Expr::Binary(op, Box::new(left), Box::new(right))
}

fn neg(expr: Expr) -> Expr {
    Expr::Unary(UnaryOp::Neg, Box::new(expr))
}

fn arg_sq(arg: &Expr) -> Expr {
    bin(BinOp::Pow, arg.clone(), num(2.0))
}

fn derivative_sin(arg: &Expr) -> Expr {
    call("cos", vec![arg.clone()])
}

fn derivative_cos(arg: &Expr) -> Expr {
    neg(call("sin", vec![arg.clone()]))
}

fn derivative_tan(arg: &Expr) -> Expr {
    bin(
        BinOp::Div,
        num(1.0),
        bin(BinOp::Pow, call("cos", vec![arg.clone()]), num(2.0)),
    )
}

fn inverse_sqrt_of_one_minus_square(arg: &Expr) -> Expr {
    bin(
        BinOp::Div,
        num(1.0),
        call("sqrt", vec![bin(BinOp::Sub, num(1.0), arg_sq(arg))]),
    )
}

fn derivative_asin(arg: &Expr) -> Expr {
    inverse_sqrt_of_one_minus_square(arg)
}

fn derivative_acos(arg: &Expr) -> Expr {
    neg(inverse_sqrt_of_one_minus_square(arg))
}

fn derivative_atan(arg: &Expr) -> Expr {
    bin(BinOp::Div, num(1.0), bin(BinOp::Add, arg_sq(arg), num(1.0)))
}

fn derivative_sinh(arg: &Expr) -> Expr {
    call("cosh", vec![arg.clone()])
}

fn derivative_cosh(arg: &Expr) -> Expr {
    call("sinh", vec![arg.clone()])
}

fn derivative_tanh(arg: &Expr) -> Expr {
    bin(
        BinOp::Div,
        num(1.0),
        bin(BinOp::Pow, call("cosh", vec![arg.clone()]), num(2.0)),
    )
}

fn derivative_exp(arg: &Expr) -> Expr {
    call("exp", vec![arg.clone()])
}

fn derivative_ln(arg: &Expr) -> Expr {
    bin(BinOp::Div, num(1.0), arg.clone())
}

fn derivative_log_base(arg: &Expr, base: f64) -> Expr {
    bin(
        BinOp::Div,
        num(1.0),
        bin(BinOp::Mul, arg.clone(), call("ln", vec![num(base)])),
    )
}

fn derivative_log10(arg: &Expr) -> Expr {
    derivative_log_base(arg, 10.0)
}

fn derivative_log2(arg: &Expr) -> Expr {
    derivative_log_base(arg, 2.0)
}

fn derivative_sqrt(arg: &Expr) -> Expr {
    bin(
        BinOp::Div,
        num(1.0),
        bin(BinOp::Mul, num(2.0), call("sqrt", vec![arg.clone()])),
    )
}

/// d/dx |x| 用显式的 sign 语义表达(而不是 `|x|/x` 的 0/0 写法):
/// 符号层输出 `sign(u)`,数值层在 u=0 处显式返回 NaN(该点导数不存在),
/// 不再依赖 IEEE 除法撞大运.离 0 处 sign(u) 与 |u|/u 完全一致.
fn derivative_abs(arg: &Expr) -> Expr {
    call("sign", vec![arg.clone()])
}

fn derivative_sign(_arg: &Expr) -> Expr {
    // sign 在 0 处不可导;离 0 处处处为常数,链式规则输出 0.
    num(0.0)
}

fn derivative_cbrt(arg: &Expr) -> Expr {
    bin(
        BinOp::Div,
        num(1.0),
        bin(
            BinOp::Mul,
            num(3.0),
            bin(BinOp::Pow, call("cbrt", vec![arg.clone()]), num(2.0)),
        ),
    )
}

const MATH_FUNCTIONS: &[MathBuiltin] = &[
    MathBuiltin {
        name: "sin",
        arity: 1,
        eval: f64::sin,
        derivative: derivative_sin,
        latex: LatexStyle::Named("\\sin"),
    },
    MathBuiltin {
        name: "cos",
        arity: 1,
        eval: f64::cos,
        derivative: derivative_cos,
        latex: LatexStyle::Named("\\cos"),
    },
    MathBuiltin {
        name: "tan",
        arity: 1,
        eval: f64::tan,
        derivative: derivative_tan,
        latex: LatexStyle::Named("\\tan"),
    },
    MathBuiltin {
        name: "asin",
        arity: 1,
        eval: f64::asin,
        derivative: derivative_asin,
        latex: LatexStyle::Named("\\arcsin"),
    },
    MathBuiltin {
        name: "acos",
        arity: 1,
        eval: f64::acos,
        derivative: derivative_acos,
        latex: LatexStyle::Named("\\arccos"),
    },
    MathBuiltin {
        name: "atan",
        arity: 1,
        eval: f64::atan,
        derivative: derivative_atan,
        latex: LatexStyle::Named("\\arctan"),
    },
    MathBuiltin {
        name: "sinh",
        arity: 1,
        eval: f64::sinh,
        derivative: derivative_sinh,
        latex: LatexStyle::Named("\\sinh"),
    },
    MathBuiltin {
        name: "cosh",
        arity: 1,
        eval: f64::cosh,
        derivative: derivative_cosh,
        latex: LatexStyle::Named("\\cosh"),
    },
    MathBuiltin {
        name: "tanh",
        arity: 1,
        eval: f64::tanh,
        derivative: derivative_tanh,
        latex: LatexStyle::Named("\\tanh"),
    },
    MathBuiltin {
        name: "exp",
        arity: 1,
        eval: f64::exp,
        derivative: derivative_exp,
        latex: LatexStyle::Exp,
    },
    MathBuiltin {
        name: "ln",
        arity: 1,
        eval: f64::ln,
        derivative: derivative_ln,
        latex: LatexStyle::Named("\\ln"),
    },
    MathBuiltin {
        name: "log10",
        arity: 1,
        eval: f64::log10,
        derivative: derivative_log10,
        latex: LatexStyle::LogBase(10),
    },
    MathBuiltin {
        name: "log2",
        arity: 1,
        eval: f64::log2,
        derivative: derivative_log2,
        latex: LatexStyle::LogBase(2),
    },
    MathBuiltin {
        name: "sqrt",
        arity: 1,
        eval: f64::sqrt,
        derivative: derivative_sqrt,
        latex: LatexStyle::Sqrt,
    },
    MathBuiltin {
        name: "cbrt",
        arity: 1,
        eval: f64::cbrt,
        derivative: derivative_cbrt,
        latex: LatexStyle::NthRoot(3),
    },
    MathBuiltin {
        name: "abs",
        arity: 1,
        eval: f64::abs,
        derivative: derivative_abs,
        latex: LatexStyle::Abs,
    },
    MathBuiltin {
        // sign(u) = u/|u|(u≠0);u=0 处显式 NaN(该点符号意义上的值未定义).
        // 符号求导(d|x|/dx 等)输出 sign 语义而不是 |u|/u 的 0/0 写法.
        name: "sign",
        arity: 1,
        eval: |value: f64| {
            if value > 0.0 {
                1.0
            } else if value < 0.0 {
                -1.0
            } else {
                f64::NAN
            }
        },
        derivative: derivative_sign,
        latex: LatexStyle::Named("\\operatorname{sgn}"),
    },
];

/// 返回基础函数的元数(参数个数);不是基础函数时返回 `None`.
///
/// 元数只在 `MATH_FUNCTIONS` 登记一处,由 `validate_supported` 统一校验;
/// 别名函数(pow/sec/log/deg...)的元数在 `ALIASES` 的展开函数里检查.
pub(crate) fn function_arity(name: &str) -> Option<u8> {
    MATH_FUNCTIONS
        .iter()
        .find(|builtin| builtin.name == name)
        .map(|builtin| builtin.arity)
}

/// 校验基础函数调用的元数;函数名或参数个数不对时返回可读错误.
///
/// 这是元数校验的单事实来源(202609 审查 P2.1):归一化,符号求导,LaTeX
/// 与数值求值都从这里取结论,不再各自写一套检查.
pub(crate) fn check_function_arity(name: &str, arg_count: usize) -> Result<(), String> {
    match function_arity(name) {
        Some(arity) if arity as usize == arg_count => Ok(()),
        Some(arity) => Err(format!(
            "函数 {name} 只接受 {arity} 个参数,当前收到 {arg_count} 个"
        )),
        None => Err(format!(
            "表达式暂不支持函数 {name},无法交给 Rust/WASM 数值求值"
        )),
    }
}

/// 应用一元内置函数;函数不存在时返回 `Err`.
pub(crate) fn apply_unary(name: &str, value: f64) -> Result<f64, String> {
    MATH_FUNCTIONS
        .iter()
        .find(|builtin| builtin.name == name)
        .map(|builtin| (builtin.eval)(value))
        .ok_or_else(|| format!("表达式暂不支持函数 {name}"))
}

/// 返回函数对应的 LaTeX 样式;不属于基础函数时返回 `None`.
pub(crate) fn latex_style(name: &str) -> Option<LatexStyle> {
    MATH_FUNCTIONS
        .iter()
        .find(|builtin| builtin.name == name)
        .map(|builtin| builtin.latex)
}

/// 返回 `f'(arg)`,由调用方再乘上链式法则中的 `darg`.
pub(crate) fn derivative_unary(name: &str) -> Option<DerivativeFunction> {
    MATH_FUNCTIONS
        .iter()
        .find(|builtin| builtin.name == name)
        .map(|builtin| builtin.derivative)
}

// ============================================================
// 常量与别名注册表
// ============================================================
//
// 基础一元函数在 `MATH_FUNCTIONS` 登记;这里把"常量符号"与"别名函数"
// 的名单也收口成表,符号引擎的折叠/求值/LaTeX/变量提取不再各自内联
// 一份 `pi`/`e`/`log`/`pow`/... 名单.

/// 已知符号常量(数值常量以及 `i`/`true`/`false`/`null` 等保留字).
struct ConstantBuiltin {
    name: &'static str,
    /// 数值求值时的取值;`None` 表示只作为保留字,不能参与数值求值.
    value: Option<f64>,
    /// LaTeX 展示;`None` 表示按普通符号渲染.
    latex: Option<&'static str>,
    /// 是否在表达式归一化阶段折叠为数值(`pi`/`PI`/`e`/`E`).
    fold: bool,
}

const CONSTANTS: &[ConstantBuiltin] = &[
    ConstantBuiltin {
        name: "pi",
        value: Some(PI),
        latex: Some("\\pi"),
        fold: true,
    },
    ConstantBuiltin {
        name: "PI",
        value: Some(PI),
        latex: Some("\\pi"),
        fold: true,
    },
    ConstantBuiltin {
        name: "e",
        value: Some(E),
        latex: Some("e"),
        fold: true,
    },
    ConstantBuiltin {
        name: "E",
        value: Some(E),
        latex: Some("e"),
        fold: true,
    },
    ConstantBuiltin {
        name: "Infinity",
        value: Some(f64::INFINITY),
        latex: Some("\\infty"),
        fold: false,
    },
    ConstantBuiltin {
        name: "NaN",
        value: Some(f64::NAN),
        latex: None,
        fold: false,
    },
    ConstantBuiltin {
        name: "i",
        value: None,
        latex: None,
        fold: false,
    },
    ConstantBuiltin {
        name: "true",
        value: None,
        latex: None,
        fold: false,
    },
    ConstantBuiltin {
        name: "false",
        value: None,
        latex: None,
        fold: false,
    },
    ConstantBuiltin {
        name: "null",
        value: None,
        latex: None,
        fold: false,
    },
];

fn find_constant(name: &str) -> Option<&'static ConstantBuiltin> {
    CONSTANTS.iter().find(|constant| constant.name == name)
}

/// 归一化阶段折叠为数值的常量(`pi`/`PI`/`e`/`E`).
pub(crate) fn foldable_constant_value(name: &str) -> Option<f64> {
    match find_constant(name) {
        Some(constant) if constant.fold => constant.value,
        _ => None,
    }
}

/// 数值求值时已知的常量(`pi`/`PI`/`e`/`E`/`Infinity`/`NaN`);
/// 纯保留字(`i`/`true`/`false`/`null`)返回 `None`,由调用方按变量处理.
pub(crate) fn constant_value(name: &str) -> Option<f64> {
    find_constant(name).and_then(|constant| constant.value)
}

/// 纯保留字:在常量表里但没有数值(`i`/`true`/`false`/`null`).
///
/// 与 [`constant_value`] 互补,两者一起覆盖整张常量表;调用方用它们判断
/// "这个名字是不是已被表吸收",而不是"求值时能不能算出来".
pub(crate) fn is_reserved_word(name: &str) -> bool {
    find_constant(name).is_some_and(|constant| constant.value.is_none())
}

/// 常量在 LaTeX 里的展示;不是展示型常量时返回 `None`.
pub(crate) fn constant_latex(name: &str) -> Option<&'static str> {
    find_constant(name).and_then(|constant| constant.latex)
}

/// 别名函数在 LaTeX 输出中的展示形态(此时 `Call` 节点仍带别名名字,
/// 展示规则无法从展开后的基础函数派生,因此单独登记).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum AliasLatexKind {
    /// `pow(a, b)` -> `a^{b}`.
    SuperscriptPower,
    /// `deg(x)` -> `x^{\circ}`.
    Degree,
    /// `log(x)` -> `\ln(x)`.
    NaturalLog,
}

type AliasExpansion = fn(&[Expr]) -> Result<Expr, String>;

struct AliasBuiltin {
    name: &'static str,
    expand: AliasExpansion,
    latex: Option<AliasLatexKind>,
}

fn expand_log(args: &[Expr]) -> Result<Expr, String> {
    if args.len() != 1 {
        return Err("Rust 数值后端只支持单参数的自然对数 log(x)".to_string());
    }
    Ok(call("ln", args.to_vec()))
}

fn expand_pow(args: &[Expr]) -> Result<Expr, String> {
    if args.len() != 2 {
        return Err("Rust 数值后端只支持双参数的 pow(a, b)".to_string());
    }
    Ok(bin(BinOp::Pow, args[0].clone(), args[1].clone()))
}

fn expand_inverse(alias: &str, base: &str, args: &[Expr]) -> Result<Expr, String> {
    if args.len() != 1 {
        return Err(format!("{alias} 只接受一个参数"));
    }
    Ok(bin(BinOp::Div, num(1.0), call(base, args.to_vec())))
}

fn expand_sec(args: &[Expr]) -> Result<Expr, String> {
    expand_inverse("sec", "cos", args)
}

fn expand_csc(args: &[Expr]) -> Result<Expr, String> {
    expand_inverse("csc", "sin", args)
}

fn expand_cot(args: &[Expr]) -> Result<Expr, String> {
    if args.len() != 1 {
        return Err("cot 只接受一个参数".to_string());
    }
    Ok(bin(
        BinOp::Div,
        call("cos", args.to_vec()),
        call("sin", args.to_vec()),
    ))
}

fn expand_deg(args: &[Expr]) -> Result<Expr, String> {
    if args.len() != 1 {
        return Err("deg 只接受一个参数".to_string());
    }
    Ok(bin(BinOp::Mul, args[0].clone(), num(PI / 180.0)))
}

const ALIASES: &[AliasBuiltin] = &[
    AliasBuiltin {
        name: "log",
        expand: expand_log,
        latex: Some(AliasLatexKind::NaturalLog),
    },
    AliasBuiltin {
        name: "pow",
        expand: expand_pow,
        latex: Some(AliasLatexKind::SuperscriptPower),
    },
    AliasBuiltin {
        name: "sec",
        expand: expand_sec,
        latex: None,
    },
    AliasBuiltin {
        name: "csc",
        expand: expand_csc,
        latex: None,
    },
    AliasBuiltin {
        name: "cot",
        expand: expand_cot,
        latex: None,
    },
    AliasBuiltin {
        name: "deg",
        expand: expand_deg,
        latex: Some(AliasLatexKind::Degree),
    },
];

fn find_alias(name: &str) -> Option<&'static AliasBuiltin> {
    ALIASES.iter().find(|alias| alias.name == name)
}

/// 展开别名;`None` 表示该名字不是别名,调用方保持原样.
pub(crate) fn alias_expansion(name: &str, args: &[Expr]) -> Option<Result<Expr, String>> {
    find_alias(name).map(|alias| (alias.expand)(args))
}

pub(crate) fn alias_latex_kind(name: &str) -> Option<AliasLatexKind> {
    find_alias(name).and_then(|alias| alias.latex)
}
