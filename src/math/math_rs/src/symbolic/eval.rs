//! 运行时数值求值:把编译后的 `Expr` 树按变量上下文逐点解释;
//! 负底数 + 有理指数的实值幂(`real_pow`)也在这里统一实现.
//!
//! 编码注意:
//! - **元数不在本文件校验**:`compile_runtime_expr` 的 `validate_supported`
//!   已经保证每个 `Call` 的元数正确(`builtins::check_function_arity`,
//!   单事实来源,202609 审查 SYM-P2.1),解释器按一元函数直接取 `values[0]`;
//! - 非有限结果返回 `Ok(None)`(掩码语义),不是 `Err`;见 `eval_core.rs`
//!   文件头契约.

/// 只被测试里的查表版参考实现使用(见 `evaluate_runtime_expr`).
#[cfg(test)]
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

/// 符号求值错误(202609 审查 P3-2 去重后的单一错误类型).
///
/// 常量折叠(`simplify::evaluate_constant`)与运行时求值(`evaluate_runtime_expr`)
/// 共用同一个求值内核,两者对错误的**文案**不同(一个说"矩阵条目包含...",
/// 一个说"变量 '{}' 未定义"),所以内核返回结构化的错误,由各自入口映射成文案.
pub(crate) enum EvalError {
    /// 名字既不是内置常量也没有被绑定.
    UnboundSymbol(String),
    /// 函数名/元数不受支持.
    UnsupportedCall(String),
    /// 冒号/数组形态不能求值.
    ListNotEvaluable,
}

/// 求值内核:常量折叠与运行时求值共用(只差"符号怎么解析").
///
/// `lookup` 负责把非内置常量的 `Sym` 解析成数值;返回 `None` 表示该名字未绑定.
/// 只构造一次 `args` 数组之外不做任何分配(单参函数不建 `Vec`).
pub(crate) fn evaluate_with_lookup(
    expr: &Expr,
    lookup: &dyn Fn(&str) -> Option<f64>,
) -> Result<Option<f64>, EvalError> {
    match expr {
        Expr::Num(value) => Ok(finite_value(*value)),
        Expr::Sym(name) => {
            // 数值常量名单收口在 builtins;其余名字按调用方的绑定解析.
            let value = match builtins::constant_value(name) {
                Some(value) => value,
                None => lookup(name).ok_or_else(|| EvalError::UnboundSymbol(name.clone()))?,
            };
            Ok(finite_value(value))
        }
        Expr::Unary(UnaryOp::Neg, operand) => {
            Ok(evaluate_with_lookup(operand, lookup)?.map(|value| -value))
        }
        Expr::Binary(op, left, right) => {
            let left = evaluate_with_lookup(left, lookup)?;
            let right = evaluate_with_lookup(right, lookup)?;
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
            // 元数由 `compile_runtime_expr -> validate_supported` 保证为 1
            // (单事实来源,202609 审查 SYM-P2.1);但常量折叠路径可能拿到未走
            // 校验的树,所以这里仍按"恰好一个参数"校验而不是直接索引.
            let [arg] = args.as_slice() else {
                return Err(EvalError::UnsupportedCall(name.clone()));
            };
            let Some(value) = evaluate_with_lookup(arg, lookup)? else {
                return Ok(None);
            };
            builtins::apply_unary(name, value)
                .map(finite_value)
                .map_err(|_| EvalError::UnsupportedCall(name.clone()))
        }
        Expr::List(_) => Err(EvalError::ListNotEvaluable),
    }
}

// ============================================================
// 预绑定求值(202609 性能改造 P0)
// ============================================================
//
// 背景:`evaluate_with_lookup` 每个点都要按**名字**查一次上下文,而
// `CompiledEvaluator` 旧实现更是每点 `ctx.insert(name.to_string(), value)`
// --一次堆分配 + 一次字符串哈希.实测 context 记账占求值成本的 94-99%
// (见 prompt/refactor-and-rust-migration.md §7.3).
//
// 这里在**构造期**把符号解析成槽位([`SymBinding`]),求值期只剩数组下标与
// 一次匹配:零字符串,零哈希,零分配.语义必须与查表版逐点一致,
// 由 `eval_core.rs` 的 `bound_and_lookup_paths_agree_pointwise` 对拍守住.

/// 符号在求值期的取值来源(构造期解析一次).
#[derive(Debug, Clone)]
pub(crate) enum SymBinding {
    /// 采样坐标槽:x=0,y=1,z=2.`x` 在所有维度都被覆写,所以永远是坐标.
    Coord(u8),
    /// 系数槽:`coefficients[index]`.
    Coefficient(usize),
    /// `y`/`z` 且存在同名系数:当前求值维度覆写了该坐标就取坐标,否则取系数.
    ///
    /// 这是历史语义的精确表达(见 `eval_core.rs` 文件头契约):`y`/`z` 在
    /// 1D(interval/curve)与 2D 语境可以是合法参数名,只有被 eval_2d/eval_at
    /// 覆写时才冲突.用运行期维度位判断,而不是在构造期猜维度--同一个
    /// evaluator 先 eval_at 再 eval_1d 的旧行为也能逐点复现.
    CoordOrCoefficient(u8, usize),
    /// `y`/`z` 且没有同名系数:对应维度覆写了该坐标就是坐标,否则报未定义.
    CoordOrUnbound(u8, String),
    /// 内置常量(优先于变量,与 `evaluate_with_lookup` 的判定顺序一致).
    Constant(f64),
    /// 未绑定符号;保留原名以复现 `变量 '{}' 未定义` 文案.
    Unbound(String),
}

/// 已把符号解析成槽位的求值树(与 [`Expr`] 同形,但热点路径无名字查找).
#[derive(Debug)]
pub(crate) enum BoundExpr {
    Num(f64),
    Sym(SymBinding),
    Neg(Box<BoundExpr>),
    Binary(BinOp, Box<BoundExpr>, Box<BoundExpr>),
    /// 一元函数:函数指针在构造期解析(见 `builtins::unary_eval`).
    Call(builtins::UnaryMathFunction, Box<BoundExpr>),
    /// 函数未登记(或元数不是 1);求值时按旧文案报错.
    UnsupportedCall(String),
    /// 数组表达式不可直接求值.
    ListNotEvaluable,
}

/// 预绑定求值上下文:坐标 + 系数,全部按槽位访问.
#[derive(Debug, Clone)]
pub(crate) struct EvalContext {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) z: f64,
    /// 本次求值覆写的坐标个数:1 -> 只有 x;2 -> x,y;3 -> x,y,z.
    /// 只被 [`SymBinding::CoordOrCoefficient`] / [`SymBinding::CoordOrUnbound`] 读.
    pub(crate) dim: u8,
    pub(crate) coefficients: Vec<f64>,
}

impl EvalContext {
    fn coordinate(&self, slot: u8) -> f64 {
        match slot {
            0 => self.x,
            1 => self.y,
            _ => self.z,
        }
    }
}

/// 把已编译表达式绑定成槽位树.
///
/// `coefficient_names` 必须与 `EvalContext::coefficients` 一一对应(截断到
/// 两者的公共长度,与旧实现 `coeff_names.iter().zip(coeff_values.iter())`
/// 的口径一致).同名系数以**最后一个**为准(旧 `HashMap::insert` 覆盖).
pub(crate) fn bind_expression(expr: &Expr, coefficient_names: &[String]) -> BoundExpr {
    match expr {
        Expr::Num(value) => BoundExpr::Num(*value),
        Expr::Sym(name) => BoundExpr::Sym(bind_symbol(name, coefficient_names)),
        Expr::Unary(UnaryOp::Neg, operand) => {
            BoundExpr::Neg(Box::new(bind_expression(operand, coefficient_names)))
        }
        Expr::Binary(op, left, right) => BoundExpr::Binary(
            *op,
            Box::new(bind_expression(left, coefficient_names)),
            Box::new(bind_expression(right, coefficient_names)),
        ),
        Expr::Call(name, args) => match args.as_slice() {
            [arg] => match builtins::unary_eval(name) {
                Some(function) => {
                    BoundExpr::Call(function, Box::new(bind_expression(arg, coefficient_names)))
                }
                None => BoundExpr::UnsupportedCall(name.clone()),
            },
            _ => BoundExpr::UnsupportedCall(name.clone()),
        },
        Expr::List(_) => BoundExpr::ListNotEvaluable,
    }
}

fn bind_symbol(name: &str, coefficient_names: &[String]) -> SymBinding {
    // 顺序与 evaluate_with_lookup 一致:内置常量优先于变量.
    if let Some(value) = builtins::constant_value(name) {
        return SymBinding::Constant(value);
    }
    // rposition:同名系数以最后一个为准(旧 HashMap::insert 覆盖语义).
    let coefficient = coefficient_names
        .iter()
        .rposition(|candidate| candidate == name);
    match name {
        "x" => SymBinding::Coord(0),
        "y" => match coefficient {
            Some(index) => SymBinding::CoordOrCoefficient(1, index),
            None => SymBinding::CoordOrUnbound(1, name.to_string()),
        },
        "z" => match coefficient {
            Some(index) => SymBinding::CoordOrCoefficient(2, index),
            None => SymBinding::CoordOrUnbound(2, name.to_string()),
        },
        _ => match coefficient {
            Some(index) => SymBinding::Coefficient(index),
            None => SymBinding::Unbound(name.to_string()),
        },
    }
}

/// 对预绑定树求值;语义(含错误文案)与查表版逐点一致.
pub(crate) fn evaluate_bound(expr: &BoundExpr, ctx: &EvalContext) -> Result<Option<f64>, String> {
    match expr {
        BoundExpr::Num(value) => Ok(finite_value(*value)),
        BoundExpr::Sym(binding) => match binding {
            SymBinding::Constant(value) => Ok(finite_value(*value)),
            SymBinding::Coord(slot) => Ok(finite_value(ctx.coordinate(*slot))),
            SymBinding::Coefficient(index) => Ok(finite_value(ctx.coefficients[*index])),
            SymBinding::CoordOrCoefficient(slot, index) => {
                let value = if *slot < ctx.dim {
                    ctx.coordinate(*slot)
                } else {
                    ctx.coefficients[*index]
                };
                Ok(finite_value(value))
            }
            SymBinding::CoordOrUnbound(slot, name) => {
                if *slot < ctx.dim {
                    Ok(finite_value(ctx.coordinate(*slot)))
                } else {
                    Err(format!("变量 '{name}' 未定义"))
                }
            }
            SymBinding::Unbound(name) => Err(format!("变量 '{name}' 未定义")),
        },
        BoundExpr::Neg(operand) => Ok(evaluate_bound(operand, ctx)?.map(|value| -value)),
        BoundExpr::Binary(op, left, right) => {
            let left = evaluate_bound(left, ctx)?;
            let right = evaluate_bound(right, ctx)?;
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
        BoundExpr::Call(function, arg) => {
            let Some(value) = evaluate_bound(arg, ctx)? else {
                return Ok(None);
            };
            Ok(finite_value(function(value)))
        }
        BoundExpr::UnsupportedCall(name) => {
            Err(format!("函数 {name} 只接受 1 个参数,当前收到 0 个"))
        }
        BoundExpr::ListNotEvaluable => Err("不能直接对数组表达式求值".to_string()),
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

/// 运行时求值错误文案(常量折叠路径见 `simplify::evaluate_constant`).
///
/// 只服务于查表版参考实现;生产路径改用预绑定求值,错误文案内联在
/// [`evaluate_bound`] 里(两者由对拍测试守住一致).
#[cfg(test)]
fn runtime_error(error: EvalError) -> String {
    match error {
        EvalError::UnboundSymbol(name) => format!("变量 '{name}' 未定义"),
        EvalError::UnsupportedCall(name) => {
            format!("函数 {name} 只接受 1 个参数,当前收到 0 个")
        }
        EvalError::ListNotEvaluable => "不能直接对数组表达式求值".to_string(),
    }
}

/// 查表版运行时求值(旧实现),现在只作为预绑定路径的**测试参照物**.
///
/// 生产求值统一走 [`bind_expression`] + [`evaluate_bound`];这个函数保留下来
/// 是为了 `eval_core.rs` 的逐点对拍(旧->新语义等价的唯一证明方式),不再有
/// 非测试调用方.
#[cfg(test)]
pub(crate) fn evaluate_runtime_expr(
    expr: &RuntimeExpr,
    variables: &HashMap<String, f64>,
) -> Result<Option<f64>, String> {
    evaluate_with_lookup(expr, &|name| variables.get(name).copied()).map_err(runtime_error)
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
