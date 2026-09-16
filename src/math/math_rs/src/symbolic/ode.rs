//! 微分方程求解内核(设计文档 `docs/plan3.md` 第 1.2 节).
//!
//! 产物是**独立类型** [`OdeOutcome`] / [`OdeStep`]:只有字符串与计数,不含
//! `Expr`(符号引擎内部表示不越过这一层,路线图 §7.1 的口径与 `solve.rs` /
//! `integral.rs` 一致).
//!
//! 支持清单(v1,**刻意保守**,不在清单内明确报能力边界):
//! - 一阶:可分离 / 一阶线性(含积分因子)/ Bernoulli / 齐次 / 恰当;
//! - 二阶:常系数齐次(实根 / 重根 / 共轭复根三型);
//! - 初值:`y(x0)=y0`(一阶),`y(x0)=y0` 与 `y'(x0)=v0`(二阶).
//!
//! 三条铁律(与一期同源):
//! 1. **导数记号归一必须字符扫描**:`y'' -> ypp` 不能用 `str::replace`,否则
//!    `a*y'` 会被读成 `a*yp` 之外的形状,`y_1'` 会被吃掉下标(见
//!    [`normalize_derivative_notation`]);
//! 2. **结果一律回代验证**:显式解对自变量求导代回原方程;隐式解走"隐函数
//!    求全导"(`Φ_x + Φ_y·f = 0`)抽样对拍.不过就走 `error` 通道,
//!    **绝不放行未验证的解**;
//! 3. **能力边界是结果的一部分**(`error: Some`),不是调用失败;`Err` 只留给
//!    "方程读不出来 / 初值写错 / 含未声明符号"这类真正的输入错误.
//!
//! 参数口径与二期一致:调用方只传**参数名**(可以不带值),内核把参数当符号
//! 常数留在结果里(`y = C·e^{p x}`),数值由 TS 物化层按当前滑块折叠.
//! 唯一的例外是二阶常系数的特征根判定:它需要 a/b/c 的数值,符号系数走
//! `error` 通道而不是猜.

use std::collections::HashMap;

use serde::Serialize;

use super::derivative::derivative;
use super::eval::evaluate_with_lookup;
use super::integral::antiderivative_with_parameters;
use super::parser::{parse_expr, rewrite_aliases, validate_supported};
use super::poly::integer_sqrt;
use super::printing::{format_expr, PrintMode};
use super::simplify::{evaluate_constant, simplify};
use super::{BinOp, Expr, UnaryOp};

/// 依据分区:法则.
const KIND_RULE: &str = "rule";
/// 依据分区:代数化简.
const KIND_ALGEBRA: &str = "algebra";
/// 依据分区:定义式.
const KIND_DEFINITION: &str = "definition";
/// 依据分区:公式表(积分).
const KIND_TABLE: &str = "table";
/// 依据分区:换元.
const KIND_SUBSTITUTE: &str = "substitute";
/// 依据分区:回代验证.
const KIND_CHECK: &str = "check";
/// 依据分区:数值(判别式等).
const KIND_NUMERIC: &str = "numeric";

/// 判别"重根"的容差.
const EPSILON: f64 = 1e-9;
/// 抽样验证时未绑定符号(参数/积分常数)的取值;避开 0/1.
const VERIFY_PARAM_VALUE: f64 = 1.25;
/// 抽样点(自变量取值);避开 0 与整数,减少掩盖错误的巧合.
const VERIFY_SAMPLES: [f64; 5] = [0.37, 1.13, -0.61, 2.29, -1.73];
/// 隐式解对拍时因变量的抽样取值.
const VERIFY_DEPENDENT_SAMPLES: [f64; 2] = [0.4, 1.7];
/// 数值对拍的相对容差.
const VERIFY_TOLERANCE: f64 = 1e-7;

/// 一步求解过程:一行 LaTeX + 依据文案 + 依据分区.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OdeStep {
    pub latex: String,
    pub reason: String,
    pub kind: String,
}

/// 一条微分方程的求解结果.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OdeOutcome {
    /// 题目(原方程 LaTeX,保留用户写法;导数记号排成 `y'`/`y''`).
    ///
    /// 能力边界错误也照给:方程已经解析成功,题目就该排成公式.
    pub equation_latex: String,
    /// 自变量名(`x`/`t`).
    pub independent: String,
    /// 因变量名(`y`).
    pub dependent: String,
    /// 方程阶数;`error !== None` 时为 0.
    pub order: usize,
    /// 通解 LaTeX;能力边界时为 `None`.
    pub general_latex: Option<String>,
    /// 特解 LaTeX(写了初值时);无初值或定不出常数时为 `None`.
    pub particular_latex: Option<String>,
    /// 通解表达式(归一化字符串,可直接求值;含常数符号 `C`/`C_1`).
    ///
    /// **隐式解时为空串**:隐式解没法直接当 `y=f(x)` 求值,由 TS 展示层按
    /// `implicit` 标注.下发解曲线时 TS 侧把常数符号替换成具体取值.
    pub general_text: String,
    /// 特解表达式;没有特解时为空串.
    pub particular_text: String,
    /// 通解是不是隐式形式(`Φ(x,y)=C`).
    pub implicit: bool,
    /// 任意常数个数(= 阶数;能力边界时为 0).
    pub arbitrary_constants: usize,
    /// 常数符号(`["C"]` / `["C_1","C_2"]`),供 TS 侧按取值替换.
    pub constant_symbols: Vec<String>,
    /// 斜率场表达式 `f(x,y)`(一阶方程右端;`y' = f(x,y)`);二阶/失败时为空串.
    ///
    /// 设计文档 P1-A:复用 `surface z = f(x,y)` 下发斜率场,不新增渲染器,
    /// 所以内核要把右端单独给出来(它不是通解,通解里没有它).
    pub slope_text: String,
    /// 斜率场 LaTeX(`f(x,y)`).
    pub slope_latex: String,
    /// 解是否通过回代验证.
    pub verified: bool,
    pub steps: Vec<OdeStep>,
    /// 能力边界理由(超出清单/符号系数/未验证);`None` 表示成功.
    pub error: Option<String>,
    /// 如实说明的补充信息(隐式解未显式化 / 未能定出常数 / 符号系数等).
    pub notes: Vec<String>,
}

fn step(latex: impl Into<String>, reason: &str, kind: &str) -> OdeStep {
    OdeStep {
        latex: latex.into(),
        reason: reason.to_string(),
        kind: kind.to_string(),
    }
}

// ============================================================
// 表达式小工具(与 integral.rs 同形:内核内部各自一份,不跨界共用)
// ============================================================

fn num(value: f64) -> Expr {
    Expr::Num(value)
}

fn sym(name: &str) -> Expr {
    Expr::Sym(name.to_string())
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

fn add(left: Expr, right: Expr) -> Expr {
    bin(BinOp::Add, left, right)
}

fn sub(left: Expr, right: Expr) -> Expr {
    bin(BinOp::Sub, left, right)
}

fn mul(left: Expr, right: Expr) -> Expr {
    bin(BinOp::Mul, left, right)
}

fn div(left: Expr, right: Expr) -> Expr {
    bin(BinOp::Div, left, right)
}

fn pow(base: Expr, exponent: Expr) -> Expr {
    bin(BinOp::Pow, base, exponent)
}

fn exp(expr: Expr) -> Expr {
    call("exp", vec![expr])
}

/// 子树里是否出现某个符号.
fn contains(expr: &Expr, name: &str) -> bool {
    match expr {
        Expr::Num(_) => false,
        Expr::Sym(symbol) => symbol == name,
        Expr::Unary(_, operand) => contains(operand, name),
        Expr::Binary(_, left, right) => contains(left, name) || contains(right, name),
        Expr::Call(_, args) => args.iter().any(|arg| contains(arg, name)),
        Expr::List(items) => items.iter().any(|item| contains(item, name)),
    }
}

/// 把符号 `name` 替换成表达式 `replacement`(只替换,不求值).
fn substitute_symbol(expr: &Expr, name: &str, replacement: &Expr) -> Expr {
    match expr {
        Expr::Sym(symbol) if symbol == name => replacement.clone(),
        Expr::Num(_) | Expr::Sym(_) => expr.clone(),
        Expr::Unary(op, operand) => {
            Expr::Unary(*op, Box::new(substitute_symbol(operand, name, replacement)))
        }
        Expr::Binary(op, left, right) => Expr::Binary(
            *op,
            Box::new(substitute_symbol(left, name, replacement)),
            Box::new(substitute_symbol(right, name, replacement)),
        ),
        Expr::Call(call_name, args) => Expr::Call(
            call_name.clone(),
            args.iter()
                .map(|arg| substitute_symbol(arg, name, replacement))
                .collect(),
        ),
        Expr::List(items) => Expr::List(
            items
                .iter()
                .map(|item| substitute_symbol(item, name, replacement))
                .collect(),
        ),
    }
}

/// 多项代入 + 化简.
fn substitute_many(expr: &Expr, substitutions: &[(&str, f64)]) -> Expr {
    let mut result = expr.clone();
    for (name, value) in substitutions {
        result = substitute_symbol(&result, name, &num(*value));
    }
    simplify(result)
}

/// 化简后是否是**字面量零**(结构判定,不算可靠恒等).
fn is_zero(expr: &Expr) -> bool {
    let simplified = simplify(expr.clone());
    match &simplified {
        Expr::Num(value) => *value == 0.0,
        _ => matches!(evaluate_constant(&simplified), Ok(Some(value)) if value == 0.0),
    }
}

/// 抽样验证表达式是否**恒为零函数**.
///
/// 为什么不能只靠 `simplify` 后判 0:`simplify` 不做多项式正规化,
/// `(1 - x*y) - (-(x*y))` 不会收成 `1`,`(1 - x*y + x*y)` 也不会收成 `1`.
/// 所以"两边相减再看是不是 0"这类恒等判定一律走数值对拍(路径与回代验证同源).
fn is_identically_zero(expr: &Expr) -> bool {
    let terms = flatten_sum(expr);
    if terms.is_empty() {
        return true;
    }
    let mut names = symbols_of(expr);
    names.sort();
    names.dedup();
    let mut compared = 0usize;
    for round in 0..3usize {
        let bindings: Vec<(String, f64)> = names
            .iter()
            .enumerate()
            .map(|(index, name)| (name.clone(), sample_value(index, round)))
            .collect();
        let extra: Vec<(&str, f64)> = bindings
            .iter()
            .map(|(name, value)| (name.as_str(), *value))
            .collect();
        let mut total = 0.0f64;
        let mut scale = 1.0f64;
        let mut usable = true;
        for (sign, term) in &terms {
            match eval_bound(term, &extra) {
                Some(value) => {
                    total += sign * value;
                    scale = scale.max(value.abs());
                }
                None => {
                    usable = false;
                    break;
                }
            }
        }
        if !usable {
            continue;
        }
        compared += 1;
        if total.abs() > VERIFY_TOLERANCE * scale {
            return false;
        }
    }
    for name in &names {
        let _ = name;
    }
    compared > 0
}

/// 恒等判定:`simplify` 的结构零优先,再退到抽样对拍.
fn is_zero_function(expr: &Expr) -> bool {
    is_zero(expr) || is_identically_zero(expr)
}

/// 抽样验证表达式是否与某个符号**无关**.
///
/// `simplify` 不做同类项合并,`N - ∂_y∫M dx` 这类表达式里会残留写法上的
/// 依赖(`x^2 + y - x^2`),靠结构判定会把恰当方程误判成"算不动".
fn is_independent_of(expr: &Expr, name: &str) -> bool {
    let mut names = symbols_of(expr);
    names.retain(|symbol| symbol != name);
    names.sort();
    names.dedup();
    if names.iter().any(|symbol| symbol == name) {
        return false;
    }
    let mut compared = 0usize;
    for round in 0..3usize {
        let bindings: Vec<(String, f64)> = names
            .iter()
            .enumerate()
            .map(|(index, symbol)| (symbol.clone(), sample_value(index, round)))
            .collect();
        let mut probes = Vec::new();
        for step in 0..2usize {
            let mut extra: Vec<(&str, f64)> = bindings
                .iter()
                .map(|(symbol, value)| (symbol.as_str(), *value))
                .collect();
            extra.push((name, 0.83 + 0.71 * step as f64));
            match eval_bound(expr, &extra) {
                Some(value) => probes.push(value),
                None => {
                    probes.clear();
                    break;
                }
            }
        }
        if probes.len() != 2 {
            continue;
        }
        compared += 1;
        let scale = probes[0].abs().max(probes[1].abs()).max(1.0);
        if (probes[0] - probes[1]).abs() > VERIFY_TOLERANCE * scale {
            return false;
        }
    }
    compared > 0
}

/// 丢掉数值上恒为零的加法项.
///
/// 积分器会留下 `0*0*ln|y|` 这种残项(`simplify` 的 `0 * f -> 0` 只在另一侧
/// 可证有限时才折叠,`ln|y|` 不在其列),不清理就会挡住后面的"一次式/幂次"
/// 判定(实测踩过:`y' = 2*x*y^2` 因此解不出显式解).
fn drop_zero_terms(expr: &Expr) -> Expr {
    let kept: Vec<Expr> = flatten_sum(expr)
        .into_iter()
        .filter(|(_, term)| !is_identically_zero(term))
        .map(|(sign, term)| if sign < 0.0 { neg(term) } else { term })
        .collect();
    simplify(kept.into_iter().fold(num(0.0), add))
}

/// 抵消数值上恒等的对项:`x^2 + y - x^2` -> `y`.
///
/// 恰当方程求势函数时会出现这种"写法上还有 x,数值上已经抵消"的项,
/// 不化简就会把 `x^2*y + y^2/2 - x^2*y` 直接排进公式,学生读不懂.
fn cancel_like_terms(expr: &Expr) -> Expr {
    let mut kept: Vec<Expr> = Vec::new();
    for (sign, term) in flatten_sum(expr) {
        let candidate = if sign < 0.0 { neg(term) } else { term };
        let mut cancelled = false;
        let mut index = 0;
        while index < kept.len() {
            let merged = simplify(add(kept[index].clone(), candidate.clone()));
            if is_identically_zero(&merged) {
                kept.remove(index);
                cancelled = true;
                break;
            }
            index += 1;
        }
        if !cancelled {
            kept.push(candidate);
        }
    }
    simplify(kept.into_iter().fold(num(0.0), add))
}

/// 把和差通分成**单一分式**(只为喂给积分器的有理函数路径).
///
/// 积分器的有理函数/部分分式分支要求被积函数是一整个分式;
/// `(1 + u^2)/u - u` 这种"差里带分式"的形状它读不出来(实测踩过).
/// 通分后先抵消数值上恒等的对项,再用抽样对拍确认与原式等价;不等价就
/// 原样退回,绝不把改错语义的式子喂给积分器.
fn combine_fraction(expr: &Expr) -> Expr {
    let terms = flatten_sum(expr);
    if terms.len() < 2 {
        return expr.clone();
    }
    let parts: Vec<(f64, Expr, Expr)> = terms
        .iter()
        .map(|(sign, term)| match term {
            Expr::Binary(BinOp::Div, numerator, denominator) => (
                *sign,
                numerator.as_ref().clone(),
                denominator.as_ref().clone(),
            ),
            other => (*sign, other.clone(), num(1.0)),
        })
        .collect();
    let mut denominator = num(1.0);
    for (_, _, part_denominator) in &parts {
        denominator = mul(denominator, part_denominator.clone());
    }
    let mut numerator = num(0.0);
    for (index, (sign, part_numerator, _)) in parts.iter().enumerate() {
        let mut scale = num(1.0);
        for (other_index, (_, _, other_denominator)) in parts.iter().enumerate() {
            if other_index != index {
                scale = mul(scale, other_denominator.clone());
            }
        }
        let term = mul(part_numerator.clone(), scale);
        numerator = if *sign < 0.0 {
            sub(numerator, term)
        } else {
            add(numerator, term)
        };
    }
    // 先化简再抵消:`(1 + u^2) * 1` 这类系数 1 的乘积会把加法项藏在乘积里,
    // 直接抵消看不到它们.
    let numerator = simplify(numerator);
    let combined = simplify(div(cancel_like_terms(&numerator), simplify(denominator)));
    if is_identically_zero(&sub(expr.clone(), combined.clone())) {
        combined
    } else {
        expr.clone()
    }
}

/// 剥掉最外层的 `|·|`(实数域语境下积分器给的是 `ln|y|`).
fn strip_abs(expr: &Expr) -> Expr {
    match expr {
        Expr::Call(name, args) if name == "abs" && args.len() == 1 => args[0].clone(),
        other => other.clone(),
    }
}

/// 乘积因子摊平(`a * (b * c)` -> `[a, b, c]`).
fn collect_mul_factors<'a>(expr: &'a Expr, out: &mut Vec<&'a Expr>) {
    match expr {
        Expr::Binary(BinOp::Mul, left, right) => {
            collect_mul_factors(left, out);
            collect_mul_factors(right, out);
        }
        other => out.push(other),
    }
}

/// `exp(ln u) -> u`,`exp(k·ln u) -> u^k`(递归).
///
/// 积分因子常常长成 `e^{∫p dx}`,而 `∫p dx` 在有 `1/x` 时会给出 `ln|x|`;
/// 不折叠的话下游会拿到 `e^{ln|x|}` 这种积分器读不懂的形状(实测踩过:
/// `y' = y/x + x*y^2` 的伯努利解法).系数要摊平乘积再找(`-1 * (-1 * ln|x|)`
/// 是嵌套乘法,不摊平就找不到那个 `ln`).
fn fold_exp_ln(expr: &Expr) -> Expr {
    match expr {
        Expr::Call(name, args) if name == "exp" && args.len() == 1 => {
            let folded = fold_exp_ln(&args[0]);
            // 前导负号当 -1 因子:`-(-1 * ln|x|)` 是 `Unary(Neg, Mul(...))`,
            // 不摊平就找不到里面那个 `ln`.
            let inner = match &folded {
                Expr::Unary(UnaryOp::Neg, operand) => mul(num(-1.0), operand.as_ref().clone()),
                other => other.clone(),
            };
            if let Expr::Call(inner_name, inner_args) = &inner {
                if inner_name == "ln" && inner_args.len() == 1 {
                    return strip_abs(&inner_args[0]);
                }
            }
            let mut factors = Vec::new();
            collect_mul_factors(&inner, &mut factors);
            let log_index = factors.iter().position(
                |factor| matches!(factor, Expr::Call(factor_name, factor_args) if factor_name == "ln" && factor_args.len() == 1),
            );
            match log_index {
                Some(index) => {
                    let mut coefficient = num(1.0);
                    for (position, factor) in factors.iter().enumerate() {
                        if position != index {
                            coefficient = mul(coefficient, (*factor).clone());
                        }
                    }
                    if let Expr::Call(_, log_args) = factors[index] {
                        return simplify(pow(strip_abs(&log_args[0]), simplify(coefficient)));
                    }
                    Expr::Call(name.clone(), vec![folded])
                }
                None => Expr::Call(name.clone(), vec![folded]),
            }
        }
        Expr::Call(name, args) => Expr::Call(name.clone(), args.iter().map(fold_exp_ln).collect()),
        Expr::Unary(op, operand) => Expr::Unary(*op, Box::new(fold_exp_ln(operand))),
        Expr::Binary(op, left, right) => Expr::Binary(
            *op,
            Box::new(fold_exp_ln(left)),
            Box::new(fold_exp_ln(right)),
        ),
        Expr::List(items) => Expr::List(items.iter().map(fold_exp_ln).collect()),
        Expr::Num(_) | Expr::Sym(_) => expr.clone(),
    }
}

/// `1/expr`:先把和差通分成单一分式,是分式就上下颠倒取倒数.
///
/// 直接写 `1/((a/b))` 会得到嵌套分式,积分器读不出来(实测踩过).
fn reciprocal(expr: &Expr) -> Expr {
    let combined = combine_fraction(expr);
    match &combined {
        Expr::Binary(BinOp::Div, numerator, denominator) => simplify(div(
            denominator.as_ref().clone(),
            numerator.as_ref().clone(),
        )),
        _ => simplify(div(num(1.0), combined)),
    }
}

/// 抽样值:确定性伪随机,避开 0 与 1.
fn sample_value(index: usize, round: usize) -> f64 {
    let raw = ((index * 7 + round * 13) % 17) as f64 - 8.0;
    if raw == 0.0 {
        0.7
    } else {
        raw * 0.5 + 0.31
    }
}

/// 把符号按绑定表求值(未绑定的名字返回 `None`).
fn eval_bound(expr: &Expr, bindings: &[(&str, f64)]) -> Option<f64> {
    let result = evaluate_with_lookup(expr, &|name: &str| {
        bindings
            .iter()
            .find(|(bound, _)| *bound == name)
            .map(|(_, value)| *value)
    });
    match result {
        Ok(Some(value)) if value.is_finite() => Some(value),
        _ => None,
    }
}

fn is_numeric_one(expr: &Expr) -> bool {
    matches!(expr, Expr::Num(value) if *value == 1.0)
}

/// 常量子表达式的有限数值;非常数/非有限返回 `None`.
fn constant_number(expr: &Expr) -> Option<f64> {
    match evaluate_constant(expr) {
        Ok(Some(value)) if value.is_finite() => Some(value),
        _ => None,
    }
}

/// 解析一段表达式文本(别名展开 + 元数校验 + 化简).
fn parse_expression(text: &str) -> Result<Expr, String> {
    let parsed = parse_expr(text)?;
    let rewritten = rewrite_aliases(&parsed)?;
    validate_supported(&rewritten)?;
    Ok(simplify(rewritten))
}

/// 解析初值左端(如 `y(0)` / `y'(0)`).
///
/// 刻意**不做**函数白名单校验:左端是"因变量在初值点的取值",`y(...)` 不是
/// 内建函数,走 `validate_supported` 会被判成"未知函数 y";形状校验由调用方
/// 按 `Call(因变量, [点])` 做.
fn parse_initial_lhs(text: &str) -> Result<Expr, String> {
    let parsed = parse_expr(text)?;
    Ok(simplify(rewrite_aliases(&parsed)?))
}

/// 表达式里的自由符号(去重).
fn symbols_of(expr: &Expr) -> Vec<String> {
    let mut names = Vec::new();
    super::collect_symbols(expr, &mut names);
    names
}

/// 加法项展开:`a + b - c` -> `[(1,a), (1,b), (-1,c)]`.
fn flatten_sum(expr: &Expr) -> Vec<(f64, Expr)> {
    let mut out = Vec::new();
    collect_sum(expr, 1.0, &mut out);
    out
}

fn collect_sum(expr: &Expr, sign: f64, out: &mut Vec<(f64, Expr)>) {
    match expr {
        Expr::Binary(BinOp::Add, left, right) => {
            collect_sum(left, sign, out);
            collect_sum(right, sign, out);
        }
        Expr::Binary(BinOp::Sub, left, right) => {
            collect_sum(left, sign, out);
            collect_sum(right, -sign, out);
        }
        Expr::Unary(UnaryOp::Neg, operand) => collect_sum(operand, -sign, out),
        _ => out.push((sign, expr.clone())),
    }
}

fn product(factors: Vec<Expr>) -> Expr {
    let mut iter = factors.into_iter();
    let Some(first) = iter.next() else {
        return num(1.0);
    };
    iter.fold(first, mul)
}

/// 把乘积对加法展开(`y*(1-y)` -> `y - y^2`),并**有界**:节点数超过预算就
/// 放弃(返回 `None`),绝不把表达式炸开.
///
/// 为什么需要它:方程写成因式形式(`y*(1-y)`,`(x^2-1)*y'`)时,不展开就判不出
/// 幂次/线性性,伯努利这类分支会整条失效(实测踩过:经典 logistic `y'=y(1-y)`
/// 因此掉到"隐式解").展开只做分配律,不改动函数调用内部.
fn expand_products(expr: &Expr, budget: &mut usize) -> Option<Expr> {
    if *budget == 0 {
        return None;
    }
    *budget -= 1;
    match expr {
        Expr::Num(_) | Expr::Sym(_) => Some(expr.clone()),
        Expr::List(_) => Some(expr.clone()),
        Expr::Call(name, args) => {
            let mut expanded = Vec::with_capacity(args.len());
            for arg in args {
                expanded.push(expand_products(arg, budget)?);
            }
            Some(Expr::Call(name.clone(), expanded))
        }
        Expr::Unary(op, operand) => Some(Expr::Unary(
            *op,
            Box::new(expand_products(operand, budget)?),
        )),
        Expr::Binary(BinOp::Add, left, right) => Some(add(
            expand_products(left, budget)?,
            expand_products(right, budget)?,
        )),
        Expr::Binary(BinOp::Sub, left, right) => Some(sub(
            expand_products(left, budget)?,
            expand_products(right, budget)?,
        )),
        Expr::Binary(BinOp::Mul, left, right) => {
            let left = expand_products(left, budget)?;
            let right = expand_products(right, budget)?;
            distribute_product(&left, &right, budget)
        }
        Expr::Binary(BinOp::Div, numerator, denominator) => Some(div(
            expand_products(numerator, budget)?,
            expand_products(denominator, budget)?,
        )),
        Expr::Binary(BinOp::Pow, base, exponent) => {
            let base = expand_products(base, budget)?;
            let exponent = expand_products(exponent, budget)?;
            // 小的正整数幂:展开成连乘(`(1-y)^2` 也能判幂次).
            if let (Expr::Num(power), true) = (
                &exponent,
                matches!(&base, Expr::Binary(BinOp::Add | BinOp::Sub, _, _)),
            ) {
                if *power >= 1.0 && *power <= 4.0 && power.fract() == 0.0 {
                    let mut result = num(1.0);
                    for _ in 0..(*power as usize) {
                        result = distribute_product(&result, &base, budget)?;
                    }
                    return Some(result);
                }
            }
            Some(pow(base, exponent))
        }
    }
}

/// `left * right`,其中两侧都已展开:一侧是加法就分配.
fn distribute_product(left: &Expr, right: &Expr, budget: &mut usize) -> Option<Expr> {
    if *budget == 0 {
        return None;
    }
    *budget -= 1;
    match (left, right) {
        (Expr::Binary(BinOp::Add, a, b), _) => Some(add(
            distribute_product(a, right, budget)?,
            distribute_product(b, right, budget)?,
        )),
        (Expr::Binary(BinOp::Sub, a, b), _) => Some(sub(
            distribute_product(a, right, budget)?,
            distribute_product(b, right, budget)?,
        )),
        (_, Expr::Binary(BinOp::Add, a, b)) => Some(add(
            distribute_product(left, a, budget)?,
            distribute_product(left, b, budget)?,
        )),
        (_, Expr::Binary(BinOp::Sub, a, b)) => Some(sub(
            distribute_product(left, a, budget)?,
            distribute_product(left, b, budget)?,
        )),
        _ => Some(mul(left.clone(), right.clone())),
    }
}

/// 把含显式 0 因子的乘积折成 0,并把 `e^0` 折成 1(只用于初值代入后的清理).
///
/// `simplify` 刻意不折 `0 * f`(`f` 可能是 `1/0`),但初值代入里的 `p*x`
/// (`x -> 0`)是"有限参数乘有限初值点",折成 0 是安全的;不折的话特解会排成
/// `e^{0 \cdot 0\,p}` 这种读不懂的式子(实测踩过:符号系数 + 初值).
fn fold_initial_substitution(expr: &Expr) -> Expr {
    match expr {
        Expr::Binary(BinOp::Mul, left, right) => {
            let left = fold_initial_substitution(left);
            let right = fold_initial_substitution(right);
            if is_zero(&left) || is_zero(&right) {
                num(0.0)
            } else {
                mul(left, right)
            }
        }
        Expr::Binary(op, left, right) => bin(
            *op,
            fold_initial_substitution(left),
            fold_initial_substitution(right),
        ),
        Expr::Unary(op, operand) => Expr::Unary(*op, Box::new(fold_initial_substitution(operand))),
        Expr::Call(name, args) => {
            let args: Vec<Expr> = args.iter().map(fold_initial_substitution).collect();
            if name == "exp" && args.len() == 1 && is_zero(&args[0]) {
                return num(1.0);
            }
            call(name, args)
        }
        Expr::List(items) => Expr::List(items.iter().map(fold_initial_substitution).collect()),
        Expr::Num(_) | Expr::Sym(_) => expr.clone(),
    }
}

/// 有界展开(预算内的节点数);超预算就用原式(下游判定退回结构法).
fn expanded(expr: &Expr) -> Expr {
    let mut budget = 512usize;
    expand_products(expr, &mut budget).unwrap_or_else(|| expr.clone())
}

/// `expr` 对 `variable` 是否是一次式;是则给出 `(系数, 常数项)`.
///
/// 用**结构拆分**而不是"代入 0/1 再相减":`simplify` 不做多项式正规化,
/// `(1 - x*y) - (-(x*y))` 不会收成 `1`,相减得到的系数既脏又会让下游积分器
/// 读不懂(实测踩过).这里按加法项逐项看 `variable` 的幂次与系数,系数本身
/// 可以是含参数的符号表达式(`a(x)y + b(x)` 里的 `a(x)`).
fn affine_in(expr: &Expr, variable: &str) -> Option<(Expr, Expr)> {
    // 先做有界展开:因式形式(`2*(y+1)`,`(x^2-1)*y'`)不展开判不出一次式.
    let expr = expanded(expr);
    let mut coeff = num(0.0);
    let mut offset = num(0.0);
    for (sign, term) in flatten_sum(&expr) {
        let (term_coeff, power) = term_dependent_power(&term, variable)?;
        let term_coeff = if sign < 0.0 {
            neg(term_coeff)
        } else {
            term_coeff
        };
        if power == 0.0 {
            offset = add(offset, term_coeff);
        } else if power == 1.0 {
            coeff = add(coeff, term_coeff);
        } else {
            return None;
        }
    }
    Some((simplify(coeff), simplify(offset)))
}

/// 单项里因变量的幂次与系数:`c * y^n` -> `(c, n)`;判不出返回 `None`.
fn term_dependent_power(term: &Expr, dependent: &str) -> Option<(Expr, f64)> {
    match term {
        Expr::Num(_) => Some((term.clone(), 0.0)),
        Expr::Sym(name) if name == dependent => Some((num(1.0), 1.0)),
        Expr::Sym(_) => Some((term.clone(), 0.0)),
        // 顶层和差已由 flatten_sum 拆开;还留在单项里的和差只可能出现在
        // 括号里(`(y+1)/x`).整块不含因变量时它就是系数,含了才判不出
        // (`sin(x*y)`,`(x+y)/x`).
        Expr::Binary(BinOp::Add | BinOp::Sub, _, _) => {
            if contains(term, dependent) {
                None
            } else {
                Some((term.clone(), 0.0))
            }
        }
        Expr::Unary(UnaryOp::Neg, operand) => {
            let (coeff, power) = term_dependent_power(operand, dependent)?;
            Some((neg(coeff), power))
        }
        Expr::Binary(BinOp::Mul, left, right) => {
            let (left_coeff, left_power) = term_dependent_power(left, dependent)?;
            let (right_coeff, right_power) = term_dependent_power(right, dependent)?;
            // 两侧都有幂次时幂次相加(`y*y` -> `y^2`).系数是否含因变量由调用方
            // 把关(伯努利判定要求系数不含因变量,见 `try_bernoulli`);这里不能
            // 直接拒绝,否则 `y*(1-y)` 展开后的 `y*y` 会让整项判不出幂次.
            Some((mul(left_coeff, right_coeff), left_power + right_power))
        }
        Expr::Binary(BinOp::Div, numerator, denominator) => {
            let (num_coeff, num_power) = term_dependent_power(numerator, dependent)?;
            let (den_coeff, den_power) = term_dependent_power(denominator, dependent)?;
            if den_power != 0.0 {
                return None;
            }
            Some((div(num_coeff, den_coeff), num_power))
        }
        Expr::Binary(BinOp::Pow, base, exponent) => {
            let Some(power) = constant_number(exponent) else {
                // 符号指数:`y^a` 判不出幂次;`e^y` 这类"因变量在指数上"的项更
                // 不能当常数(否则 `y*sin(x) + x^2*e^y` 会被误判成 y 的一次式,
                // 实测踩过:恰当方程被"解"出一个错显式解).
                return if contains(base, dependent) || contains(exponent, dependent) {
                    None
                } else {
                    Some((term.clone(), 0.0))
                };
            };
            let (coeff, base_power) = term_dependent_power(base, dependent)?;
            Some((pow(coeff, num(power)), base_power * power))
        }
        Expr::Call(_, args) => {
            if args.iter().any(|arg| contains(arg, dependent)) {
                None
            } else {
                Some((term.clone(), 0.0))
            }
        }
        Expr::List(_) => None,
    }
}

/// 把表达式按因变量的幂次分组:`f = Σ c_k(x) y^k`,返回 `(c_k, k)` 表.
///
/// Bernoulli 判定靠它:恰好两项,幂次为 `{1, n}` 且系数不含因变量时是
/// 伯努利方程.参数保持符号(`c_k` 可以是含参数的表达式),所以不能走
/// `Poly::from_expr`(它要求系数是数值).
fn dependent_power_terms(expr: &Expr, dependent: &str) -> Option<Vec<(Expr, f64)>> {
    let expr = expanded(expr);
    let mut out: Vec<(Expr, f64)> = Vec::new();
    for (sign, term) in flatten_sum(&expr) {
        let (coeff, power) = term_dependent_power(&term, dependent)?;
        let coeff = if sign < 0.0 { neg(coeff) } else { coeff };
        match out
            .iter_mut()
            .find(|(_, existing): &&mut (Expr, f64)| (*existing - power).abs() < EPSILON)
        {
            Some(entry) => entry.0 = add(entry.0.clone(), coeff),
            None => out.push((coeff, power)),
        }
    }
    out.retain(|(coeff, _)| !is_zero(coeff));
    Some(out)
}

/// 把表达式摊成"乘积因子 + 是否取倒数";遇到数组等不可判定形状返回 `None`.
fn flatten_product(expr: &Expr, invert: bool, out: &mut Vec<(bool, Expr)>) -> Option<()> {
    match expr {
        Expr::Binary(BinOp::Mul, left, right) => {
            flatten_product(left, invert, out)?;
            flatten_product(right, invert, out)?;
        }
        Expr::Binary(BinOp::Div, numerator, denominator) => {
            flatten_product(numerator, invert, out)?;
            flatten_product(denominator, !invert, out)?;
        }
        Expr::Binary(BinOp::Pow, base, exponent) => {
            match constant_number(exponent) {
                // 负幂就是倒数:整项取反一次,指数取正后原样保留.
                Some(power) if power < 0.0 => {
                    out.push((
                        invert,
                        div(num(1.0), pow(base.as_ref().clone(), num(-power))),
                    ));
                }
                _ => out.push((invert, expr.clone())),
            }
        }
        Expr::Unary(UnaryOp::Neg, operand) => {
            out.push((invert, num(-1.0)));
            flatten_product(operand, invert, out)?;
        }
        Expr::List(_) => return None,
        _ => out.push((invert, expr.clone())),
    }
    Some(())
}

/// 可分离判定:`f = h(x)·g(y)`.
///
/// 要求每一项都能摊成"只含 x 的因子 × 只含 y 的因子";任何因子同时含两个
/// 变量(如 `sin(x*y)`,`x + y`)就判不出,交给后面的类型.
fn split_separable(expr: &Expr, dependent: &str, independent: &str) -> Option<(Expr, Expr)> {
    let mut factors = Vec::new();
    flatten_product(expr, false, &mut factors)?;
    let mut x_factors = Vec::new();
    let mut y_factors = Vec::new();
    for (invert, factor) in factors {
        let has_y = contains(&factor, dependent);
        let has_x = contains(&factor, independent);
        if has_y && has_x {
            return None;
        }
        let factor = if invert {
            div(num(1.0), factor)
        } else {
            factor
        };
        if has_y {
            y_factors.push(factor);
        } else {
            x_factors.push(factor);
        }
    }
    Some((product(x_factors), product(y_factors)))
}

/// 剥掉与因变量无关的常数因子:`k·u(y)` -> `(k, u)`.
fn split_constant_factor(expr: &Expr, dependent: &str) -> (Expr, Expr) {
    match expr {
        // `-(u(y))`:常数因子 -1,函数体原样(否则 `-1/y` 这类形状会漏掉).
        Expr::Unary(UnaryOp::Neg, operand) => (num(-1.0), operand.as_ref().clone()),
        Expr::Binary(BinOp::Mul, left, right) => {
            if !contains(left, dependent) {
                (left.as_ref().clone(), right.as_ref().clone())
            } else if !contains(right, dependent) {
                (right.as_ref().clone(), left.as_ref().clone())
            } else {
                (num(1.0), expr.clone())
            }
        }
        // `u(y) / c`(`c` 与因变量无关)-> 常数因子 `1/c`,函数体 `u`.
        Expr::Binary(BinOp::Div, numerator, denominator) if !contains(denominator, dependent) => (
            div(num(1.0), denominator.as_ref().clone()),
            numerator.as_ref().clone(),
        ),
        _ => (num(1.0), expr.clone()),
    }
}

/// 函数取反表:显式化隐式解时用(`ln(u)=T -> u=e^T`,`atan(u)=T -> u=tan(T)`).
fn inverse_function(name: &str) -> Option<&'static str> {
    Some(match name {
        "ln" => "exp",
        "exp" => "ln",
        "atan" => "tan",
        "tan" => "atan",
        "asin" => "sin",
        "sin" => "asin",
        "acos" => "cos",
        "cos" => "acos",
        "sqrt" => "pow2",
        "sinh" => "asinh",
        "asinh" => "sinh",
        "cosh" => "acosh",
        "acosh" => "cosh",
        "tanh" => "atanh",
        "atanh" => "tanh",
        _ => return None,
    })
}

/// 从 `lhs(y) = target` 解出 `y`;解不出返回 `None`(**不猜**,由调用方如实
/// 标注隐式解).
fn invert_dependent(lhs: &Expr, target: &Expr, dependent: &str) -> Option<Expr> {
    // 1) 一次式:k·y + b = T.
    if let Some((coeff, offset)) = affine_in(lhs, dependent) {
        if !is_zero(&coeff) {
            return Some(simplify(div(sub(target.clone(), offset), coeff)));
        }
    }

    // 2) 常数因子剥掉后套函数取反表 / 幂函数.
    let (factor, body) = split_constant_factor(lhs, dependent);
    let scaled = if is_numeric_one(&factor) {
        target.clone()
    } else {
        simplify(div(target.clone(), factor))
    };

    match &body {
        Expr::Call(name, args) if args.len() == 1 => {
            let inverse = inverse_function(name)?;
            let inner_value = if inverse == "pow2" {
                pow(scaled, num(2.0))
            } else {
                call(inverse, vec![scaled])
            };
            // 一期积分器把 `∫dy/y` 写成 `ln|y|`(实数语义下带绝对值);显式化
            // 时剥掉这层 `|·|`:任意常数 C 天然吸收正负号,教科书也这么写.
            let mut inner: &Expr = &args[0];
            if let Expr::Call(inner_name, inner_args) = inner {
                if inner_name == "abs" && inner_args.len() == 1 {
                    inner = &inner_args[0];
                }
            }
            let (coeff, offset) = affine_in(inner, dependent)?;
            if is_zero(&coeff) {
                return None;
            }
            Some(simplify(div(sub(inner_value, offset), coeff)))
        }
        Expr::Binary(BinOp::Pow, base, exponent) => {
            let power = constant_number(exponent)?;
            if power == 0.0 {
                return None;
            }
            let root = pow(scaled, num(1.0 / power));
            let (coeff, offset) = affine_in(base, dependent)?;
            if is_zero(&coeff) {
                return None;
            }
            Some(simplify(div(sub(root, offset), coeff)))
        }
        // `c / u(y) = T`(`c` 与因变量无关)-> `u = c / T`.
        Expr::Binary(BinOp::Div, numerator, denominator) => {
            if contains(numerator, dependent) {
                return None;
            }
            let (coeff, offset) = affine_in(denominator, dependent)?;
            if is_zero(&coeff) {
                return None;
            }
            Some(simplify(div(
                sub(div(numerator.as_ref().clone(), scaled), offset),
                coeff,
            )))
        }
        _ => None,
    }
}

// ============================================================
// 文本切分与导数记号归一
// ============================================================

/// 按**顶层**等号切分(`solve.rs` 同款:只数括号深度).
fn split_top_level_eq(source: &str) -> Result<(&str, &str), String> {
    let mut depth = 0i32;
    let mut found: Option<usize> = None;
    for (index, ch) in source.char_indices() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            '=' if depth == 0 => {
                if found.is_some() {
                    return Err("方程里出现了多个等号".to_string());
                }
                found = Some(index);
            }
            _ => {}
        }
    }
    let index = found.ok_or_else(|| "方程缺少等号,请写成 `左边 = 右边`".to_string())?;
    let lhs = source[..index].trim();
    let rhs = source[index + 1..].trim();
    if lhs.is_empty() || rhs.is_empty() {
        return Err("等号两侧都必须有表达式".to_string());
    }
    Ok((lhs, rhs))
}

/// 导数记号归一:**字符扫描**,标识符边界感知.
///
/// - `y'' -> ypp`,`y' -> yp`,`y_1' -> y_1p`;
/// - 标识符读到非标识符字符为止,再看紧跟的连续 `'` 个数(1 -> `p`,
///   2 -> `pp`,超过 2 个报错);
/// - 用 `str::replace` 会把 `a*y'` 这类写法读错,也会吃掉 `y_1'` 的下标,
///   所以必须扫描;
/// - 归一化后的名字若与源码里已有的普通标识符同名(如用户自己写了 `yp`),
///   直接报错而不是静默读错方程.
///
/// 返回值第二项是 `(因变量名, 阶数)` 列表,供因变量推断与冲突检查.
fn normalize_derivative_notation(source: &str) -> Result<(String, Vec<(String, usize)>), String> {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::new();
    let mut marks: Vec<(String, usize)> = Vec::new();
    let mut identifiers: Vec<String> = Vec::new();
    let mut index = 0usize;

    while index < chars.len() {
        let current = chars[index];
        if current.is_ascii_alphabetic() || current == '_' {
            let start = index;
            while index < chars.len()
                && (chars[index].is_ascii_alphanumeric() || chars[index] == '_')
            {
                index += 1;
            }
            let name: String = chars[start..index].iter().collect();
            identifiers.push(name.clone());
            let mut primes = 0usize;
            while index < chars.len() && chars[index] == '\'' {
                primes += 1;
                index += 1;
            }
            if primes > 2 {
                return Err(format!(
                    "导数记号 {name}{} 超过二阶,内核只支持一阶与二阶方程",
                    "'".repeat(primes)
                ));
            }
            out.push_str(&name);
            if primes > 0 {
                out.push_str(&"p".repeat(primes));
                marks.push((name, primes));
            }
        } else {
            out.push(current);
            index += 1;
        }
    }

    for (name, order) in &marks {
        let normalized = format!("{name}{}", "p".repeat(*order));
        if identifiers
            .iter()
            .any(|identifier| identifier == &normalized)
        {
            return Err(format!(
                "符号 {normalized} 与导数记号 {name}{} 的归一化名冲突,请改用其他符号名",
                "'".repeat(*order)
            ));
        }
    }

    Ok((out, marks))
}

// ============================================================
// 求解主流程
// ============================================================

/// 一条解(通解)的内部表示.
struct OdeSolution {
    /// 显式通解 `y = f(x, C...)`(含常数符号);隐式解时为 `None`.
    explicit: Option<Expr>,
    /// 隐式通解 `Φ(x,y) = C`;显式解时为 `None`.
    implicit_phi: Option<Expr>,
    /// 常数符号(`["C"]` / `["C_1","C_2"]`).
    constants: Vec<String>,
    /// 二阶显式解的两个基函数(`y = C_1 y_1 + C_2 y_2`);一阶/隐式解为 `None`.
    basis: Option<(Expr, Expr)>,
}

struct OdeSolver<'a> {
    /// 移项后的原方程左端 `E(x, y, y', y'') = 0`(恰当判定要用微分形式的系数).
    residual: Expr,
    dependent: String,
    independent: String,
    declared: &'a [String],
    steps: Vec<OdeStep>,
    notes: Vec<String>,
}

impl<'a> OdeSolver<'a> {
    /// LaTeX 渲染:先做导数记号的展示替换(`yp -> y'`),再走共享打印器.
    ///
    /// `'` 不是合法标识符字符,所以这个展示名不可能与用户符号冲突
    /// (归一化阶段的冲突检查另有一道,见 `normalize_derivative_notation`).
    fn latex(&self, expr: &Expr) -> String {
        let display = self.prime_view(expr);
        format_expr(&display, PrintMode::Latex, 0)
    }

    fn prime_view(&self, expr: &Expr) -> Expr {
        let first = format!("{}p", self.dependent);
        let second = format!("{}pp", self.dependent);
        prime_view_inner(expr, &first, &second, &self.dependent)
    }

    fn push(&mut self, latex: impl Into<String>, reason: &str, kind: &str) {
        self.steps.push(step(latex, reason, kind));
    }

    fn note(&mut self, message: impl Into<String>) {
        self.notes.push(message.into());
    }

    /// 调一期积分器求原函数(参数只传名字 -> 结果里参数保持符号).
    fn integrate(&self, expr: &Expr, variable: &str) -> Result<Expr, String> {
        let mut declared: Vec<String> = self.declared.to_vec();
        for extra in [self.independent.as_str(), self.dependent.as_str()] {
            if extra != variable && !declared.iter().any(|name| name == extra) {
                declared.push(extra.to_string());
            }
        }
        let outcome = antiderivative_with_parameters(
            &expr.to_string(),
            variable,
            &HashMap::new(),
            &declared,
        )?;
        if let Some(error) = outcome.error {
            return Err(error);
        }
        if outcome.antiderivative_text.is_empty() {
            return Err("积分内核没有给出原函数".to_string());
        }
        Ok(drop_zero_terms(&parse_expression(
            &outcome.antiderivative_text,
        )?))
    }

    fn solve_with_slope(&mut self, slope: &Expr) -> Result<OdeSolution, String> {
        // 右端与因变量无关:直接两侧积分(不必比较下面几类).
        if !contains(slope, &self.dependent) {
            return match self.try_linear(slope)? {
                Some(solution) => Ok(solution),
                None => Err("右端只含自变量:直接积分未能给出通解".to_string()),
            };
        }

        // 分支顺序按"方程的结构特征"定,不写死一套:
        // - 自变量真的出现在分离出的 x 因子里(`y' = x*y`)-> 可分离优先,
        //   这是这类方程最直白的解法;
        // - x 因子退化成常数(`y' + p*y = q`,`y' = a*y + b`)-> 线性优先,
        //   学生看到的才是"标准形 + 积分因子";
        // - 幂次落在 `{1, n}`(`y' + y = y^2`)-> 伯努利先于可分离.
        // 每个分支"判定不上"返回 None,"判定上了但算不动"返回 Err;
        // 全部失败时报告第一个最具体的理由.
        let x_part_has_independent = split_separable(slope, &self.dependent, &self.independent)
            .map(|(x_part, _)| contains(&x_part, &self.independent))
            .unwrap_or(false);
        let mut first_error: Option<String> = None;
        macro_rules! attempt {
            ($call:expr) => {
                match $call {
                    Ok(Some(solution)) => return Ok(solution),
                    Ok(None) => {}
                    Err(message) => {
                        if first_error.is_none() {
                            first_error = Some(message);
                        }
                    }
                }
            };
        }
        if x_part_has_independent {
            attempt!(self.try_separable(slope));
            attempt!(self.try_linear(slope));
            attempt!(self.try_bernoulli(slope));
        } else {
            attempt!(self.try_linear(slope));
            attempt!(self.try_bernoulli(slope));
            attempt!(self.try_separable(slope));
        }
        attempt!(self.try_homogeneous(slope));
        attempt!(self.try_exact(slope));
        Err(first_error.unwrap_or_else(|| {
            "超出内核能力:不在可解清单内(可分离 / 一阶线性 / 伯努利 / 齐次 / 恰当 / 二阶常系数齐次)"
                .to_string()
        }))
    }

    /// 一阶线性(含 `y' = q(x)` 的直接积分):`y' + p(x) y = q(x)`.
    fn try_linear(&mut self, slope: &Expr) -> Result<Option<OdeSolution>, String> {
        let Some((y_coeff, q)) = affine_in(slope, &self.dependent) else {
            return Ok(None);
        };
        if contains(&y_coeff, &self.dependent) || contains(&q, &self.dependent) {
            return Ok(None);
        }
        let p = simplify(neg(y_coeff));
        let independent = self.independent.clone();
        let dependent = self.dependent.clone();

        if is_zero(&p) {
            // 右端只含 x:直接两侧积分.
            let equation = format!("{}' = {}", dependent, self.latex(&q));
            self.push(equation, "右端只含自变量:直接积分", KIND_DEFINITION);
            // 右端恒为 0 时不必调积分器:`0 * f` 在 simplify 里刻意不折叠
            // (见 simplify.rs 的定义域口径),直接走积分链会报"无法给出 0 的原函数".
            let integral = if is_zero_function(&q) {
                num(0.0)
            } else {
                self.integrate(&q, &independent)?
            };
            let general = simplify(add(integral.clone(), sym("C")));
            self.push(
                format!(
                    "{} = \\int {} \\;\\mathrm{{d}}{} + C = {}",
                    dependent,
                    self.latex(&q),
                    independent,
                    self.latex(&general)
                ),
                "两侧对自变量积分",
                KIND_TABLE,
            );
            return Ok(Some(OdeSolution {
                explicit: Some(general),
                implicit_phi: None,
                constants: vec!["C".to_string()],
                basis: None,
            }));
        }

        self.push(
            format!(
                "{}' + \\left({}\\right) {} = {}",
                dependent,
                self.latex(&p),
                dependent,
                self.latex(&q)
            ),
            "一阶线性标准形",
            KIND_DEFINITION,
        );
        let p_integral = self.integrate(&p, &independent)?;
        let mu = fold_exp_ln(&simplify(exp(p_integral.clone())));
        self.push(
            format!(
                "\\mu = e^{{\\int {} \\;\\mathrm{{d}}{}}} = {}",
                self.latex(&p),
                independent,
                self.latex(&mu)
            ),
            "积分因子",
            KIND_TABLE,
        );
        let mu_q = fold_exp_ln(&simplify(mul(mu.clone(), q.clone())));
        self.push(
            format!(
                "\\left({} {}\\right)' = {}",
                self.latex(&mu),
                dependent,
                self.latex(&mu_q)
            ),
            "两侧同乘积分因子",
            KIND_RULE,
        );
        let integral = if is_zero_function(&q) {
            num(0.0)
        } else {
            self.integrate(&mu_q, &independent)?
        };
        self.push(
            format!(
                "{} {} = \\int {} \\;\\mathrm{{d}}{} + C = {} + C",
                self.latex(&mu),
                dependent,
                self.latex(&mu_q),
                independent,
                self.latex(&integral)
            ),
            "两侧积分",
            KIND_TABLE,
        );
        // 通解写成 `(∫μq + C)/μ`:化简器不做因子约分(`(q e^{px}/p)/e^{px}`
        // 不会收成 `q/p`),所以拆成 `C/μ + (∫μq)/μ` 反而更花;整式一个分式
        // 是这里最干净的形状(等价形式 `q/p + C e^{-p x}` 由示例注释说明).
        let general = simplify(div(add(integral, sym("C")), mu.clone()));
        self.push(
            format!("{} = {}", dependent, self.latex(&general)),
            "解出通解",
            KIND_ALGEBRA,
        );
        Ok(Some(OdeSolution {
            explicit: Some(general),
            implicit_phi: None,
            constants: vec!["C".to_string()],
            basis: None,
        }))
    }

    /// Bernoulli:`y' + p(x) y = q(x) y^n`(`n` 为数值常数).
    fn try_bernoulli(&mut self, slope: &Expr) -> Result<Option<OdeSolution>, String> {
        let Some(terms) = dependent_power_terms(slope, &self.dependent) else {
            return Ok(None);
        };
        let nonzero: Vec<(Expr, f64)> = terms
            .into_iter()
            .filter(|(_, power)| *power != 0.0)
            .collect();
        if nonzero.len() != 2 {
            return Ok(None);
        }
        let (first_coeff, first_power) = (nonzero[0].0.clone(), nonzero[0].1);
        let (second_coeff, second_power) = (nonzero[1].0.clone(), nonzero[1].1);
        let (linear_coeff, other_coeff, exponent);
        if (first_power - 1.0).abs() < EPSILON {
            linear_coeff = first_coeff;
            other_coeff = second_coeff;
            exponent = second_power;
        } else if (second_power - 1.0).abs() < EPSILON {
            linear_coeff = second_coeff;
            other_coeff = first_coeff;
            exponent = first_power;
        } else {
            return Ok(None);
        }
        if (exponent - 1.0).abs() < EPSILON || exponent == 0.0 {
            return Ok(None);
        }
        if contains(&linear_coeff, &self.dependent) || contains(&other_coeff, &self.dependent) {
            return Ok(None);
        }

        let dependent = self.dependent.clone();
        let independent = self.independent.clone();
        let p = simplify(neg(linear_coeff));
        let q = other_coeff;
        self.push(
            format!(
                "{}' + \\left({}\\right) {} = \\left({}\\right) {}^{{{}}}",
                dependent,
                self.latex(&p),
                dependent,
                self.latex(&q),
                dependent,
                format_exponent(exponent)
            ),
            "伯努利方程标准形",
            KIND_DEFINITION,
        );
        let one_minus_n = 1.0 - exponent;
        let u_name = self.fresh_symbol("u");
        self.push(
            format!(
                "{} = {}^{{{}}}",
                u_name,
                dependent,
                format_exponent(one_minus_n)
            ),
            "伯努利换元",
            KIND_SUBSTITUTE,
        );
        // y' + p y = q y^n,u = y^{1-n} -> u' + (1-n)p u = (1-n) q, 化为一阶线性.
        let p_u = simplify(mul(num(one_minus_n), p.clone()));
        let q_u = simplify(mul(num(one_minus_n), q.clone()));
        self.push(
            format!(
                "{}' + \\left({}\\right) {} = {}",
                u_name,
                self.latex(&p_u),
                u_name,
                self.latex(&q_u)
            ),
            "化为线性方程",
            KIND_ALGEBRA,
        );
        let p_integral = self.integrate(&p_u, &independent)?;
        let mu = fold_exp_ln(&simplify(exp(p_integral.clone())));
        self.push(
            format!(
                "\\mu = e^{{\\int {} \\;\\mathrm{{d}}{}}} = {}",
                self.latex(&p_u),
                independent,
                self.latex(&mu)
            ),
            "积分因子",
            KIND_TABLE,
        );
        let mu_q = fold_exp_ln(&simplify(mul(mu.clone(), q_u)));
        let integral = if is_zero_function(&mu_q) {
            num(0.0)
        } else {
            self.integrate(&mu_q, &independent)?
        };
        let u_general = simplify(div(add(integral, sym("C")), mu.clone()));
        self.push(
            format!("{} = {}", u_name, self.latex(&u_general)),
            "线性方程的通解",
            KIND_ALGEBRA,
        );
        let exponent_inverse = 1.0 / one_minus_n;
        // `u = (A + C)/B`,`y = u^{-1}` 直接写 `u^{-1}` 会排出套娃分式
        // `((A+C)/B)^{-1}`;取倒数写成 `B/(A+C)` 才是学生认得的形状.
        let general = if (exponent_inverse + 1.0).abs() < EPSILON {
            reciprocal(&u_general)
        } else {
            simplify(pow(u_general.clone(), num(exponent_inverse)))
        };
        self.push(
            format!(
                "{} = {}^{{{}}} = {}",
                dependent,
                u_name,
                format_exponent(1.0 / one_minus_n),
                self.latex(&general)
            ),
            "换元回代得通解",
            KIND_SUBSTITUTE,
        );
        Ok(Some(OdeSolution {
            explicit: Some(general),
            implicit_phi: None,
            constants: vec!["C".to_string()],
            basis: None,
        }))
    }

    /// 一阶可分离:`y' = h(x)·g(y)`.
    fn try_separable(&mut self, slope: &Expr) -> Result<Option<OdeSolution>, String> {
        let Some((h, g)) = split_separable(slope, &self.dependent, &self.independent) else {
            return Ok(None);
        };
        let dependent = self.dependent.clone();
        let independent = self.independent.clone();
        // g(y) = 0 会让 1/g 无定义:此时常数解 y = 常数 需要单独说明,直接
        // 交给后面的分支(可分离公式在这里不成立).
        if is_zero_function(&g) {
            return Ok(None);
        }
        self.push(
            format!(
                "\\frac{{1}}{{{}}} \\;\\mathrm{{d}}{} = \\left({}\\right) \\;\\mathrm{{d}}{}",
                self.latex(&g),
                dependent,
                self.latex(&h),
                independent
            ),
            "分离变量",
            KIND_ALGEBRA,
        );
        let inverse_g = reciprocal(&g);
        let left = if is_zero_function(&inverse_g) {
            num(0.0)
        } else {
            self.integrate(&inverse_g, &dependent)?
        };
        let right = if is_zero_function(&h) {
            num(0.0)
        } else {
            self.integrate(&h, &independent)?
        };
        self.push(
            format!(
                "\\int \\frac{{1}}{{{}}} \\;\\mathrm{{d}}{} = \\int \\left({}\\right) \\;\\mathrm{{d}}{}",
                self.latex(&g),
                dependent,
                self.latex(&h),
                independent
            ),
            "两侧积分",
            KIND_TABLE,
        );
        let target = simplify(add(right.clone(), sym("C")));
        if let Some(explicit) = invert_dependent(&left, &target, &dependent) {
            self.push(
                format!("{} = {}", dependent, self.latex(&explicit)),
                "解出通解",
                KIND_ALGEBRA,
            );
            return Ok(Some(OdeSolution {
                explicit: Some(explicit),
                implicit_phi: None,
                constants: vec!["C".to_string()],
                basis: None,
            }));
        }
        let phi = simplify(sub(left.clone(), right.clone()));
        self.push(
            format!("{} = {} + C", self.latex(&left), self.latex(&right)),
            "积分得隐式通解",
            KIND_ALGEBRA,
        );
        self.note(format!(
            "通解是隐式形式 {} = C:内核未能把它解成 {}(...),暂不按下发解曲线",
            self.latex(&phi),
            dependent
        ));
        Ok(Some(OdeSolution {
            explicit: None,
            implicit_phi: Some(phi),
            constants: vec!["C".to_string()],
            basis: None,
        }))
    }

    /// 一阶齐次:`y' = F(y/x)`.
    ///
    /// 判定走**数值恒等对拍**而不是代入 `y = t·x` 再看化简结果:简化器不做
    /// 幂次约分,`(x^2 + (t x)^2)/(x·t x)` 这种代入式判不出齐次.改成用
    /// "0 次齐次 => f(x,y) = f(1, y/x)"这条等价刻画,取 `F(u) = f(1, u)`,
    /// 再抽样验证 `f(x,y) ≡ F(y/x)`.
    fn try_homogeneous(&mut self, slope: &Expr) -> Result<Option<OdeSolution>, String> {
        let dependent = self.dependent.clone();
        let independent = self.independent.clone();
        let u_name = self.fresh_symbol("u");
        let at_one = simplify(substitute_many(slope, &[(&independent, 1.0)]));
        let f_of_u = simplify(substitute_symbol(&at_one, &dependent, &sym(&u_name)));
        let restored =
            substitute_symbol(&f_of_u, &u_name, &div(sym(&dependent), sym(&independent)));
        if !is_identically_zero(&sub(slope.clone(), restored)) {
            return Ok(None);
        }
        let remainder = simplify(sub(f_of_u.clone(), sym(&u_name)));
        self.push(
            format!(
                "{}' = F\\left(\\frac{{{}}}{{{}}}\\right),\\quad F({}) = {}",
                dependent,
                dependent,
                independent,
                u_name,
                self.latex(&f_of_u)
            ),
            "判定为齐次方程",
            KIND_RULE,
        );
        self.push(
            format!(
                "{} = \\frac{{{}}}{{{}}} \\;\\Rightarrow\\; {} \\frac{{\\mathrm{{d}}{}}}{{\\mathrm{{d}}{}}} + {} = F({})",
                u_name, dependent, independent, independent, u_name, independent, u_name, u_name
            ),
            "齐次换元",
            KIND_SUBSTITUTE,
        );
        if is_zero_function(&remainder) {
            // u' = 0 -> u = C -> y = C x.
            let general = simplify(mul(sym("C"), sym(&independent)));
            self.push(
                format!(
                    "{} = C \\;\\Rightarrow\\; {} = {}",
                    u_name,
                    dependent,
                    self.latex(&general)
                ),
                "回代得通解",
                KIND_SUBSTITUTE,
            );
            return Ok(Some(OdeSolution {
                explicit: Some(general),
                implicit_phi: None,
                constants: vec!["C".to_string()],
                basis: None,
            }));
        }
        self.push(
            format!(
                "\\frac{{1}}{{{}}} \\;\\mathrm{{d}}{} = \\frac{{1}}{{{}}} \\;\\mathrm{{d}}{}",
                self.latex(&remainder),
                u_name,
                independent,
                independent
            ),
            "化为可分离方程",
            KIND_ALGEBRA,
        );
        let left = self.integrate(&reciprocal(&remainder), &u_name)?;
        let right = self.integrate(&simplify(div(num(1.0), sym(&independent))), &independent)?;
        let target = simplify(add(right.clone(), sym("C")));
        if let Some(u_explicit) = invert_dependent(&left, &target, &u_name) {
            let general = simplify(mul(sym(&independent), u_explicit));
            self.push(
                format!("{} = {}", dependent, self.latex(&general)),
                "换元回代得通解",
                KIND_SUBSTITUTE,
            );
            return Ok(Some(OdeSolution {
                explicit: Some(general),
                implicit_phi: None,
                constants: vec!["C".to_string()],
                basis: None,
            }));
        }
        let left_in_y = substitute_symbol(&left, &u_name, &div(sym(&dependent), sym(&independent)));
        let phi = simplify(sub(left_in_y, right));
        self.push(
            format!("{} = C", self.latex(&phi)),
            "积分得隐式通解",
            KIND_ALGEBRA,
        );
        self.note(format!(
            "通解是隐式形式 {} = C:内核未能把换元后的 {} 解出来,暂不按下发解曲线",
            self.latex(&phi),
            u_name
        ));
        Ok(Some(OdeSolution {
            explicit: None,
            implicit_phi: Some(phi),
            constants: vec!["C".to_string()],
            basis: None,
        }))
    }

    /// 一阶恰当:`M(x,y) + N(x,y) y' = 0` 且 `M_y = N_x`.
    fn try_exact(&mut self, _slope: &Expr) -> Result<Option<OdeSolution>, String> {
        // 恰当判定必须用**微分形式**的原始系数:斜率形式 `y' = -M/N` 会丢掉
        // 公共因子,判定结果不再等价.所以这里重新从 `y'` 的一次式取 M/N.
        let residual = self.residual.clone();
        let yp = format!("{}p", self.dependent);
        let Some((n_coeff, m_coeff)) = affine_in(&residual, &yp) else {
            return Ok(None);
        };
        if is_zero_function(&n_coeff) {
            return Ok(None);
        }
        let m = simplify(m_coeff);
        let n = simplify(n_coeff);
        let dependent = self.dependent.clone();
        let independent = self.independent.clone();
        let m_y = derivative(&m, &dependent).map_err(|error| format!("恰当判定失败: {error}"))?;
        let n_x = derivative(&n, &independent).map_err(|error| format!("恰当判定失败: {error}"))?;
        if !is_zero_function(&simplify(sub(m_y.clone(), n_x.clone()))) {
            return Ok(None);
        }
        self.push(
            format!(
                "\\frac{{\\partial M}}{{\\partial {}}} = {},\\quad \\frac{{\\partial N}}{{\\partial {}}} = {},\\quad \\text{{相等}}",
                dependent,
                self.latex(&m_y),
                independent,
                self.latex(&n_x)
            ),
            "恰当方程判定",
            KIND_CHECK,
        );
        let potential_part = if is_zero_function(&m) {
            num(0.0)
        } else {
            self.integrate(&m, &independent)?
        };
        let psi_prime = cancel_like_terms(&simplify(sub(
            n.clone(),
            derivative(&potential_part, &dependent).unwrap_or(num(0.0)),
        )));
        // 势函数只差一个 y 的函数:ψ' 必须与自变量无关(写法上的残留用数值
        // 对拍判,见 is_independent_of).
        if !is_independent_of(&psi_prime, &independent) {
            return Ok(None);
        }
        let psi = if is_zero_function(&psi_prime) {
            num(0.0)
        } else {
            self.integrate(&psi_prime, &dependent)?
        };
        let phi = simplify(add(potential_part, psi));
        self.push(
            format!("\\Phi(x, y) = {}", self.latex(&phi)),
            "求势函数",
            KIND_TABLE,
        );
        if let Some(explicit) = invert_dependent(&phi, &sym("C"), &dependent) {
            self.push(
                format!("{} = {}", dependent, self.latex(&explicit)),
                "解出通解",
                KIND_ALGEBRA,
            );
            return Ok(Some(OdeSolution {
                explicit: Some(explicit),
                implicit_phi: None,
                constants: vec!["C".to_string()],
                basis: None,
            }));
        }
        self.push("\\Phi(x, y) = C".to_string(), "隐式通解", KIND_DEFINITION);
        self.note(format!(
            "通解是隐式形式 {} = C:未解出 {},暂不按下发解曲线",
            self.latex(&phi),
            dependent
        ));
        Ok(Some(OdeSolution {
            explicit: None,
            implicit_phi: Some(phi),
            constants: vec!["C".to_string()],
            basis: None,
        }))
    }

    /// 二阶常系数齐次:`a y'' + b y' + c y = 0`,`a/b/c` 必须数值.
    fn solve_second_order(&mut self, residual: &Expr) -> Result<OdeSolution, String> {
        let dependent = self.dependent.clone();
        let independent = self.independent.clone();
        let yp = format!("{dependent}p");
        let ypp = format!("{dependent}pp");

        let constant = substitute_many(residual, &[(&ypp, 0.0), (&yp, 0.0), (&dependent, 0.0)]);
        let coeff_c = substitute_many(residual, &[(&ypp, 0.0), (&yp, 0.0), (&dependent, 1.0)]);
        let coeff_b = substitute_many(residual, &[(&ypp, 0.0), (&yp, 1.0), (&dependent, 0.0)]);
        let coeff_a = substitute_many(residual, &[(&ypp, 1.0), (&yp, 0.0), (&dependent, 0.0)]);
        let rebuilt = add(
            add(
                mul(coeff_a.clone(), sym(&ypp)),
                mul(coeff_b.clone(), sym(&yp)),
            ),
            add(mul(coeff_c.clone(), sym(&dependent)), constant.clone()),
        );
        if !is_zero_function(&simplify(sub(residual.clone(), rebuilt))) {
            return Err("方程不是二阶常系数线性形式:内核只支持 a·y'' + b·y' + c·y = 0".to_string());
        }
        if !is_zero_function(&constant) {
            return Err(
                "二阶常系数非齐次方程暂不在内核能力内(设计文档 4.3):请先做齐次方程".to_string(),
            );
        }
        for (name, coeff) in [("a", &coeff_a), ("b", &coeff_b), ("c", &coeff_c)] {
            if constant_number(coeff).is_none() {
                return Err(format!(
                    "二阶常系数齐次方程要求系数 {name} 是数值:符号系数下特征根类型无法判定,请把系数写成数值"
                ));
            }
        }
        let a = constant_number(&coeff_a).expect("已确认数值");
        let b = constant_number(&coeff_b).expect("已确认数值");
        let c = constant_number(&coeff_c).expect("已确认数值");
        if a == 0.0 {
            return Err("二阶方程的首项系数 a 不能为 0".to_string());
        }

        self.push(
            format!(
                "{} {}'' + \\left({}\\right) {}' + \\left({}\\right) {} = 0",
                latex_number(a),
                dependent,
                latex_number(b),
                dependent,
                latex_number(c),
                dependent
            ),
            "二阶常系数齐次标准形",
            KIND_DEFINITION,
        );
        self.push(
            format!(
                "{} \\lambda^{{2}} + \\left({}\\right) \\lambda + \\left({}\\right) = 0",
                latex_number(a),
                latex_number(b),
                latex_number(c)
            ),
            "特征方程",
            KIND_DEFINITION,
        );
        let discriminant = b * b - 4.0 * a * c;
        self.push(
            format!("\\Delta = b^{{2}} - 4ac = {}", latex_number(discriminant)),
            "判别式",
            KIND_NUMERIC,
        );

        let (y1, y2, root_latex, reason) = if discriminant > EPSILON {
            let sqrt_disc = discriminant.sqrt();
            let root1 = exact_ratio(-b + sqrt_disc, 2.0 * a, discriminant);
            let root2 = exact_ratio(-b - sqrt_disc, 2.0 * a, discriminant);
            let y1 = exp(mul(root1.clone(), sym(&independent)));
            let y2 = exp(mul(root2.clone(), sym(&independent)));
            (
                y1,
                y2,
                format!(
                    "\\lambda_1 = {},\\quad \\lambda_2 = {}",
                    self.latex(&root1),
                    self.latex(&root2)
                ),
                "两相异实根",
            )
        } else if discriminant.abs() <= EPSILON {
            let root = simplify(div(num(-b), num(2.0 * a)));
            let y1 = exp(mul(root.clone(), sym(&independent)));
            let y2 = mul(sym(&independent), y1.clone());
            (
                y1,
                y2,
                format!("\\lambda_1 = \\lambda_2 = {}", self.latex(&root)),
                "二重实根",
            )
        } else {
            let alpha = simplify(div(num(-b), num(2.0 * a)));
            let beta = exact_sqrt_ratio(-discriminant, 2.0 * a);
            let envelope = exp(mul(alpha.clone(), sym(&independent)));
            let y1 = mul(
                envelope.clone(),
                call("cos", vec![mul(beta.clone(), sym(&independent))]),
            );
            let y2 = mul(
                envelope,
                call("sin", vec![mul(beta.clone(), sym(&independent))]),
            );
            (
                y1,
                y2,
                format!(
                    "\\lambda = {} \\pm {} i",
                    self.latex(&alpha),
                    self.latex(&beta)
                ),
                "共轭复根",
            )
        };

        let c1 = sym("C_1");
        let c2 = sym("C_2");
        let general = simplify(add(mul(c1, y1.clone()), mul(c2, y2.clone())));
        self.push(root_latex, "特征根", KIND_RULE);
        let shape = match reason {
            "两相异实根" => format!(
                "{} = C_1 e^{{\\lambda_1 {}}} + C_2 e^{{\\lambda_2 {}}}",
                dependent, independent, independent
            ),
            "二重实根" => format!(
                "{} = \\left(C_1 + C_2 {}\\right) e^{{\\lambda {}}}",
                dependent, independent, independent
            ),
            _ => format!(
                "{} = e^{{\\alpha {}}}\\left(C_1 \\cos \\beta {} + C_2 \\sin \\beta {}\\right)",
                dependent, independent, independent, independent
            ),
        };
        self.push(shape, reason, KIND_RULE);
        self.push(
            format!("{} = {}", dependent, self.latex(&general)),
            "通解",
            KIND_ALGEBRA,
        );

        Ok(OdeSolution {
            explicit: Some(general),
            implicit_phi: None,
            constants: vec!["C_1".to_string(), "C_2".to_string()],
            basis: Some((y1, y2)),
        })
    }

    /// 生成一个不与方程里已有符号冲突的临时符号名.
    fn fresh_symbol(&self, base: &str) -> String {
        let mut names = symbols_of(&self.residual);
        names.extend(self.declared.iter().cloned());
        names.push(self.dependent.clone());
        names.push(self.independent.clone());
        let mut candidate = base.to_string();
        while names.iter().any(|name| name == &candidate) {
            candidate.push('_');
        }
        candidate
    }
}

/// 把 `yp`/`ypp` 换成展示名 `y'`/`y''`(只用于 LaTeX 打印).
fn prime_view_inner(expr: &Expr, first: &str, second: &str, dependent: &str) -> Expr {
    match expr {
        Expr::Sym(name) if name == first => Expr::Sym(format!("{dependent}'")),
        Expr::Sym(name) if name == second => Expr::Sym(format!("{dependent}''")),
        Expr::Num(_) | Expr::Sym(_) => expr.clone(),
        Expr::Unary(op, operand) => Expr::Unary(
            *op,
            Box::new(prime_view_inner(operand, first, second, dependent)),
        ),
        Expr::Binary(op, left, right) => Expr::Binary(
            *op,
            Box::new(prime_view_inner(left, first, second, dependent)),
            Box::new(prime_view_inner(right, first, second, dependent)),
        ),
        Expr::Call(name, args) => Expr::Call(
            name.clone(),
            args.iter()
                .map(|arg| prime_view_inner(arg, first, second, dependent))
                .collect(),
        ),
        Expr::List(items) => Expr::List(
            items
                .iter()
                .map(|item| prime_view_inner(item, first, second, dependent))
                .collect(),
        ),
    }
}

/// 特征根的准确形式:判别式是完全平方时给精确有理数,否则给浮点近似.
fn exact_ratio(numerator: f64, denominator: f64, discriminant: f64) -> Expr {
    if integer_sqrt(discriminant).is_some() {
        simplify(div(num(numerator), num(denominator)))
    } else {
        num(numerator / denominator)
    }
}

/// 复根虚部:被试数能开方时保留根式(`\sqrt{3}/2`),否则给浮点近似.
fn exact_sqrt_ratio(radicand: f64, denominator: f64) -> Expr {
    if let Some(root) = integer_sqrt(radicand) {
        return simplify(div(num(root as f64), num(denominator)));
    }
    if radicand.fract() == 0.0 && radicand > 0.0 {
        return simplify(div(call("sqrt", vec![num(radicand)]), num(denominator)));
    }
    num(radicand.sqrt() / denominator)
}

/// 幂次排版:整数不带小数点,分数用 `\frac`.
fn format_exponent(value: f64) -> String {
    if (value - value.round()).abs() < EPSILON {
        return format!("{}", value.round() as i64);
    }
    let denominator = 1.0 / value;
    if (denominator - denominator.round()).abs() < EPSILON && denominator.abs() < 1000.0 {
        return format!("1/{}", denominator.round() as i64);
    }
    format!("{value}")
}

fn latex_number(value: f64) -> String {
    super::latex::latex_number(value)
}

// ============================================================
// 初值条件
// ============================================================

/// 一条初值:槽位(0 = `y(x0)`,1 = `y'(x0)`)+ 取值点 + 取值.
struct InitialCondition {
    slot: usize,
    point: Expr,
    value: Expr,
    text: String,
}

fn parse_initial_conditions(
    conditions: &[String],
    dependent: &str,
) -> Result<Vec<InitialCondition>, String> {
    let mut parsed: Vec<InitialCondition> = Vec::new();
    for text in conditions {
        let (lhs_text, rhs_text) = split_top_level_eq(text)?;
        let (lhs_norm, _) = normalize_derivative_notation(lhs_text)?;
        let (rhs_norm, _) = normalize_derivative_notation(rhs_text)?;
        let lhs = parse_initial_lhs(&lhs_norm)?;
        let value = parse_expression(&rhs_norm)?;
        let (name, point) = match lhs {
            Expr::Call(name, args) if args.len() == 1 => (name, args[0].clone()),
            _ => {
                return Err(format!(
                "初值条件 `{text}` 必须写成 {dependent}(x0) = y0 或 {dependent}'(x0) = y0 的形式"
            ))
            }
        };
        let slot = if name == dependent {
            0
        } else if name == format!("{dependent}p") {
            1
        } else {
            return Err(format!(
                "初值条件 `{text}` 里的导数记号与因变量 {dependent} 不一致"
            ));
        };
        if constant_number(&point).is_none() {
            return Err(format!("初值点 `{}` 需要是数值", point));
        }
        // 右端可以是含参数的表达式(拖滑块时特解跟着变),但不能含因变量自己.
        if contains(&value, dependent) || contains(&value, &format!("{dependent}p")) {
            return Err(format!("初值 `{text}` 的右端不能含因变量 {dependent}"));
        }
        if parsed.iter().any(|existing| existing.slot == slot) {
            return Err(format!(
                "初值重复:`{text}` 与 `{}` 描述的是同一个初值",
                parsed
                    .iter()
                    .find(|existing| existing.slot == slot)
                    .map(|existing| existing.text.clone())
                    .unwrap_or_default()
            ));
        }
        parsed.push(InitialCondition {
            slot,
            point,
            value,
            text: text.trim().to_string(),
        });
    }
    Ok(parsed)
}

// ============================================================
// 回代验证
// ============================================================

/// 抽样求值:自变量取 `x`,其余符号取 `extra` 里的绑定或默认参数值.
fn eval_sample(expr: &Expr, independent: &str, x: f64, extra: &[(&str, f64)]) -> Option<f64> {
    let result = evaluate_with_lookup(expr, &|name: &str| -> Option<f64> {
        if name == independent {
            return Some(x);
        }
        for (bound, value) in extra {
            if *bound == name {
                return Some(*value);
            }
        }
        Some(VERIFY_PARAM_VALUE)
    });
    match result {
        Ok(Some(value)) if value.is_finite() => Some(value),
        _ => None,
    }
}

/// 项级对拍:各项求和并给出量级,`|Σ| <= tol · max|项|`.
fn sum_terms_zero(
    terms: &[(f64, Expr)],
    independent: &str,
    x: f64,
    extra: &[(&str, f64)],
) -> Option<bool> {
    let mut total = 0.0f64;
    let mut scale = 1.0f64;
    for (sign, term) in terms {
        let value = eval_sample(term, independent, x, extra)?;
        total += sign * value;
        scale = scale.max(value.abs());
    }
    Some(total.abs() <= VERIFY_TOLERANCE * scale)
}

/// 显式解验证:`y(x)` 与它的导数代回原方程.
fn verify_explicit(
    residual: &Expr,
    dependent: &str,
    independent: &str,
    solution: &Expr,
    order: usize,
) -> bool {
    let yp = format!("{dependent}p");
    let ypp = format!("{dependent}pp");
    let Ok(first) = derivative(solution, independent) else {
        return false;
    };
    let second = if order >= 2 {
        match derivative(&first, independent) {
            Ok(value) => value,
            Err(_) => return false,
        }
    } else {
        num(0.0)
    };
    let terms = flatten_sum(residual);
    let mut compared = 0usize;
    for sample in VERIFY_SAMPLES {
        let Some(y_value) = eval_sample(solution, independent, sample, &[]) else {
            continue;
        };
        let Some(first_value) = eval_sample(&first, independent, sample, &[]) else {
            continue;
        };
        let Some(second_value) = eval_sample(&second, independent, sample, &[]) else {
            continue;
        };
        let extra = [
            (dependent, y_value),
            (yp.as_str(), first_value),
            (ypp.as_str(), second_value),
        ];
        match sum_terms_zero(&terms, independent, sample, &extra) {
            Some(true) => compared += 1,
            Some(false) => return false,
            None => {}
        }
    }
    compared > 0
}

/// 隐式解验证:`Φ(x,y) = C` 的全导数为零,即 `Φ_x + Φ_y · f = 0`.
fn verify_implicit(dependent: &str, independent: &str, phi: &Expr, slope: &Expr) -> bool {
    let Ok(phi_x) = derivative(phi, independent) else {
        return false;
    };
    let Ok(phi_y) = derivative(phi, dependent) else {
        return false;
    };
    let total = simplify(add(phi_x, mul(phi_y.clone(), slope.clone())));
    let terms = flatten_sum(&total);
    let mut compared = 0usize;
    for sample in VERIFY_SAMPLES {
        for y_sample in VERIFY_DEPENDENT_SAMPLES {
            let extra = [(dependent, y_sample)];
            // Φ_y = 0 时隐式关系在该点不定义 y,跳过.
            match eval_sample(&phi_y, independent, sample, &extra) {
                Some(value) if value.abs() > EPSILON => {}
                _ => continue,
            }
            match sum_terms_zero(&terms, independent, sample, &extra) {
                Some(true) => compared += 1,
                Some(false) => return false,
                None => {}
            }
        }
    }
    compared > 0
}

// ============================================================
// WASM 入口对应的内核函数
// ============================================================

/// 求解一条微分方程.
///
/// `initial_conditions` 是**初值原文**(如 `y(0) = 1`),由语法层在首个顶层
/// 逗号处切好;`dependent`/`independent` 为空串表示从方程推断.
/// `declared_parameters` 只给名字不给值(参数保持符号,见文件头).
pub fn solve_ode(
    equation: &str,
    initial_conditions: &[String],
    dependent: Option<&str>,
    independent: Option<&str>,
    declared_parameters: &[String],
) -> Result<OdeOutcome, String> {
    let (lhs_text, rhs_text) = split_top_level_eq(equation)?;
    let (lhs_norm, mut marks) = normalize_derivative_notation(lhs_text)?;
    let (rhs_norm, rhs_marks) = normalize_derivative_notation(rhs_text)?;
    marks.extend(rhs_marks);

    let dependent_hint = dependent.map(str::trim).filter(|name| !name.is_empty());
    let dependent = match dependent_hint {
        Some(name) => name.to_string(),
        None => {
            let mut names: Vec<String> = marks.iter().map(|(name, _)| name.clone()).collect();
            names.sort();
            names.dedup();
            match names.len() {
                0 => return Err(
                    "方程里没有出现导数记号(如 y'):请写成微分方程,或用 dependent 选项指定因变量"
                        .to_string(),
                ),
                1 => names[0].clone(),
                _ => {
                    return Err(format!(
                        "方程里出现了多个因变量的导数记号({}):一个方程只能有一个因变量",
                        names.join(" / ")
                    ))
                }
            }
        }
    };

    for (name, _) in &marks {
        if name != &dependent {
            return Err(format!(
                "方程里出现了另一个因变量的导数记号 {name}':一个方程只能有一个因变量"
            ));
        }
    }
    let order = marks
        .iter()
        .filter(|(name, _)| name == &dependent)
        .map(|(_, order)| *order)
        .max()
        .unwrap_or(0);
    if order == 0 {
        return Err(format!("方程里没有出现 {dependent} 的导数记号"));
    }
    if order > 2 {
        return Err("内核只支持一阶与二阶微分方程".to_string());
    }
    let yp = format!("{dependent}p");
    let ypp = format!("{dependent}pp");

    let lhs = parse_expression(&lhs_norm)?;
    let rhs = parse_expression(&rhs_norm)?;
    let residual = simplify(sub(lhs.clone(), rhs.clone()));

    // 自变量缺省按坐标变量推断;常系数方程(如 `y'' + y = 0`)里根本不出现
    // 坐标变量,这时按**缺省自变量 x** 处理并留下明文说明--不静默,也不把
    // 教科书里最常见的写法逼成编译错误.
    let mut default_independent_note: Option<String> = None;
    let independent_hint = independent.map(str::trim).filter(|name| !name.is_empty());
    let independent = match independent_hint {
        Some(name) => {
            if name == dependent {
                return Err("自变量与因变量不能同名".to_string());
            }
            name.to_string()
        }
        None => {
            // `collect_symbols` 允许重复(同一符号出现多次),这里按名字去重.
            let mut candidates: Vec<String> = symbols_of(&residual)
                .into_iter()
                .filter(|name| name == "x" || name == "t")
                .collect();
            candidates.sort();
            candidates.dedup();
            match candidates.len() {
                1 => candidates[0].clone(),
                0 => {
                    default_independent_note = Some(
                        "方程里没有出现坐标变量,按缺省自变量 x 处理(可用 independent 选项显式指定)"
                            .to_string(),
                    );
                    "x".to_string()
                }
                _ => {
                    return Err(
                        "方程里同时出现了 x 与 t,无法推断自变量:请用 independent 选项指定"
                            .to_string(),
                    )
                }
            }
        }
    };

    for name in symbols_of(&residual) {
        if name == dependent
            || name == independent
            || name == yp
            || name == ypp
            || declared_parameters.iter().any(|declared| declared == &name)
        {
            continue;
        }
        return Err(format!(
            "微分方程含未声明符号 {name}:请先用 param 声明参数,或检查选项"
        ));
    }

    let equation_latex = {
        let view = prime_view_inner(&lhs, &yp, &ypp, &dependent);
        let lhs_latex = format_expr(&view, PrintMode::Latex, 0);
        let view = prime_view_inner(&rhs, &yp, &ypp, &dependent);
        let rhs_latex = format_expr(&view, PrintMode::Latex, 0);
        format!("{lhs_latex} = {rhs_latex}")
    };

    let mut solver = OdeSolver {
        dependent,
        independent,
        declared: declared_parameters,
        steps: Vec::new(),
        notes: Vec::new(),
        residual: residual.clone(),
    };
    if let Some(note) = default_independent_note {
        solver.note(note);
    }

    // 一阶:先把斜率 f(x,y) 解出来(P1-A 的斜率场要用),再逐类判定.
    let mut slope: Option<Expr> = None;
    if order == 1 {
        match affine_in(&residual, &yp) {
            Some((coeff, offset)) => {
                if is_zero(&coeff) {
                    return Ok(failure(
                        equation_latex,
                        &solver,
                        "方程不含 y' 项,无法作为一阶微分方程求解",
                        None,
                    ));
                }
                slope = Some(simplify(div(neg(offset), coeff)));
            }
            None => {
                return Ok(failure(
                    equation_latex,
                    &solver,
                    "方程里 y' 不是线性出现的:内核只支持 y' 的一次式",
                    None,
                ))
            }
        }
    }

    let solved = if order == 1 {
        match slope.clone() {
            Some(slope_expr) => solver.solve_with_slope(&slope_expr),
            None => unreachable!("一阶分支已保证斜率存在"),
        }
    } else {
        solver.solve_second_order(&residual)
    };

    let solution = match solved {
        Ok(solution) => solution,
        // 能力边界:题目照给,斜率场(一阶时)照给,理由进 error.
        Err(message) => return Ok(failure(equation_latex, &solver, &message, slope.as_ref())),
    };

    let conditions = parse_initial_conditions(initial_conditions, &solver.dependent)?;
    if order == 1 && conditions.iter().any(|condition| condition.slot != 0) {
        return Err("一阶方程只接受 y(x0) = y0 形式的初值".to_string());
    }
    if order == 2 && !conditions.is_empty() && conditions.len() != 2 {
        return Err("二阶方程需要两个初值:y(x0) = y0 与 y'(x0) = v0".to_string());
    }

    // 通解文本 / LaTeX.
    let (general_latex, general_text, implicit) = match &solution.explicit {
        Some(explicit) => (
            Some(format!("{} = {}", solver.dependent, solver.latex(explicit))),
            explicit.to_string(),
            false,
        ),
        None => {
            let phi = solution
                .implicit_phi
                .as_ref()
                .expect("既不是显式解也不是隐式解");
            (
                Some(format!("{} = C", solver.latex(phi))),
                String::new(),
                true,
            )
        }
    };

    // 特解:初值代入.
    let mut particular_latex: Option<String> = None;
    let mut particular_text = String::new();
    if !conditions.is_empty() {
        let slope_ref = slope.as_ref();
        match solve_constants(&mut solver, &solution, &conditions, slope_ref)? {
            Some((constants_latex, particular)) => {
                // 隐式解的特解写成 `Φ(x,y) = C0`,不写成 `y = C0`(那是错的).
                let particular_formula = match &particular {
                    Particular::Explicit(expr) => {
                        particular_text = expr.to_string();
                        format!("{} = {}", solver.dependent, solver.latex(expr))
                    }
                    Particular::ImplicitConstant(value) => {
                        let phi = solution.implicit_phi.as_ref().expect("隐式特解必有 Φ");
                        format!("{} = {}", solver.latex(phi), solver.latex(value))
                    }
                };
                particular_latex = Some(particular_formula.clone());
                for line in constants_latex {
                    solver.steps.push(line);
                }
                solver
                    .steps
                    .push(step(particular_formula, "代入常数得特解", KIND_ALGEBRA));
            }
            None => {
                solver.note(format!(
                    "初值 {} 无法定出积分常数,只给通解",
                    conditions
                        .iter()
                        .map(|condition| condition.text.clone())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
        }
    }

    // 回代验证(铁律 2).
    let verified = match (&solution.explicit, &solution.implicit_phi, order) {
        (Some(explicit), _, _) => verify_explicit(
            &residual,
            &solver.dependent,
            &solver.independent,
            explicit,
            order,
        ),
        (None, Some(phi), _) => verify_implicit(
            &solver.dependent,
            &solver.independent,
            phi,
            slope.as_ref().expect("一阶隐式解必有斜率"),
        ),
        (None, None, _) => false,
    };
    if !verified {
        let mut outcome = failure(
            equation_latex,
            &solver,
            "内核给出的解未通过回代验证,已拒绝(请报告这条方程)",
            slope.as_ref(),
        );
        outcome.order = order;
        return Ok(outcome);
    }

    // 验证步骤:显式解对自变量求导,隐式解走全导.
    let check_latex = match &solution.explicit {
        Some(explicit) => match derivative(explicit, &solver.independent) {
            Ok(derivative_expr) => format!(
                "{}' = {},\\quad \\text{{代回原方程成立}}",
                solver.dependent,
                solver.latex(&derivative_expr)
            ),
            Err(_) => "\\text{代回原方程成立}".to_string(),
        },
        None => "\\Phi_x + \\Phi_y f(x, y) = 0,\\quad \\text{代回原方程成立}".to_string(),
    };
    solver
        .steps
        .push(step(check_latex, "回代验证:代回原方程", KIND_CHECK));

    // 隐式解的说明由各分支给出(说清"为什么没解出 y / 没下发曲线"),
    // 这里不再叠一条同义提示:展示层的细节行已经固定标注"隐式解".
    let (slope_text, slope_latex) = match &slope {
        Some(slope_expr) => (slope_expr.to_string(), solver.latex(slope_expr)),
        None => (String::new(), String::new()),
    };

    Ok(OdeOutcome {
        equation_latex,
        independent: solver.independent.clone(),
        dependent: solver.dependent.clone(),
        order,
        general_latex,
        particular_latex,
        general_text,
        particular_text,
        implicit,
        arbitrary_constants: solution.constants.len(),
        constant_symbols: solution.constants.clone(),
        slope_text,
        slope_latex,
        verified,
        steps: solver.steps,
        error: None,
        notes: solver.notes,
    })
}

/// 能力边界结果:题目照给,解为空,理由进 `error`.
///
/// 一阶方程即使解不出来,右端 `f(x,y)` 仍然有效(它是方程本身的一部分),
/// 所以斜率场照给:学生至少能看见"这条方程的斜率长什么样".
fn failure(
    equation_latex: String,
    solver: &OdeSolver<'_>,
    message: &str,
    slope: Option<&Expr>,
) -> OdeOutcome {
    let (slope_text, slope_latex) = match slope {
        Some(expr) => (expr.to_string(), solver.latex(expr)),
        None => (String::new(), String::new()),
    };
    OdeOutcome {
        equation_latex,
        independent: solver.independent.clone(),
        dependent: solver.dependent.clone(),
        order: 0,
        general_latex: None,
        particular_latex: None,
        general_text: String::new(),
        particular_text: String::new(),
        implicit: false,
        arbitrary_constants: 0,
        constant_symbols: Vec::new(),
        slope_text,
        slope_latex,
        verified: false,
        steps: Vec::new(),
        error: Some(message.to_string()),
        notes: solver.notes.clone(),
    }
}

/// 由初值定出的特解形态.
///
/// 显式解与隐式解的"特解"写法不同:显式解是 `y = ...`,隐式解是 `Φ(x,y) = C0`
/// (`C0` 是初值算出的常数取值).混在一起会让隐式解的公式排成 `y = 3.7`
/// 这种**错的**式子(实测踩过),所以这里显式区分.
enum Particular {
    /// 显式特解 `y = <表达式>`.
    Explicit(Expr),
    /// 隐式特解:常数取值(通解写作 `Φ(x,y) = C`).
    ImplicitConstant(Expr),
}

/// 由初值定出积分常数,并给出特解.
///
/// 返回 `None` 表示定不出来(如 `C` 的系数为零):调用方如实说明,不当错误.
fn solve_constants(
    solver: &mut OdeSolver<'_>,
    solution: &OdeSolution,
    conditions: &[InitialCondition],
    _slope: Option<&Expr>,
) -> Result<Option<(Vec<OdeStep>, Particular)>, String> {
    let dependent = solver.dependent.clone();
    let independent = solver.independent.clone();
    let Some(explicit) = &solution.explicit else {
        // 隐式解:Φ(x0,y0) = C 直接代入即可(不解 y).
        let phi = solution.implicit_phi.as_ref().expect("隐式解必有 Φ");
        let condition = conditions.first().expect("调用方已确认有初值");
        let point = constant_number(&condition.point).expect("初值点已确认数值");
        let value = constant_number(&condition.value).expect("初值已确认数值");
        let substituted = substitute_many(phi, &[(&independent, point), (&dependent, value)]);
        let mut steps = Vec::new();
        steps.push(step(
            format!(
                "{}\\left({}\\right) = {}",
                dependent,
                solver.latex(&condition.point),
                solver.latex(&condition.value)
            ),
            "代入初值",
            KIND_SUBSTITUTE,
        ));
        steps.push(step(
            format!("C = {}", solver.latex(&substituted)),
            "解出积分常数",
            KIND_ALGEBRA,
        ));
        return Ok(Some((steps, Particular::ImplicitConstant(substituted))));
    };

    if solution.constants.len() == 1 {
        let condition = conditions.first().expect("调用方已确认有初值");
        let point = constant_number(&condition.point).expect("初值点已确认数值");
        // 解对常数 `C` 是一次式(各分支都是这么构造的):`y = A + (B-A) C`,
        // 于是 `C = (y0 - A)/(B - A)`.`A`/`B` 允许含参数(拖滑块时特解跟着变),
        // 所以这里走符号式而不是先求数值.
        let at_zero = simplify(fold_initial_substitution(&substitute_many(
            explicit,
            &[(&independent, point), ("C", 0.0)],
        )));
        let at_one = simplify(fold_initial_substitution(&substitute_many(
            explicit,
            &[(&independent, point), ("C", 1.0)],
        )));
        // `span = B - A` 里会有写法上残留的同项(`q/p + 1 - q/p`),积分器/
        // 化简器不做同类项合并,这里用数值恒等抵消把它们收干净.
        let span = cancel_like_terms(&simplify(sub(at_one, at_zero.clone())));
        if is_zero_function(&span) {
            return Ok(None);
        }
        let constant =
            cancel_like_terms(&simplify(div(sub(condition.value.clone(), at_zero), span)));
        let particular = simplify(substitute_symbol(explicit, "C", &constant));
        let mut steps = Vec::new();
        steps.push(step(
            format!(
                "{}\\left({}\\right) = {}",
                dependent,
                solver.latex(&condition.point),
                solver.latex(&condition.value)
            ),
            "代入初值",
            KIND_SUBSTITUTE,
        ));
        steps.push(step(
            format!("C = {}", solver.latex(&constant)),
            "解出积分常数",
            KIND_ALGEBRA,
        ));
        return Ok(Some((steps, Particular::Explicit(particular))));
    }

    // 二阶:y = C_1 y_1 + C_2 y_2,两个初值给出 2x2 线性方程组.
    let Some((y1, y2)) = solution.basis.clone() else {
        return Ok(None);
    };
    let mut point = None;
    let mut value = None;
    let mut slope_value = None;
    for condition in conditions {
        let x = constant_number(&condition.point).expect("初值点已确认数值");
        // 二阶的 2x2 方程组要数值系数:初值含参数时如实说明"定不出常数"
        // (滑块拖不动的公式还不如不给).
        let Some(v) = constant_number(&condition.value) else {
            return Ok(None);
        };
        if condition.slot == 0 {
            point = Some(x);
            value = Some(v);
        } else {
            slope_value = Some((x, v));
        }
    }
    let (Some(x), Some(y0)) = (point, value) else {
        return Ok(None);
    };
    let Some((x_slope, v0)) = slope_value else {
        return Ok(None);
    };
    if (x - x_slope).abs() > EPSILON {
        return Ok(None);
    }
    let d1 = derivative(&y1, &independent).map_err(|error| error.to_string())?;
    let d2 = derivative(&y2, &independent).map_err(|error| error.to_string())?;
    let (Some(a11), Some(a21)) = (
        eval_constant_at(&y1, &independent, x),
        eval_constant_at(&d1, &independent, x),
    ) else {
        return Ok(None);
    };
    let (Some(a12), Some(a22)) = (
        eval_constant_at(&y2, &independent, x),
        eval_constant_at(&d2, &independent, x),
    ) else {
        return Ok(None);
    };
    let determinant = a11 * a22 - a12 * a21;
    if determinant.abs() < EPSILON {
        return Ok(None);
    }
    let c1 = (y0 * a22 - v0 * a12) / determinant;
    let c2 = (a11 * v0 - a21 * y0) / determinant;
    let particular = substitute_many(explicit, &[("C_1", c1), ("C_2", c2)]);
    let mut steps = Vec::new();
    steps.push(step(
        format!(
            "\\begin{{cases}} {} = {} \\\\ {}' = {} \\end{{cases}}",
            dependent,
            solver.latex(&conditions[0].value),
            dependent,
            solver.latex(&conditions[1].value)
        ),
        "代入两个初值",
        KIND_SUBSTITUTE,
    ));
    steps.push(step(
        format!(
            "C_1 = {},\\quad C_2 = {}",
            latex_number(c1),
            latex_number(c2)
        ),
        "解出两个积分常数",
        KIND_ALGEBRA,
    ));
    Ok(Some((steps, Particular::Explicit(particular))))
}

fn eval_constant_at(expr: &Expr, independent: &str, value: f64) -> Option<f64> {
    eval_sample(expr, independent, value, &[])
}

// ============================================================
// 单测
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn solve(equation: &str) -> OdeOutcome {
        solve_ode(equation, &[], None, None, &[]).expect("方程应能解析")
    }

    fn solve_with_initial(equation: &str, initial: &[&str]) -> OdeOutcome {
        let conditions: Vec<String> = initial.iter().map(|text| text.to_string()).collect();
        solve_ode(equation, &conditions, None, None, &[]).expect("方程应能解析")
    }

    fn declared(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    // ---- 导数记号归一 ----

    #[test]
    fn normalizes_derivative_marks_with_identifier_boundaries() {
        let (text, marks) = normalize_derivative_notation("a*y' + y'' = y_1'").unwrap();
        assert_eq!(text, "a*yp + ypp = y_1p");
        assert_eq!(
            marks,
            vec![
                ("y".to_string(), 1),
                ("y".to_string(), 2),
                ("y_1".to_string(), 1)
            ]
        );
    }

    #[test]
    fn rejects_third_derivative_and_name_collisions() {
        let error = normalize_derivative_notation("y''' = 1").unwrap_err();
        assert!(error.contains("超过二阶"), "{error}");
        // 源码里已有普通符号 yp:归一化会撞名,必须报错而不是静默读错.
        let error = normalize_derivative_notation("y' = yp").unwrap_err();
        assert!(error.contains("冲突"), "{error}");
        // 参数 a 与导数记号相邻(`a*y'`)不能被朴素替换读错.
        let (text, _) = normalize_derivative_notation("a*y' = 2").unwrap();
        assert_eq!(text, "a*yp = 2");
    }

    // ---- 一阶可分离 ----

    #[test]
    fn solves_separable_equation_explicitly() {
        let outcome = solve("y' = x*y");
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
        assert!(!outcome.implicit);
        assert_eq!(outcome.order, 1);
        assert_eq!(outcome.arbitrary_constants, 1);
        assert!(
            outcome.general_text.contains('C'),
            "{}",
            outcome.general_text
        );
        assert!(outcome.general_latex.is_some());
    }

    #[test]
    fn separable_with_parameter_keeps_symbolic_parameter() {
        let outcome = solve_ode("y' = a*y", &[], None, None, &declared(&["a"])).unwrap();
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
        assert!(
            outcome.general_text.contains('a'),
            "参数必须保持符号: {}",
            outcome.general_text
        );
        assert!(outcome.slope_text.contains('a'), "{}", outcome.slope_text);
    }

    #[test]
    fn separable_without_explicit_inverse_is_implicit_and_verified() {
        // `∫(y^2+1)dy = y^3/3 + y` 解不出显式 y,是真正的隐式解.
        let outcome = solve("y' = 1/(y^2+1)");
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
        assert!(outcome.implicit);
        assert!(outcome.general_text.is_empty());
        assert!(!outcome.notes.is_empty());
    }

    // ---- 一阶线性 ----

    #[test]
    fn solves_linear_first_order_with_symbolic_coefficients() {
        let outcome = solve_ode("y' + p*y = q", &[], None, None, &declared(&["p", "q"])).unwrap();
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
        assert!(
            outcome.general_text.contains('p'),
            "{}",
            outcome.general_text
        );
        assert!(
            outcome.general_text.contains('q'),
            "{}",
            outcome.general_text
        );
        // 斜率场就是右端 q - p*y.
        assert!(outcome.slope_text.contains('p'));
        assert!(outcome.slope_text.contains('q'));
        assert_eq!(outcome.steps.last().unwrap().kind, KIND_CHECK);
    }

    #[test]
    fn linear_with_constant_coefficients_matches_textbook_solution() {
        let outcome = solve("y' - y = 0");
        assert!(outcome.verified);
        assert!(
            outcome.general_text.contains("exp"),
            "{}",
            outcome.general_text
        );
    }

    #[test]
    fn direct_integration_of_x_only_right_hand_side() {
        let outcome = solve("y' = x^2");
        assert!(outcome.verified);
        assert!(
            outcome.general_text.contains("x ^ 3") || outcome.general_text.contains("x^3"),
            "{}",
            outcome.general_text
        );
    }

    // ---- Bernoulli ----

    #[test]
    fn solves_bernoulli_equation() {
        let outcome = solve("y' + y = y^2");
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
        assert!(!outcome.implicit);
        assert!(outcome.general_text.contains('y') || outcome.general_text.contains("exp"));
    }

    #[test]
    fn bernoulli_with_symbolic_coefficients() {
        let outcome =
            solve_ode("y' + p*y = q*y^2", &[], None, None, &declared(&["p", "q"])).unwrap();
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
        assert!(
            outcome.general_text.contains('p'),
            "{}",
            outcome.general_text
        );
    }

    // ---- 齐次 ----

    #[test]
    fn solves_homogeneous_equation() {
        let outcome = solve("y' = (x^2 + y^2)/(x*y)");
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
    }

    #[test]
    fn homogeneous_simple_case_gives_linear_family() {
        let outcome = solve("y' = y/x");
        assert!(outcome.verified, "{:?}", outcome.error);
        assert!(outcome.general_text.contains('C'));
    }

    // ---- 恰当 ----

    #[test]
    fn solves_exact_equation_implicitly() {
        let outcome = solve("(2*x*y + cos(x)) + (x^2 + y)*y' = 0");
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
        assert!(outcome.implicit);
        assert!(outcome.general_latex.unwrap().contains("C"));
    }

    // ---- 二阶常系数齐次 ----

    #[test]
    fn solves_second_order_distinct_real_roots_with_initial_values() {
        let outcome = solve_with_initial("y'' - 3*y' + 2*y = 0", &["y(0) = 0", "y'(0) = 1"]);
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
        assert_eq!(outcome.order, 2);
        assert_eq!(outcome.arbitrary_constants, 2);
        assert!(
            outcome.particular_text.contains("exp"),
            "{}",
            outcome.particular_text
        );
        // -e^x + e^{2x} 在 x=1 处约 4.67.
        let y = parse_expression(&outcome.particular_text).unwrap();
        let value = eval_sample(&y, "x", 1.0, &[]).unwrap();
        assert!((value - (-std::f64::consts::E + std::f64::consts::E.powi(2))).abs() < 1e-9);
    }

    #[test]
    fn solves_second_order_repeated_root() {
        let outcome = solve("y'' - 2*y' + y = 0");
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
        assert!(outcome.general_text.contains('x'));
    }

    #[test]
    fn solves_second_order_complex_roots() {
        let outcome = solve("y'' + y = 0");
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
        assert!(outcome.general_text.contains("cos"));
        assert!(outcome.general_text.contains("sin"));
    }

    // ---- 初值 ----

    #[test]
    fn initial_value_fixes_the_constant() {
        let outcome = solve_with_initial("y' = x*y", &["y(0) = 1"]);
        assert!(outcome.verified);
        assert!(
            !outcome.particular_text.contains('C'),
            "{}",
            outcome.particular_text
        );
        let y = parse_expression(&outcome.particular_text).unwrap();
        let value = eval_sample(&y, "x", 0.0, &[]).unwrap();
        assert!((value - 1.0).abs() < 1e-9);
    }

    #[test]
    fn implicit_particular_is_written_as_relation_not_y_equals_constant() {
        // 隐式解 + 初值:特解必须是 `Φ(x,y) = C0`,不能排成 `y = C0`.
        let outcome = solve_with_initial("y' = 1/(y^2+1)", &["y(0) = 1"]);
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.implicit);
        assert!(outcome.verified);
        let particular = outcome.particular_latex.expect("初值应给出特解");
        assert!(!particular.starts_with("y ="), "{particular}");
        // 隐式特解不是可求值的 y=f(x):不下发解曲线.
        assert!(outcome.particular_text.is_empty());
    }

    #[test]
    fn logistic_equation_is_expanded_and_solved_explicitly() {
        // `y*(1-y)` 是指数形式:不展开就判不出伯努利,会掉到"隐式解".
        let outcome = solve("y' = y*(1-y)");
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(!outcome.implicit);
        assert!(outcome.verified);
        assert!(
            outcome.general_text.contains("exp"),
            "{}",
            outcome.general_text
        );
    }

    #[test]
    fn symbolic_coefficients_with_initial_value_still_give_particular() {
        // 参数保持符号时初值也要能定出常数(特解里应含 p/q).
        let conditions = vec!["y(0) = 1".to_string()];
        let outcome = solve_ode(
            "y' + p*y = q",
            &conditions,
            None,
            None,
            &declared(&["p", "q"]),
        )
        .unwrap();
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
        assert!(
            outcome.particular_text.contains('p'),
            "{}",
            outcome.particular_text
        );
        assert!(
            outcome.particular_text.contains('q'),
            "{}",
            outcome.particular_text
        );
        // 特解在 x=0 处应等于 1(数值抽样,参数取默认 1.25).
        let y = parse_expression(&outcome.particular_text).unwrap();
        let value = eval_sample(&y, "x", 0.0, &[]).unwrap();
        assert!((value - 1.0).abs() < 1e-9, "{value}");
    }

    #[test]
    fn duplicate_initial_value_is_a_clear_error() {
        let error = solve_ode(
            "y' = x*y",
            &["y(0) = 1".to_string(), "y(0) = 2".to_string()],
            None,
            None,
            &[],
        )
        .unwrap_err();
        assert!(error.contains("初值重复"), "{error}");
    }

    // ---- 能力边界与输入错误 ----

    #[test]
    fn unsupported_equation_reports_capability_error() {
        let outcome = solve("y' = sin(x^2)");
        assert!(outcome.error.is_some());
        assert!(outcome.general_latex.is_none());
        assert!(!outcome.verified);
    }

    #[test]
    fn non_homogeneous_second_order_is_out_of_scope() {
        let outcome = solve("y'' + y = sin(x)");
        assert!(outcome.error.is_some(), "{:?}", outcome.error);
        assert!(outcome.general_latex.is_none());
    }

    #[test]
    fn symbolic_second_order_coefficients_are_out_of_scope() {
        let outcome = solve_ode("y'' + k*y = 0", &[], None, None, &declared(&["k"])).unwrap();
        assert!(outcome.error.is_some());
        assert!(outcome.general_latex.is_none());
    }

    #[test]
    fn independent_variable_defaults_to_x_and_ambiguity_is_an_error() {
        // 常系数方程里不出现坐标变量:按缺省自变量 x 处理,并留下明文说明.
        let outcome = solve_ode("y' = y", &[], None, None, &[]).unwrap();
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert_eq!(outcome.independent, "x");
        assert!(outcome.notes.iter().any(|note| note.contains("缺省自变量")));

        // x 与 t 同时出现:不猜,直接报错.
        let error = solve_ode("y' = x*y + t*y", &[], None, None, &[]).unwrap_err();
        assert!(error.contains("同时出现了 x 与 t"), "{error}");

        // 显式给 independent 之后可以用参数 t.
        let outcome = solve_ode("y' = t*y", &[], None, Some("t"), &[]).unwrap();
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert_eq!(outcome.independent, "t");
    }

    #[test]
    fn explicit_variable_options_work() {
        let outcome = solve_ode("u' = x*u", &[], Some("u"), Some("x"), &[]).unwrap();
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert_eq!(outcome.dependent, "u");
    }

    #[test]
    fn undeclared_symbol_is_rejected() {
        let error = solve_ode("y' = k*y", &[], None, None, &[]).unwrap_err();
        assert!(error.contains("未声明符号 k"), "{error}");
    }

    // ---- 每类第二条例子(第 3.1 节:每类至少 2 例) ----

    #[test]
    fn solves_separable_second_example() {
        let outcome = solve("y' = 2*x*y^2");
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
        assert!(!outcome.implicit);
    }

    #[test]
    fn solves_linear_second_example() {
        let outcome = solve("y' - y = x");
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
        assert!(outcome.general_text.contains('x'));
    }

    #[test]
    fn solves_bernoulli_second_example() {
        let outcome = solve("y' = y/x + x*y^2");
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
    }

    #[test]
    fn solves_homogeneous_second_example() {
        let outcome = solve("y' = (2*x*y)/(x^2 - y^2)");
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
    }

    #[test]
    fn solves_exact_second_example() {
        let outcome = solve("(y*cos(x) + 2*x*e^y) + (sin(x) + x^2*e^y)*y' = 0");
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(outcome.verified);
        assert!(outcome.implicit);
    }

    /// 超长输入不给 panic,只给可读错误(编码规范第 5 条).
    #[test]
    fn oversized_equation_reports_error_without_panic() {
        let long = std::iter::repeat_n("x", 400)
            .collect::<Vec<_>>()
            .join(" + ");
        let equation = format!("y' = {long}");
        match solve_ode(&equation, &[], None, None, &[]) {
            Ok(outcome) => {
                assert!(outcome.error.is_some() || outcome.verified);
            }
            Err(message) => assert!(!message.is_empty()),
        }
    }

    #[test]
    fn slope_is_extracted_from_general_form() {
        let outcome = solve("y' + 2*y = 3");
        assert!(outcome.slope_text.contains('3') && outcome.slope_text.contains('y'));
        let slope = parse_expression(&outcome.slope_text).unwrap();
        // f(x, y) = 3 - 2y:在 y = 1 处是 1.
        let value = eval_sample(&slope, "x", 0.0, &[("y", 1.0)]).unwrap();
        assert!((value - 1.0).abs() < 1e-9);
        assert!(!outcome.slope_latex.is_empty());
    }
}
