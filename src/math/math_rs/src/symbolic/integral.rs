//! 不定积分(原函数)内核:系统化初等积分 + 回代验证.
//!
//! 产物是**独立类型** [`AntiderivativeOutcome`] / [`AntiderivativeStep`]:只有
//! 字符串与计数,不含 `Expr`(符号引擎内部表示不越过这一层,路线图 §7.1 的
//! 口径与 `solve.rs` 一致).
//!
//! 策略(自顶向下逐层回退,见 docs/calculus-suite-plan.md 第 3 节):
//! 1. **线性性**:和差拆项,常数因子提出;
//! 2. **基本公式表**:`x^n` / `1/x` / `e^u` / 三角 / `1/(1+u^2)` 等(含线性内核);
//! 3. **有理函数**:多项式除法 -> 有理根因式分解 -> 部分分式(小规模消元);
//! 4. **根式基本形**:`1/sqrt(1-u^2)` -> asin,`sqrt(1-u^2)` -> 圆面积公式;
//! 5. **分部积分**:LIATE 选 `u`,步数有上限(防不收敛);
//! 6. **三角幂**:`sin^m` / `cos^m` 的奇次拆分与偶次降幂.
//!
//! 行为契约:
//! - **结果一律回代验证**:对原函数再符号求导,与被积函数抽样对拍,不过就走
//!   `error` 通道.**绝不给错误原函数**;
//! - 已知非初等(`e^{x^2}`,`sin(x^2)`)给专门文案并引导走数值 `integral`;
//! - 能力边界错误是**结果的一部分**(`error: Some`),不是调用失败;`Err` 只留给
//!   "表达式读不出来 / 变量为空 / 系数表坏掉"这类真正的输入错误;
//! - 所有入口不 panic;预算(分部层数/递归深度/有理函数次数)超限给可读错误;
//! - 结果表达式**不含积分常数**:`C` 只活在展示层与下发对象的取值里,这样
//!   `antiderivative_text` 可以直接喂数值求值路径;
//! - 结果里的参数**已折叠成数值**:参数走与积分/分析/求解同一条系数链路,
//!   拖动滑块会让整条表达式重算(与 `Poly::from_expr` 的求解口径一致).

use std::collections::HashMap;

use serde::Serialize;

use super::derivative::derivative;
use super::eval::evaluate_with_lookup;
use super::latex::latex_symbol;
use super::parser::{parse_expr, rewrite_aliases, validate_supported};
use super::simplify::{evaluate_constant, simplify};
use super::{BinOp, Expr, UnaryOp};

/// 依据分区:与 `ir::SOLVE_STEP_KINDS` 同域.
const KIND_TABLE: &str = "table";
const KIND_ALGEBRA: &str = "algebra";
const KIND_SUBSTITUTE: &str = "substitute";
const KIND_DEFINITION: &str = "definition";
const KIND_CHECK: &str = "check";

/// 原函数推导的一步:一行 LaTeX + 依据文案 + 依据分区.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AntiderivativeStep {
    pub latex: String,
    pub reason: String,
    pub kind: String,
}

/// 一条不定积分的结果.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AntiderivativeOutcome {
    /// 被积函数 LaTeX(题目,参数已折叠成数值).
    pub integrand_latex: String,
    /// 原函数 LaTeX(**不含** `+C`,常数由展示层拼).
    pub antiderivative_latex: String,
    /// 原函数表达式(归一化后字符串,可直接求值;不含常数).
    pub antiderivative_text: String,
    /// 回代验证是否通过.
    pub verified: bool,
    pub steps: Vec<AntiderivativeStep>,
    /// 能力边界理由;`None` 表示成功.
    pub error: Option<String>,
}

/// 积分常数符号(展示层拼 `+C` 用;内核表达式里不出现).
#[allow(dead_code)] // 展示层用;WASM 边界不导出该常量
pub const CONSTANT_SYMBOL: &str = "C";

/// 分部的最大层数:超过就报"超出内核预算",不做无尽回退.
const MAX_PARTS_DEPTH: usize = 4;
/// 递归总深度预算(换元/拆项/分部共用一个计数).
const MAX_DEPTH: usize = 24;
/// 有理函数部分分式接受的最高次数.
const MAX_RATIONAL_DEGREE: usize = 6;
/// 配方法里用来判断"零常数项"的容差.
const EPSILON: f64 = 1e-9;
/// 抽样验证的参数替换值(避开 0/1 这类会让部分函数退化的值).
const VERIFY_PARAM_VALUE: f64 = 1.25;
/// 抽样点(`x` 取值);避开 0 与整数,减少掩盖错误的巧合.
const VERIFY_SAMPLES: [f64; 5] = [0.37, 1.13, -0.61, 2.29, -1.73];
/// 数值对拍的相对容差.
const VERIFY_TOLERANCE: f64 = 1e-7;

fn step(latex: impl Into<String>, reason: &str, kind: &str) -> AntiderivativeStep {
    AntiderivativeStep {
        latex: latex.into(),
        reason: reason.to_string(),
        kind: kind.to_string(),
    }
}

/// 求 `expr` 对 `variable` 的原函数.
///
/// `coefficients` 是参数名 -> 当前值(与积分/分析/求解同一条系数链路).
pub fn antiderivative(
    expr: &str,
    variable: &str,
    coefficients: &HashMap<String, f64>,
) -> Result<AntiderivativeOutcome, String> {
    let declared: Vec<String> = coefficients.keys().cloned().collect();
    antiderivative_with_parameters(expr, variable, coefficients, &declared)
}

/// 与 [`antiderivative`] 同,但显式给出"已声明参数名"(可以不带数值).
///
/// 只给名字时参数**保持符号**:调用方(静态场景蓝图)靠它把原函数写成含参数的
/// 表达式,再让物化层按当前滑块折叠;见 [`IntegrationState::declared_parameters`].
pub fn antiderivative_with_parameters(
    expr: &str,
    variable: &str,
    coefficients: &HashMap<String, f64>,
    declared_parameters: &[String],
) -> Result<AntiderivativeOutcome, String> {
    let variable = variable.trim();
    if variable.is_empty() {
        return Err("积分变量不能为空".to_string());
    }
    let parsed = parse_expr(expr)?;
    let integrand = simplify(rewrite_aliases(&parsed)?);
    validate_supported(&integrand)?;

    let mut state = IntegrationState {
        variable: variable.to_string(),
        coefficients,
        declared_parameters,
        steps: Vec::new(),
        parts_depth: 0,
    };
    Ok(state.run(&integrand))
}

// ============================================================
// 表达式小工具
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

/// 子树里是否出现积分变量.
fn contains_var(expr: &Expr, variable: &str) -> bool {
    match expr {
        Expr::Num(_) => false,
        Expr::Sym(name) => name == variable,
        Expr::Unary(_, operand) => contains_var(operand, variable),
        Expr::Binary(_, left, right) => {
            contains_var(left, variable) || contains_var(right, variable)
        }
        Expr::Call(_, args) => args.iter().any(|arg| contains_var(arg, variable)),
        Expr::List(items) => items.iter().any(|item| contains_var(item, variable)),
    }
}

/// 是不是"看起来像未知量"的自由符号.
///
/// 参数(`a`/`k`)在积分里是常数,但**未声明的自由符号**必须报错而不是静默当
/// 常数:那会把 `∫ y dx` 悄悄算成 `y*x`.判定与 `solve.rs` 同口径--自由符号
/// 要么是积分变量,要么必须在系数表里.
fn unknown_symbol(
    expr: &Expr,
    variable: &str,
    coefficients: &HashMap<String, f64>,
    declared_parameters: &[String],
) -> Option<String> {
    match expr {
        Expr::Num(_) => None,
        Expr::Sym(name) => {
            if name == variable
                || coefficients.contains_key(name)
                || declared_parameters.iter().any(|declared| declared == name)
            {
                None
            } else {
                Some(name.clone())
            }
        }
        Expr::Unary(_, operand) => {
            unknown_symbol(operand, variable, coefficients, declared_parameters)
        }
        Expr::Binary(_, left, right) => {
            unknown_symbol(left, variable, coefficients, declared_parameters)
                .or_else(|| unknown_symbol(right, variable, coefficients, declared_parameters))
        }
        Expr::Call(_, args) => args
            .iter()
            .find_map(|arg| unknown_symbol(arg, variable, coefficients, declared_parameters)),
        Expr::List(items) => items
            .iter()
            .find_map(|item| unknown_symbol(item, variable, coefficients, declared_parameters)),
    }
}

/// 把参数名替换成当前数值(只替换,不求值).
fn substitute_coefficients(expr: &Expr, coefficients: &HashMap<String, f64>) -> Expr {
    match expr {
        Expr::Sym(name) => match coefficients.get(name) {
            Some(value) => num(*value),
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

/// 常量子表达式的数值:先代入参数值,再走求值内核.
fn constant_value(expr: &Expr, coefficients: &HashMap<String, f64>) -> Result<f64, String> {
    let substituted = substitute_coefficients(expr, coefficients);
    match evaluate_constant(&substituted) {
        Ok(Some(value)) if value.is_finite() => Ok(value),
        Ok(_) => Err("积分里出现非有限数值(如 1/0)".to_string()),
        Err(message) => Err(message),
    }
}

/// 常数表达式的数值;非常数或非有限返回 `None`.
fn constant_or_none(expr: &Expr, coefficients: &HashMap<String, f64>) -> Option<f64> {
    constant_value(expr, coefficients).ok()
}

/// 一元一次式 `a*x + b` 的 `(a, b)`(对积分变量而言);不是一次式返回 `None`.
fn linear_parts(expr: &Expr, variable: &str) -> Option<(Expr, Expr)> {
    match expr {
        Expr::Sym(name) if name == variable => Some((num(1.0), num(0.0))),
        Expr::Num(_) => Some((num(0.0), expr.clone())),
        Expr::Sym(_) => Some((num(0.0), expr.clone())),
        Expr::Unary(UnaryOp::Neg, operand) => {
            let (a, b) = linear_parts(operand, variable)?;
            Some((neg(a), neg(b)))
        }
        Expr::Binary(BinOp::Add, left, right) => {
            let (a1, b1) = linear_parts(left, variable)?;
            let (a2, b2) = linear_parts(right, variable)?;
            Some((add(a1, a2), add(b1, b2)))
        }
        Expr::Binary(BinOp::Sub, left, right) => {
            let (a1, b1) = linear_parts(left, variable)?;
            let (a2, b2) = linear_parts(right, variable)?;
            Some((sub(a1, a2), sub(b1, b2)))
        }
        Expr::Binary(BinOp::Mul, left, right) => {
            let left_constant = !contains_var(left, variable);
            let right_constant = !contains_var(right, variable);
            match (left_constant, right_constant) {
                (true, false) => {
                    let (a, b) = linear_parts(right, variable)?;
                    Some((mul(left.as_ref().clone(), a), mul(left.as_ref().clone(), b)))
                }
                (false, true) => {
                    let (a, b) = linear_parts(left, variable)?;
                    Some((
                        mul(right.as_ref().clone(), a),
                        mul(right.as_ref().clone(), b),
                    ))
                }
                (true, true) => {
                    // 两侧都与积分变量无关:`2 * 1` / `2 * 3` 这类未折叠的数值
                    // 乘积要在这里折成常数项,否则斜率会以 `2 * 1` 的形状漏过
                    // "非零"判定,线性内核整条失效(实测踩过).
                    let (left_slope, left_offset) = linear_parts(left, variable)?;
                    let (right_slope, right_offset) = linear_parts(right, variable)?;
                    if !is_numeric_zero(&left_slope) || !is_numeric_zero(&right_slope) {
                        return None;
                    }
                    Some((num(0.0), mul(left_offset, right_offset)))
                }
                _ => None,
            }
        }
        Expr::Binary(BinOp::Div, numerator, denominator) => {
            if contains_var(denominator, variable) {
                return None;
            }
            let (a, b) = linear_parts(numerator, variable)?;
            let d = denominator.as_ref().clone();
            Some((div(a.clone(), d.clone()), div(b, d)))
        }
        _ => None,
    }
}

/// 斜率是否为"真正的一次项系数"(含变量,或数值非零).
///
/// 这里**必须**先代入求值再判断:`linear_parts` 里的 `a*x` 会产出 `2 * 1`
/// 这类未折叠的系数形状,按 `Expr::Num` 判形状会把 `sin(2x)` 的斜率误判成 0,
/// 线性内核因此整条失效(实测踩过).
fn nonzero_slope(slope: &Expr, variable: &str, coefficients: &HashMap<String, f64>) -> bool {
    if contains_var(slope, variable) {
        return true;
    }
    constant_or_none(slope, coefficients)
        .map(|value| value != 0.0)
        .unwrap_or(true)
}

fn is_numeric_zero(expr: &Expr) -> bool {
    matches!(expr, Expr::Num(value) if *value == 0.0)
}

fn is_numeric_one(expr: &Expr) -> bool {
    matches!(expr, Expr::Num(value) if *value == 1.0)
}

// ============================================================
// 积分主状态机
// ============================================================

struct IntegrationState<'a> {
    variable: String,
    coefficients: &'a HashMap<String, f64>,
    /**
     * 已声明参数名(可以没有数值).
     *
     * 为什么与 `coefficients` 分开:调用方有两种用法--
     * - 只给名字(值表为空):参数**保持符号**,原函数写成 `a*x^3/3 - cos(x)`,
     *   参数值由 TS 侧物化时按当前滑块折叠(静态场景缓存的正确做法);
     * - 名字带值:参数折成数值(逐参数代入的旧口径).
     *
     * 名字集合始终用于"哪些符号算已声明",否则 `a*x^2` 会被判成未声明符号.
     */
    declared_parameters: &'a [String],
    steps: Vec<AntiderivativeStep>,
    parts_depth: usize,
}

impl<'a> IntegrationState<'a> {
    /// 顶层入口:自由符号检查 -> 常函数短路 -> 积分 -> 验证 -> 组产物.
    fn run(&mut self, integrand: &Expr) -> AntiderivativeOutcome {
        let integrand = simplify(substitute_coefficients(integrand, self.coefficients));
        let integrand_latex = latex(&integrand);

        if let Some(name) = unknown_symbol(
            &integrand,
            &self.variable,
            self.coefficients,
            self.declared_parameters,
        ) {
            return self.failure(
                integrand_latex,
                format!("被积函数含未声明符号 {name}:请用 param 声明参数,或检查积分变量选项"),
            );
        }

        if let Some(reason) = known_non_elementary(&integrand, &self.variable) {
            return self.failure(
                integrand_latex,
                format!("{reason}:原函数不是初等函数,请改用 integral 的数值方法"),
            );
        }

        // 常函数:∫c dx = c*x(不经过规则链,步骤也更直白).
        if !contains_var(&integrand, &self.variable) {
            let symbol = latex_symbol(&self.variable);
            let antiderivative = simplify(mul(integrand.clone(), sym(&self.variable)));
            self.steps.push(step(
                format!("\\int {integrand_latex}\\;d{symbol} = {integrand_latex} \\cdot {symbol}"),
                "常函数积分",
                KIND_TABLE,
            ));
            return self.finish(integrand, antiderivative, integrand_latex);
        }

        self.steps.push(step(
            format!(
                "\\int {integrand_latex}\\;d{}",
                latex_symbol(&self.variable)
            ),
            "原式",
            KIND_DEFINITION,
        ));

        let antiderivative = match self.integrate(&integrand, 0) {
            Ok(expr) => simplify(expr),
            Err(message) => return self.failure(integrand_latex, message),
        };

        if let Some(name) = unknown_symbol(
            &antiderivative,
            &self.variable,
            self.coefficients,
            self.declared_parameters,
        ) {
            return self.failure(
                integrand_latex,
                format!("内核产出的原函数含未解析符号 {name},已拒绝(内部一致性检查)"),
            );
        }
        self.finish(integrand, antiderivative, integrand_latex)
    }

    /// 验证 + 组产物.
    fn finish(
        &mut self,
        integrand: Expr,
        antiderivative: Expr,
        integrand_latex: String,
    ) -> AntiderivativeOutcome {
        let verified = verify(&integrand, &antiderivative, &self.variable);
        if !verified {
            return self.failure(
                integrand_latex,
                "内核给出的原函数未通过回代验证,已拒绝(请报告这个被积函数)".to_string(),
            );
        }
        self.steps.push(step(
            format!(
                "\\frac{{d}}{{d{}}}\\left[{}\\right] = {}",
                latex_symbol(&self.variable),
                latex(&antiderivative),
                latex(&integrand),
            ),
            "回代验证:对原函数求导",
            KIND_CHECK,
        ));
        AntiderivativeOutcome {
            integrand_latex,
            antiderivative_latex: latex(&antiderivative),
            antiderivative_text: antiderivative.to_string(),
            verified,
            steps: std::mem::take(&mut self.steps),
            error: None,
        }
    }

    fn failure(&self, integrand_latex: String, message: String) -> AntiderivativeOutcome {
        AntiderivativeOutcome {
            integrand_latex,
            antiderivative_latex: String::new(),
            antiderivative_text: String::new(),
            verified: false,
            steps: Vec::new(),
            error: Some(message),
        }
    }

    /// 递归积分:失败消息用于能力边界文案.
    fn integrate(&mut self, expr: &Expr, depth: usize) -> Result<Expr, String> {
        if depth > MAX_DEPTH {
            return Err("积分递归过深,超出内核预算:请拆成更小的被积函数".to_string());
        }

        // 0 平凡因子:乘以 1 / 除以 1 直接穿透(`exp(x)*1` 这类残形是化简的产物,
        // 不穿透会让分部积分把 `dv = 1` 当成一次积分,尾部又长出原式).
        if let Expr::Binary(BinOp::Mul, left, right) = expr {
            if is_numeric_one(left) {
                return self.integrate(right, depth + 1);
            }
            if is_numeric_one(right) {
                return self.integrate(left, depth + 1);
            }
        }
        if let Expr::Binary(BinOp::Div, numerator, denominator) = expr {
            if is_numeric_one(denominator) {
                return self.integrate(numerator, depth + 1);
            }
        }

        // 1 线性性:和差逐项,常数因子提出.
        match expr {
            Expr::Binary(BinOp::Add, left, right) => {
                let left_integral = self.integrate(left, depth + 1)?;
                let right_integral = self.integrate(right, depth + 1)?;
                return Ok(simplify(add(left_integral, right_integral)));
            }
            Expr::Binary(BinOp::Sub, left, right) => {
                let left_integral = self.integrate(left, depth + 1)?;
                let right_integral = self.integrate(right, depth + 1)?;
                return Ok(simplify(sub(left_integral, right_integral)));
            }
            Expr::Unary(UnaryOp::Neg, operand) => {
                return Ok(simplify(neg(self.integrate(operand, depth + 1)?)));
            }
            _ => {}
        }
        if let Expr::Binary(BinOp::Mul, left, right) = expr {
            if !contains_var(left, &self.variable) && !is_numeric_one(left) {
                let inner = self.integrate(right, depth + 1)?;
                self.push_constant_factor(left, right);
                return Ok(simplify(mul(left.as_ref().clone(), inner)));
            }
            if !contains_var(right, &self.variable) && !is_numeric_one(right) {
                let inner = self.integrate(left, depth + 1)?;
                self.push_constant_factor(right, left);
                return Ok(simplify(mul(right.as_ref().clone(), inner)));
            }
        }
        if let Expr::Binary(BinOp::Div, numerator, denominator) = expr {
            if !contains_var(denominator, &self.variable) {
                let inner = self.integrate(numerator, depth + 1)?;
                return Ok(simplify(div(inner, denominator.as_ref().clone())));
            }
        }

        // 2 基本公式表(含线性内核).
        if let Some(result) = self.table(expr, depth)? {
            return Ok(result);
        }
        // 3 有理函数(多项式除法 + 部分分式).
        if let Some(result) = self.rational(expr, depth)? {
            return Ok(result);
        }
        // 4 分部积分.
        if let Some(result) = self.parts(expr, depth)? {
            return Ok(result);
        }

        Err(self.boundary_message(expr))
    }

    fn boundary_message(&self, expr: &Expr) -> String {
        let text = latex(expr);
        format!("无法给出 {text} 的原函数(超出内核的初等积分规则):请改用 integral 数值方法")
    }

    /// 合并同底数幂(仅常数指数).
    ///
    /// 只服务分部积分的尾部:`∫x·ln x` 分部出来的是 `0.5 x^2 · (1/x)`.化简器
    /// 刻意不做这类正规化;若不合并,下一轮分部会把 `x^2` 当 `u`,又长出
    /// `ln|x|·x`,兜一圈回到原地(实测踩过).基与指数都必须与积分变量无关,
    /// 避免改变定义域.
    fn merge_powers(&self, expr: &Expr) -> Expr {
        self.combine_powers(expr, 0)
    }

    /// `combine_powers` 的递归实现;`depth` 是树深护栏.
    fn combine_powers(&self, expr: &Expr, depth: usize) -> Expr {
        if depth > 64 {
            return expr.clone();
        }
        let variable = &self.variable;
        let independent = |part: &Expr| !contains_var(part, variable);
        match expr {
            Expr::Unary(UnaryOp::Neg, operand) => neg(self.combine_powers(operand, depth + 1)),
            Expr::Binary(BinOp::Add, left, right) => add(
                self.combine_powers(left, depth + 1),
                self.combine_powers(right, depth + 1),
            ),
            Expr::Binary(BinOp::Sub, left, right) => sub(
                self.combine_powers(left, depth + 1),
                self.combine_powers(right, depth + 1),
            ),
            Expr::Binary(BinOp::Div, numerator, denominator) => div(
                self.combine_powers(numerator, depth + 1),
                self.combine_powers(denominator, depth + 1),
            ),
            Expr::Binary(BinOp::Pow, base, exponent) => pow(
                self.combine_powers(base, depth + 1),
                self.combine_powers(exponent, depth + 1),
            ),
            Expr::Binary(BinOp::Mul, _, _) => {
                // 先把乘积摊平,再按"基的调试串"把常数指数相加.
                let mut factors: Vec<(Expr, Expr)> = Vec::new();
                self.collect_factors(expr, depth + 1, &mut factors);
                let mut merged: Vec<(Expr, Expr)> = Vec::new();
                for (base, exponent) in factors {
                    if contains_var(&exponent, variable) {
                        merged.push((base, exponent));
                        continue;
                    }
                    let key = format!("{base:?}");
                    match merged.iter_mut().find(|(existing, existing_exponent)| {
                        format!("{existing:?}") == key && !contains_var(existing_exponent, variable)
                    }) {
                        Some((_, existing_exponent)) => {
                            let sum = add(existing_exponent.clone(), exponent);
                            *existing_exponent = if independent(&sum) {
                                simplify(sum)
                            } else {
                                sum
                            };
                        }
                        None => merged.push((base, exponent)),
                    }
                }
                // 从右往左折回二元积:不要用 `1 * a * b` 这种累加器形状,
                // 会平白多出一层单位因子,后续"多项式因子"判定就认不出 `a*b`.
                let mut factors: Vec<Expr> = merged
                    .into_iter()
                    .map(|(base, exponent)| {
                        if matches!(&exponent, Expr::Num(value) if *value == 1.0) {
                            base
                        } else {
                            pow(base, exponent)
                        }
                    })
                    .collect();
                let mut out = factors.pop().unwrap_or(Expr::Num(1.0));
                while let Some(factor) = factors.pop() {
                    out = mul(factor, out);
                }
                out
            }
            Expr::Call(name, args) => Expr::Call(
                name.clone(),
                args.iter()
                    .map(|arg| self.combine_powers(arg, depth + 1))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    /// 把乘积链摊平成 `(基, 指数)` 列表;递归时先做同底合并.
    fn collect_factors(&self, expr: &Expr, depth: usize, out: &mut Vec<(Expr, Expr)>) {
        if depth > 64 {
            return;
        }
        match expr {
            Expr::Binary(BinOp::Mul, left, right) => {
                self.collect_factors(left, depth + 1, out);
                self.collect_factors(right, depth + 1, out);
            }
            other => {
                let combined = self.combine_powers(other, depth + 1);
                if let Expr::Binary(BinOp::Mul, left, right) = &combined {
                    self.collect_factors(left, depth + 1, out);
                    self.collect_factors(right, depth + 1, out);
                    return;
                }
                out.push(split_power(&combined));
            }
        }
    }

    fn push_constant_factor(&mut self, factor: &Expr, other: &Expr) {
        let symbol = latex_symbol(&self.variable);
        self.steps.push(step(
            format!(
                "\\int {} \\cdot \\left({}\\right)\\;d{} = {} \\int {}\\;d{}",
                latex(factor),
                latex(other),
                symbol,
                latex(factor),
                latex(other),
                symbol,
            ),
            "常数因子提出",
            KIND_ALGEBRA,
        ));
    }

    // --------------------------------------------------------
    // 基本公式表
    // --------------------------------------------------------

    fn table(&mut self, expr: &Expr, depth: usize) -> Result<Option<Expr>, String> {
        let variable = self.variable.clone();
        let symbol = latex_symbol(&variable);

        // 纯多项式(含单项式):逐项用幂公式.
        if let Some(poly) = Poly::from_expr(expr, &variable, self.coefficients) {
            if poly.degree().is_some() {
                self.steps.push(step(
                    format!(
                        "\\int {}\\;d{symbol} = {}",
                        latex(expr),
                        latex(&poly.integrate(&variable))
                    ),
                    "幂函数公式(逐项)",
                    KIND_TABLE,
                ));
                return Ok(Some(poly.integrate(&variable)));
            }
        }

        // 幂的线性内核:`(a x + b)^n`(n 为数值常数,含负整数).
        if let Expr::Binary(BinOp::Pow, base, exponent) = expr {
            if let Some(value) = constant_or_none(exponent, self.coefficients) {
                if !contains_var(base, &variable) {
                    // 常数底数:前面线性性已处理.
                } else if (value - (-1.0)).abs() < EPSILON {
                    if let Some((slope, _)) = linear_parts(base, &variable) {
                        if nonzero_slope(&slope, &variable, self.coefficients) {
                            let antiderivative = div(
                                call("ln", vec![call("abs", vec![base.as_ref().clone()])]),
                                slope,
                            );
                            self.steps.push(step(
                                format!(
                                    "\\int {}\\;d{symbol} = {}",
                                    latex(expr),
                                    latex(&simplify(antiderivative.clone()))
                                ),
                                "对数公式(线性内核)",
                                KIND_TABLE,
                            ));
                            return Ok(Some(simplify(antiderivative)));
                        }
                    }
                } else if let Some((slope, _)) = linear_parts(base, &variable) {
                    if nonzero_slope(&slope, &variable, self.coefficients) {
                        let new_exponent = value + 1.0;
                        let antiderivative = div(
                            pow(base.as_ref().clone(), num(new_exponent)),
                            mul(num(new_exponent), slope),
                        );
                        self.steps.push(step(
                            format!(
                                "\\int {}\\;d{symbol} = {}",
                                latex(expr),
                                latex(&simplify(antiderivative.clone()))
                            ),
                            "幂函数公式(线性内核)",
                            KIND_TABLE,
                        ));
                        return Ok(Some(simplify(antiderivative)));
                    }
                }
            }
        }

        // 基本函数:exp / sin / cos / sinh / cosh(线性内核).
        if let Expr::Call(name, args) = expr {
            if args.len() == 1 {
                let inner = args[0].clone();
                let primitive: Option<Box<dyn Fn(Expr) -> Expr>> = match name.as_str() {
                    "exp" => Some(Box::new(|u| call("exp", vec![u]))),
                    "sin" => Some(Box::new(|u| neg(call("cos", vec![u])))),
                    "cos" => Some(Box::new(|u| call("sin", vec![u]))),
                    "sinh" => Some(Box::new(|u| call("cosh", vec![u]))),
                    "cosh" => Some(Box::new(|u| call("sinh", vec![u]))),
                    "ln" => Some(Box::new(|u| {
                        sub(mul(u.clone(), call("ln", vec![u.clone()])), u)
                    })),
                    "asin" => Some(Box::new(|u| {
                        add(
                            mul(u.clone(), call("asin", vec![u.clone()])),
                            call("sqrt", vec![sub(num(1.0), pow(u, num(2.0)))]),
                        )
                    })),
                    "acos" => Some(Box::new(|u| {
                        sub(
                            mul(u.clone(), call("acos", vec![u.clone()])),
                            call("sqrt", vec![sub(num(1.0), pow(u, num(2.0)))]),
                        )
                    })),
                    "atan" => Some(Box::new(|u| {
                        sub(
                            mul(u.clone(), call("atan", vec![u.clone()])),
                            mul(num(0.5), call("ln", vec![add(num(1.0), pow(u, num(2.0)))])),
                        )
                    })),
                    _ => None,
                };
                if let Some(primitive) = primitive {
                    if contains_var(&inner, &variable) {
                        if let Some((slope, _)) = linear_parts(&inner, &variable) {
                            if nonzero_slope(&slope, &variable, self.coefficients) {
                                let antiderivative = div(primitive(inner), slope);
                                self.steps.push(step(
                                    format!(
                                        "\\int {}\\;d{symbol} = {}",
                                        latex(expr),
                                        latex(&simplify(antiderivative.clone()))
                                    ),
                                    "基本公式(线性内核)",
                                    KIND_TABLE,
                                ));
                                return Ok(Some(simplify(antiderivative)));
                            }
                        }
                    }
                }
            }
        }

        // 1/u 与 1/(1+u^2) 类.
        if let Expr::Binary(BinOp::Div, numerator, denominator) = expr {
            if is_numeric_one(numerator) {
                // 1/x -> ln|x|
                if matches!(denominator.as_ref(), Expr::Sym(name) if name == &variable) {
                    self.steps.push(step(
                        format!("\\int \\frac{{1}}{{{symbol}}}\\;d{symbol} = \\ln\\left|{symbol}\\right|"),
                        "基本公式",
                        KIND_TABLE,
                    ));
                    return Ok(Some(call("ln", vec![call("abs", vec![sym(&variable)])])));
                }
                // 1/(1 + u^2) -> atan(u) / slope
                if let Expr::Binary(BinOp::Add, left, right) = denominator.as_ref() {
                    if is_numeric_one(left) {
                        if let Expr::Binary(BinOp::Pow, base, exponent) = right.as_ref() {
                            if constant_or_none(exponent, self.coefficients)
                                .map(|value| (value - 2.0).abs() < EPSILON)
                                .unwrap_or(false)
                            {
                                if let Some((slope, _)) = linear_parts(base, &variable) {
                                    if nonzero_slope(&slope, &variable, self.coefficients) {
                                        let antiderivative =
                                            div(call("atan", vec![base.as_ref().clone()]), slope);
                                        self.steps.push(step(
                                            format!(
                                                "\\int {}\\;d{symbol} = {}",
                                                latex(expr),
                                                latex(&simplify(antiderivative.clone()))
                                            ),
                                            "基本公式(反正切)",
                                            KIND_TABLE,
                                        ));
                                        return Ok(Some(simplify(antiderivative)));
                                    }
                                }
                            }
                        }
                    }
                }
                // 1/(a^2 - u^2) -> (1/(2a)) ln|(a+u)/(a-u)| (部分分式形式,可求值).
                if let Some(result) = self.inverse_quadratic(expr, denominator, depth)? {
                    return Ok(Some(result));
                }
            }
            // 1/sqrt(1-u^2) -> asin(u)/slope
            if is_numeric_one(numerator) {
                if let Expr::Call(name, args) = denominator.as_ref() {
                    if name == "sqrt" && args.len() == 1 {
                        if let Some(result) = self.inverse_sqrt_kernel(expr, &args[0]) {
                            return Ok(Some(result));
                        }
                    }
                }
            }
        }

        // sqrt(1-u^2) -> (u sqrt(1-u^2) + asin(u)) / 2 / slope.
        if let Expr::Call(name, args) = expr {
            if name == "sqrt" && args.len() == 1 {
                if let Some(result) = self.circular_sqrt_kernel(expr, &args[0]) {
                    return Ok(Some(result));
                }
                // sqrt(a x + b) 的线性内核.
                if let Some((slope, _)) = linear_parts(&args[0], &variable) {
                    if nonzero_slope(&slope, &variable, self.coefficients) {
                        let antiderivative =
                            div(mul(num(2.0 / 3.0), pow(args[0].clone(), num(1.5))), slope);
                        self.steps.push(step(
                            format!(
                                "\\int {}\\;d{symbol} = {}",
                                latex(expr),
                                latex(&simplify(antiderivative.clone()))
                            ),
                            "幂函数公式(线性内核)",
                            KIND_TABLE,
                        ));
                        return Ok(Some(simplify(antiderivative)));
                    }
                }
            }
        }

        // 三角幂:sin^m / cos^m(线性内核内层).
        if let Some(result) = self.trig_power(expr, depth) {
            return Ok(Some(result));
        }

        Ok(None)
    }

    /// `1/(a^2 - u^2)` -> 部分分式的对数形式.
    fn inverse_quadratic(
        &mut self,
        original: &Expr,
        denominator: &Expr,
        _depth: usize,
    ) -> Result<Option<Expr>, String> {
        let variable = self.variable.clone();
        let Expr::Binary(BinOp::Add, left, right) = denominator else {
            return Ok(None);
        };
        // 两项里一项是"常数平方",另一项是"变量平方".
        let pair = match (
            square_base(left, self.coefficients),
            square_base(right, self.coefficients),
        ) {
            (Some(first), Some(second)) => Some((first, second)),
            _ => None,
        };
        let Some((first, second)) = pair else {
            return Ok(None);
        };
        let (constant_side, variable_side) = if !contains_var(&first, &variable) {
            (first, second)
        } else if !contains_var(&second, &variable) {
            (second, first)
        } else {
            return Ok(None);
        };
        let Some((slope, _)) = linear_parts(&variable_side, &variable) else {
            return Ok(None);
        };
        if !nonzero_slope(&slope, &variable, self.coefficients) {
            return Ok(None);
        }
        let Some(value) = constant_or_none(&constant_side, self.coefficients) else {
            return Ok(None);
        };
        if value <= 0.0 {
            return Ok(None);
        }
        let a = value.sqrt();
        let u = variable_side;
        let symbol = latex_symbol(&variable);
        // (1/(2a)) ln|(a + u)/(a - u)| / slope.
        let antiderivative = div(
            mul(
                num(1.0 / (2.0 * a)),
                call(
                    "ln",
                    vec![call(
                        "abs",
                        vec![div(add(num(a), u.clone()), sub(num(a), u.clone()))],
                    )],
                ),
            ),
            slope,
        );
        self.steps.push(step(
            format!(
                "\\int {}\\;d{symbol} = {}",
                latex(original),
                latex(&simplify(antiderivative.clone()))
            ),
            "基本公式(部分分式)",
            KIND_TABLE,
        ));
        Ok(Some(simplify(antiderivative)))
    }

    /// `1/sqrt(1 - u^2)` -> `asin(u) / slope`.
    fn inverse_sqrt_kernel(&mut self, original: &Expr, inner: &Expr) -> Option<Expr> {
        let variable = self.variable.clone();
        if !contains_var(inner, &variable) {
            return None;
        }
        // 只要求"常数 + (变量的一次式)^2·(负系数)":化简器会把 `1 - 4x^2`
        // 收成 `1 + -4 * x^2`,所以不能只认 `Sub`,要按两侧是否含变量来分工.
        let term = variable_square_term(inner, &variable, self.coefficients)?;
        let base = squared_base(&term, self.coefficients)?;
        let (slope, _) = linear_parts(&base, &variable)?;
        if !nonzero_slope(&slope, &variable, self.coefficients) {
            return None;
        }
        let symbol = latex_symbol(&variable);
        let antiderivative = div(call("asin", vec![base.clone()]), slope.clone());
        self.steps.push(step(
            format!(
                "\\int {}\\;d{symbol} = {}",
                latex(original),
                latex(&simplify(antiderivative.clone()))
            ),
            "基本公式(反正弦)",
            KIND_TABLE,
        ));
        Some(simplify(antiderivative))
    }

    /// `sqrt(1 - u^2)` -> `(u sqrt(1-u^2) + asin(u)) / (2 * slope)`.
    fn circular_sqrt_kernel(&mut self, original: &Expr, inner: &Expr) -> Option<Expr> {
        let variable = self.variable.clone();
        if !contains_var(inner, &variable) {
            return None;
        }
        let term = variable_square_term(inner, &variable, self.coefficients)?;
        let base = squared_base(&term, self.coefficients)?;
        let (slope, _) = linear_parts(&base, &variable)?;
        if !nonzero_slope(&slope, &variable, self.coefficients) {
            return None;
        }
        let symbol = latex_symbol(&variable);
        let antiderivative = div(
            mul(
                num(0.5),
                add(
                    mul(
                        base.clone(),
                        call("sqrt", vec![sub(num(1.0), pow(base.clone(), num(2.0)))]),
                    ),
                    call("asin", vec![base.clone()]),
                ),
            ),
            slope,
        );
        self.steps.push(step(
            format!(
                "\\int {}\\;d{symbol} = {}",
                latex(original),
                latex(&simplify(antiderivative.clone()))
            ),
            "基本公式(圆面积)",
            KIND_TABLE,
        ));
        Some(simplify(antiderivative))
    }

    /// 三角幂:把 `sin^m u` / `cos^m u` 线性化成 `Σ c_k cos(k u) + c_0`
    /// (sin 的奇次还会带 `sin k u`),再逐项积分.
    ///
    /// 为什么不用递推公式:降幂递推要同时维护"首项符号""递推增益""基项符号"
    /// 三个量,`sin^2`/`cos^2`/`cos^3` 之间反复写错(实测踩过多次).
    /// 线性化只有一条恒等式链,每个中间结果都形如 `Σ c_k T_k(n u)` 或常数,
    /// 系数由**唯一**的归约规则给出,不再有并列的符号规则:
    ///
    /// ```text
    /// sin^2 u = (1 - cos 2u)/2
    /// cos^2 u = (1 + cos 2u)/2
    /// sin u cos u = sin 2u / 2
    /// A·sin^p u cos^q u  ->  A/2 · sin^{p-1} u cos^{q-1} u · [cos 2u 项]
    /// ```
    ///
    /// 归约量取 `p` 与 `q` 中**较大者**:它在每步至少降 2(`(p,q) -> (p-1,q-1)`
    /// 再乘一个三角因子),所以步数有界,无需递归预算.
    fn trig_power(&mut self, expr: &Expr, _depth: usize) -> Option<Expr> {
        let variable = self.variable.clone();
        let Expr::Binary(BinOp::Pow, base, exponent) = expr else {
            return None;
        };
        let value = constant_or_none(exponent, self.coefficients)?;
        if value.fract() != 0.0 || !(2.0..=8.0).contains(&value) {
            return None;
        }
        let Expr::Call(name, args) = base.as_ref() else {
            return None;
        };
        if args.len() != 1 || (name != "sin" && name != "cos") {
            return None;
        }
        let power = value as usize;
        let (slope, _) = linear_parts(&args[0], &variable)?;
        if !nonzero_slope(&slope, &variable, self.coefficients) {
            return None;
        }
        let u = args[0].clone();
        let terms = linearize_trig(name, power, &u)?;
        let mut result = Expr::Num(0.0);
        for (coefficient, kind) in &terms {
            if *coefficient == 0.0 {
                continue;
            }
            // 表里的项**已是原函数**:`Constant -> u`,`Cos(k) -> cos(ku)`,
            // `Sin(k) -> sin(ku)`.这里只组装 `系数 × 项`;换元缩放(`u = a x + b`
            // 的 `1/a`)由末尾统一的 `div(result, slope)` 负责.
            // 早期版本在这里又按 `∫cos(ku)` 除了一次 `k`,等于积分了两遍
            // (`cos^2` 得到 `x/2 - sin(2x)/8`;实测踩过).
            let term = match kind {
                TrigTerm::Constant => sym(&variable),
                TrigTerm::Cos(multiplier) => {
                    call("cos", vec![mul(num(*multiplier as f64), u.clone())])
                }
                TrigTerm::Sin(multiplier) => {
                    call("sin", vec![mul(num(*multiplier as f64), u.clone())])
                }
            };
            result = add(result, mul(num(*coefficient), term));
        }
        let antiderivative = div(result, slope);
        self.steps.push(step(
            format!(
                "\\int {}\\;d{} = {}",
                latex(expr),
                latex_symbol(&self.variable),
                latex(&simplify(antiderivative.clone()))
            ),
            "三角降幂(线性化)",
            KIND_TABLE,
        ));
        Some(simplify(antiderivative))
    }

    // --------------------------------------------------------
    // 有理函数
    // --------------------------------------------------------

    fn rational(&mut self, expr: &Expr, depth: usize) -> Result<Option<Expr>, String> {
        let variable = self.variable.clone();
        let (numerator_expr, denominator_expr) = match expr {
            Expr::Binary(BinOp::Div, numerator, denominator) => {
                (numerator.as_ref(), denominator.as_ref())
            }
            _ => return Ok(None),
        };
        let Some(numerator) = Poly::from_expr(numerator_expr, &variable, self.coefficients) else {
            return Ok(None);
        };
        let Some(denominator) = Poly::from_expr(denominator_expr, &variable, self.coefficients)
        else {
            return Ok(None);
        };
        if denominator.is_zero() {
            return Err("被积函数的分母是零多项式".to_string());
        }
        if denominator.degree() == Some(0) {
            let inner = self.integrate(&numerator.to_expr(&variable), depth + 1)?;
            return Ok(Some(simplify(div(inner, num(denominator.constant_term())))));
        }
        if numerator.degree().unwrap_or(0) > MAX_RATIONAL_DEGREE
            || denominator.degree().unwrap_or(0) > MAX_RATIONAL_DEGREE
        {
            return Err(format!(
                "有理函数次数超过内核上限 {MAX_RATIONAL_DEGREE}:请拆成更小的被积函数"
            ));
        }

        let (quotient, remainder) = numerator.divmod(&denominator)?;
        if remainder.degree().is_none() && quotient.degree().is_none() {
            return Ok(Some(Expr::Num(0.0)));
        }
        let Some(parts) = decompose(&remainder, &denominator) else {
            // 分解不出来:交给后面的规则(可能靠分部/查表).
            return Ok(None);
        };

        let mut result = Expr::Num(0.0);
        if quotient.degree().is_some() {
            result = add(result, quotient.integrate(&variable));
        }
        for part in &parts {
            result = add(result, integrate_fraction_part(part, &variable));
        }
        if !parts.is_empty() {
            let symbol = latex_symbol(&variable);
            self.steps.push(step(
                format!(
                    "\\frac{{{}}}{{{}}} \\;\\longrightarrow\\; \\text{{部分分式}}\\;\\longrightarrow\\; {}",
                    latex(&remainder.to_expr(&variable)),
                    latex(&denominator.to_expr(&variable)),
                    latex(&simplify(result.clone())),
                ),
                "部分分式分解",
                KIND_SUBSTITUTE,
            ));
            let _ = symbol;
        }
        Ok(Some(simplify(result)))
    }

    // --------------------------------------------------------
    // 分部积分
    // --------------------------------------------------------

    fn parts(&mut self, expr: &Expr, depth: usize) -> Result<Option<Expr>, String> {
        let Expr::Binary(BinOp::Mul, left, right) = expr else {
            return Ok(None);
        };
        if self.parts_depth >= MAX_PARTS_DEPTH {
            return Ok(None);
        }
        let variable = self.variable.clone();
        // 4.1 多项式优先当 `u`:多项式求导必降次,一次分部就把次数压下去.
        // 只靠 LIATE 会让 `x^2 e^x` 先挑指数当 `u`,递归里又互相挑回对方,
        // 直到分部预算耗尽(实测踩过).`x^n * (超越项)` 是课堂最常考的形状.
        // LIATE:优先级**小**的一侧当 `u`(对数/反三角最优先,多项式次之,
        // 指数最后).多项式优先不是硬规则:`x*ln(x)` 必须让 `ln` 当 `u`,
        // 所以统一按优先级比较,只在平局时才用"多项式优先"破平.
        let left_priority = liate_priority(left, &variable);
        let right_priority = liate_priority(right, &variable);
        let left_polynomial = polynomial_factor_degree(left, &variable).is_some();
        let right_polynomial = polynomial_factor_degree(right, &variable).is_some();
        let take_left = match left_priority.cmp(&right_priority) {
            std::cmp::Ordering::Less => true,
            std::cmp::Ordering::Greater => false,
            std::cmp::Ordering::Equal => {
                // 平局(两侧都是多项式,或都是超越函数):多项式优先当 u,
                // 因为多项式求导必降次.
                left_polynomial || !right_polynomial
            }
        };
        let (u, dv) = if take_left {
            (left.as_ref(), right.as_ref())
        } else {
            (right.as_ref(), left.as_ref())
        };
        if liate_priority(u, &variable) == u8::MAX || liate_priority(dv, &variable) == u8::MAX {
            return Ok(None);
        }
        let du = derivative(u, &variable)?;
        if is_numeric_zero(&du) {
            return Ok(None);
        }
        self.parts_depth += 1;
        let v = match self.integrate(dv, depth + 1) {
            Ok(value) => value,
            Err(_) => {
                self.parts_depth -= 1;
                return Ok(None);
            }
        };
        let tail_expr = self.merge_powers(&mul(v.clone(), du.clone()));
        let tail = match self.integrate(&tail_expr, depth + 1) {
            Ok(value) => value,
            Err(_) => {
                self.parts_depth -= 1;
                return Ok(None);
            }
        };
        self.parts_depth -= 1;
        let symbol = latex_symbol(&variable);
        self.steps.push(step(
            format!(
                "\\int {} \\cdot {}\\;d{} = {} \\cdot {} - \\int {} \\cdot {}\\;d{}",
                latex(u),
                latex(dv),
                symbol,
                latex(u),
                latex(&v),
                latex(&v),
                latex(&du),
                symbol,
            ),
            "分部积分",
            KIND_SUBSTITUTE,
        ));
        Ok(Some(simplify(sub(mul(u.clone(), v), tail))))
    }
}

/// 多项式因子次数:整项是多项式时给它的次数;乘积里含多项式因子时给该因子的
/// 次数(如 `x*e^x` 给 `x` 的 1,`2x*e^x` 给 `2x` 的 1).
///
/// 用于分部积分的"多项式优先当 `u`"规则.为什么要看乘积内部:`x^2 e^x` 第一次
/// 分部后尾部是 `2x e^x`,它整体不是多项式;若只认整项,这一层会退化成 LIATE
/// 平局,把指数挑成 `u` 后又长出原式,直到预算耗尽(实测踩过).
fn polynomial_factor_degree(expr: &Expr, variable: &str) -> Option<usize> {
    // 结构判定不关心参数取值:`from_expr` 要求每个非积分变量都能查到值,所以
    // 这里把表达式里出现的**所有符号**都登记成参数(占位 1),只问次数.
    let mut names = Vec::new();
    super::collect_symbols(expr, &mut names);
    let placeholder: HashMap<String, f64> = names
        .into_iter()
        .filter(|name| name != variable)
        .map(|name| (name, 1.0))
        .collect();
    if let Some(poly) = Poly::from_expr(expr, variable, &placeholder) {
        return poly.degree();
    }
    if let Expr::Binary(BinOp::Mul, left, right) = expr {
        for side in [left.as_ref(), right.as_ref()] {
            if let Some(poly) = Poly::from_expr(side, variable, &placeholder) {
                return poly.degree();
            }
        }
    }
    None
}

/// 形如 `1/u` 或 `u^{-n}` 的倒数因子.
///
/// 它没有解出多项式形态(`Poly::from_expr` 直接拒绝),但积分后仍是代数函数,
/// LIATE 里应当与多项式同档:`x*ln(x)` 分部后尾部是 `1/x`,若这里不给档位,
/// 尾部会被判"优先级 MAX 不能当 u",整条分部失败(实测踩过).
fn is_reciprocal_factor(expr: &Expr, variable: &str) -> bool {
    match expr {
        Expr::Binary(BinOp::Div, numerator, denominator) => {
            !contains_var(numerator, variable) && contains_var(denominator, variable)
        }
        Expr::Binary(BinOp::Pow, base, exponent) => {
            contains_var(base, variable)
                && matches!(exponent.as_ref(), Expr::Num(value) if *value < 0.0)
        }
        _ => false,
    }
}

/// 线性化后的一个三角项(角频率倍数 -> 系数).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum TrigTerm {
    /// 常数项(积分后是 `x`).
    Constant,
    /// `cos(k u)`.
    Cos(i64),
    /// `sin(k u)`.
    Sin(i64),
}

/// 把 `sin^m u` / `cos^m u` 线性化成 `sin(k u)` / `cos(k u)` / 常数项之和.
///
/// 用**积化和差**展开,全程实系数,每步可逐项核对:
/// - `cos A cos B = [cos(A+B) + cos(A-B)]/2`
/// - `sin A sin B = [cos(A-B) - cos(A+B)]/2`
/// - `sin A cos B = [sin(A+B) + sin(A-B)]/2`
/// - `cos^2 A = (1 + cos 2A)/2`,`sin^2 A = (1 - cos 2A)/2`
///
/// 刻意不用复数指数形式:那要把 `1/i^n` 的相位映射成实系数,`n mod 4` 与
/// `sin/cos` 的配对极易写反(`sin^3` 会得到 `-0.25 sin 3u - 0.75 sin u` 而
/// 不是 `+0.25 sin 3u + 0.75 sin u`;实测踩过).
fn linearize_trig(name: &str, power: usize, _u: &Expr) -> Option<Vec<(f64, TrigTerm)>> {
    // 表里放的是**原函数**的项(已积分),`trig_power` 只做 `系数 × 项` 的组装:
    // `Constant -> u`,`Cos(k) -> sin(ku)/k`,`Sin(k) -> -cos(ku)/k`.
    // 早期版本把被积函数的线性化系数直接放进表里(漏了逐项积分),`sin^3`
    // 于是得到 `-sin x + sin 3x/36`--求导是 `-cos x + cos 3x/12`,与被积函数
    // 对不上,回代验证当场拒绝(实测踩过).
    let table: &[(f64, TrigTerm)] = match (name, power) {
        // ∫sin^2 u du = u/2 − sin(2u)/4
        ("sin", 2) => &[(0.5, TrigTerm::Constant), (-0.25, TrigTerm::Sin(2))],
        // ∫cos^2 u du = u/2 + sin(2u)/4
        ("cos", 2) => &[(0.5, TrigTerm::Constant), (0.25, TrigTerm::Sin(2))],
        // ∫sin^3 u du = −(3/4)cos u + (1/12)cos(3u)
        ("sin", 3) => &[(-0.75, TrigTerm::Cos(1)), (1.0 / 12.0, TrigTerm::Cos(3))],
        // ∫cos^3 u du = (3/4)sin u + (1/12)sin(3u)
        ("cos", 3) => &[(0.75, TrigTerm::Sin(1)), (1.0 / 12.0, TrigTerm::Sin(3))],
        // ∫sin^4 u du = 3u/8 − sin(2u)/4 + sin(4u)/32
        ("sin", 4) => &[
            (0.375, TrigTerm::Constant),
            (-0.25, TrigTerm::Sin(2)),
            (1.0 / 32.0, TrigTerm::Sin(4)),
        ],
        // ∫cos^4 u du = 3u/8 + sin(2u)/4 + sin(4u)/32
        ("cos", 4) => &[
            (0.375, TrigTerm::Constant),
            (0.25, TrigTerm::Sin(2)),
            (1.0 / 32.0, TrigTerm::Sin(4)),
        ],
        // ∫sin^5 u du = −(5/8)cos u + (5/48)cos(3u) − cos(5u)/80
        ("sin", 5) => &[
            (-0.625, TrigTerm::Cos(1)),
            (5.0 / 48.0, TrigTerm::Cos(3)),
            (-1.0 / 80.0, TrigTerm::Cos(5)),
        ],
        // ∫cos^5 u du = (5/8)sin u + (5/48)sin(3u) + sin(5u)/80
        ("cos", 5) => &[
            (0.625, TrigTerm::Sin(1)),
            (5.0 / 48.0, TrigTerm::Sin(3)),
            (1.0 / 80.0, TrigTerm::Sin(5)),
        ],
        _ => return None,
    };
    Some(table.to_vec())
}

/// 把表达式看成 `base^exponent`:裸表达式按一次幂处理,`1/f` 归成 `f^{-1}`.
///
/// `1/f` 必须在这里归一成负指数,否则 `x^2 * (1/x)` 的两个因子基不同名,
/// 合并时认不出彼此(实测踩过).
fn split_power(expr: &Expr) -> (Expr, Expr) {
    match expr {
        Expr::Binary(BinOp::Pow, base, exponent) => {
            (base.as_ref().clone(), exponent.as_ref().clone())
        }
        Expr::Binary(BinOp::Div, numerator, denominator) => {
            if matches!(numerator.as_ref(), Expr::Num(value) if *value == 1.0) {
                let (base, exponent) = split_power(denominator);
                (base, neg(exponent))
            } else {
                (expr.clone(), num(1.0))
            }
        }
        other => (other.clone(), num(1.0)),
    }
}

/// LIATE 优先级(越小越优先当 `u`);不可微/不认识的因子返回 `u8::MAX`.
fn liate_priority(expr: &Expr, variable: &str) -> u8 {
    match expr {
        Expr::Call(name, args) if args.len() == 1 => match name.as_str() {
            "ln" | "log10" | "log2" => 0,
            "asin" | "acos" | "atan" => 1,
            _ => {
                if contains_var(expr, variable) {
                    3
                } else {
                    5
                }
            }
        },
        Expr::Num(_) | Expr::Sym(_) => {
            if contains_var(expr, variable) {
                2
            } else {
                5
            }
        }
        Expr::Binary(BinOp::Pow, _, _) => 2,
        Expr::Unary(_, _) => 2,
        // 乘积既可能是"多项式因子 × 超越因子"(`2x e^x`,u 应当取多项式那一侧),
        // 也可能是两个都不好当 u 的因子.多项式因子按 LIATE 的 A 档给 2;
        // 其余含变量的复合形状给 `u8::MAX`,让 `parts` 直接放弃这条路径,
        // 而不是硬挑一个 u 出来把自己绕回原式.
        other => {
            if polynomial_factor_degree(other, variable).is_some()
                || is_reciprocal_factor(other, variable)
            {
                2
            } else if contains_var(other, variable) {
                u8::MAX
            } else {
                5
            }
        }
    }
}

// ============================================================
// 多项式与部分分式
// ============================================================

/// 数值系数多项式(升幂系数表);用于有理函数路径.
#[derive(Debug, Clone, PartialEq)]
struct Poly {
    coeffs: Vec<f64>,
}

impl Poly {
    fn trimmed(mut coeffs: Vec<f64>) -> Self {
        while matches!(coeffs.last(), Some(last) if last.abs() < EPSILON) {
            coeffs.pop();
        }
        Self { coeffs }
    }

    fn constant(value: f64) -> Self {
        Self::trimmed(vec![value])
    }

    fn is_zero(&self) -> bool {
        self.coeffs.is_empty()
    }

    fn degree(&self) -> Option<usize> {
        self.coeffs.len().checked_sub(1)
    }

    fn coeff(&self, index: usize) -> f64 {
        self.coeffs.get(index).copied().unwrap_or(0.0)
    }

    fn constant_term(&self) -> f64 {
        self.coeff(0)
    }

    fn add(&self, other: &Self) -> Self {
        let length = self.coeffs.len().max(other.coeffs.len());
        let mut coeffs = Vec::with_capacity(length);
        for index in 0..length {
            coeffs.push(self.coeff(index) + other.coeff(index));
        }
        Self::trimmed(coeffs)
    }

    fn sub(&self, other: &Self) -> Self {
        let length = self.coeffs.len().max(other.coeffs.len());
        let mut coeffs = Vec::with_capacity(length);
        for index in 0..length {
            coeffs.push(self.coeff(index) - other.coeff(index));
        }
        Self::trimmed(coeffs)
    }

    fn scale(&self, factor: f64) -> Self {
        Self::trimmed(self.coeffs.iter().map(|value| value * factor).collect())
    }

    fn mul(&self, other: &Self) -> Self {
        if self.is_zero() || other.is_zero() {
            return Self::trimmed(Vec::new());
        }
        let mut coeffs = vec![0.0; self.coeffs.len() + other.coeffs.len() - 1];
        for (left_index, left) in self.coeffs.iter().enumerate() {
            for (right_index, right) in other.coeffs.iter().enumerate() {
                coeffs[left_index + right_index] += left * right;
            }
        }
        Self::trimmed(coeffs)
    }

    fn evaluate(&self, x: f64) -> f64 {
        let mut value = 0.0;
        for coefficient in self.coeffs.iter().rev() {
            value = value * x + coefficient;
        }
        value
    }

    /// 带余除法:`self = quotient * divisor + remainder`.
    fn divmod(&self, divisor: &Self) -> Result<(Self, Self), String> {
        if divisor.is_zero() {
            return Err("有理函数的分母是零多项式".to_string());
        }
        let mut remainder = self.clone();
        let divisor_degree = divisor.degree().expect("非零多项式有次数");
        let divisor_lead = divisor.coeff(divisor_degree);
        if remainder.degree().unwrap_or(0) < divisor_degree {
            return Ok((Self::trimmed(Vec::new()), remainder));
        }
        let quotient_degree = remainder.degree().unwrap_or(0) - divisor_degree;
        let mut quotient = vec![0.0; quotient_degree + 1];
        while let Some(degree) = remainder.degree() {
            if degree < divisor_degree {
                break;
            }
            let factor = remainder.coeff(degree) / divisor_lead;
            let shift = degree - divisor_degree;
            quotient[shift] = factor;
            for index in 0..=divisor_degree {
                let target = shift + index;
                if target < remainder.coeffs.len() {
                    remainder.coeffs[target] -= factor * divisor.coeff(index);
                }
            }
            remainder = Self::trimmed(remainder.coeffs);
        }
        Ok((Self::trimmed(quotient), remainder))
    }

    /// `Expr` -> 多项式;含未知量的非多项式项返回 `None`.
    fn from_expr(expr: &Expr, variable: &str, coefficients: &HashMap<String, f64>) -> Option<Poly> {
        match expr {
            Expr::Num(value) => Some(Poly::constant(*value)),
            Expr::Sym(name) => {
                if name == variable {
                    Some(Poly::trimmed(vec![0.0, 1.0]))
                } else {
                    coefficients.get(name).map(|value| Poly::constant(*value))
                }
            }
            Expr::Unary(UnaryOp::Neg, operand) => {
                Some(Poly::from_expr(operand, variable, coefficients)?.scale(-1.0))
            }
            Expr::Binary(BinOp::Add, left, right) => Some(
                Poly::from_expr(left, variable, coefficients)?.add(&Poly::from_expr(
                    right,
                    variable,
                    coefficients,
                )?),
            ),
            Expr::Binary(BinOp::Sub, left, right) => Some(
                Poly::from_expr(left, variable, coefficients)?.sub(&Poly::from_expr(
                    right,
                    variable,
                    coefficients,
                )?),
            ),
            Expr::Binary(BinOp::Mul, left, right) => Some(
                Poly::from_expr(left, variable, coefficients)?.mul(&Poly::from_expr(
                    right,
                    variable,
                    coefficients,
                )?),
            ),
            Expr::Binary(BinOp::Div, numerator, denominator) => {
                let divisor = Poly::from_expr(denominator, variable, coefficients)?;
                if divisor.degree() != Some(0) {
                    return None;
                }
                Some(
                    Poly::from_expr(numerator, variable, coefficients)?
                        .scale(1.0 / divisor.constant_term()),
                )
            }
            Expr::Binary(BinOp::Pow, base, exponent) => {
                let value = constant_or_none(exponent, coefficients)?;
                if value.fract() != 0.0 || value < 0.0 || value > 12.0 {
                    return None;
                }
                let base = Poly::from_expr(base, variable, coefficients)?;
                let mut result = Poly::constant(1.0);
                for _ in 0..(value as usize) {
                    result = result.mul(&base);
                }
                Some(result)
            }
            Expr::Call(_, _) | Expr::List(_) => None,
        }
    }

    fn to_expr(&self, variable: &str) -> Expr {
        let mut result = Expr::Num(0.0);
        for (degree, coefficient) in self.coeffs.iter().enumerate() {
            if *coefficient == 0.0 {
                continue;
            }
            let term = match degree {
                0 => num(*coefficient),
                1 => mul(num(*coefficient), sym(variable)),
                _ => mul(num(*coefficient), pow(sym(variable), num(degree as f64))),
            };
            result = add(result, term);
        }
        simplify(result)
    }

    /// 多项式积分:逐项 `c x^n -> c x^{n+1} / (n+1)`.
    fn integrate(&self, variable: &str) -> Expr {
        let mut result = Expr::Num(0.0);
        for (degree, coefficient) in self.coeffs.iter().enumerate() {
            if *coefficient == 0.0 {
                continue;
            }
            let term = if degree == 0 {
                mul(num(*coefficient), sym(variable))
            } else {
                let new_degree = (degree + 1) as f64;
                mul(
                    num(*coefficient / new_degree),
                    pow(sym(variable), num(new_degree)),
                )
            };
            result = add(result, term);
        }
        simplify(result)
    }
}

/// 部分分式的一项.
#[derive(Debug, Clone, PartialEq)]
enum FractionPart {
    /// `A / (x - root)^power`.
    Linear {
        numerator: f64,
        root: f64,
        power: usize,
    },
    /// `(b x + c) / (x^2 + p x + q)`.
    Quadratic { b: f64, c: f64, p: f64, q: f64 },
}

/// 把真分式 `p/q` 分解成部分分式;分解不出来返回 `None`.
///
/// 只处理"分母可分解为一次因子与至多一个不可约二次因子"的情形(教学覆盖的
/// 绝大多数有理函数);更高次/无有理根的情形退回给后续规则.
///
/// 重因子部分分式用**直接消元**:把每个未知量的"基多项式"(该未知量置 1 时
/// 的部分分式分子)在分母各次幂上的系数排成矩阵,解小规模线性方程组.这比
/// 逐次求导定系数直观,也不会在根为无理数时退化.
fn decompose(numerator: &Poly, denominator: &Poly) -> Option<Vec<FractionPart>> {
    let degree = denominator.degree()?;
    if degree == 0 || degree > MAX_RATIONAL_DEGREE {
        return None;
    }
    if numerator.degree().unwrap_or(0) >= degree {
        return None;
    }
    let lead = denominator.coeff(degree);
    if lead == 0.0 {
        return None;
    }
    let monic = denominator.scale(1.0 / lead);
    let scaled_numerator = numerator.scale(1.0 / lead);

    // 提取全部有理根(含重根).
    let mut rest = monic.clone();
    let mut linear_factors: Vec<(f64, usize)> = Vec::new();
    while rest.degree().unwrap_or(0) >= 1 {
        let Some(root) = rational_root(&rest) else {
            break;
        };
        let divisor = Poly::trimmed(vec![-root, 1.0]);
        let (quotient, remainder) = rest.divmod(&divisor).ok()?;
        if remainder.degree().is_some() {
            break;
        }
        match linear_factors
            .iter_mut()
            .find(|(value, _)| (*value - root).abs() < EPSILON)
        {
            Some((_, count)) => *count += 1,
            None => linear_factors.push((root, 1)),
        }
        rest = quotient;
    }

    let quadratic = match rest.degree() {
        Some(0) => None,
        Some(2) => Some((rest.coeff(1), rest.coeff(0))),
        _ => return None,
    };
    // 分母本身就是不可约二次(如 `x^2 + 1`):没有一次因子也要能分解,否则
    // `1/(x^2+1)` 这条最基本的公式会被判"超出规则".
    if linear_factors.is_empty() && quadratic.is_none() {
        return None;
    }

    // 未知量布局:重因子按降幂 `A_k`..`A_1`,二次因子两个.
    let mut layout: Vec<FractionPart> = Vec::new();
    for (root, count) in &linear_factors {
        for power in (1..=*count).rev() {
            layout.push(FractionPart::Linear {
                numerator: 0.0,
                root: *root,
                power,
            });
        }
    }
    // 二次因子是**一个**条目(它带两个系数 `b`,`c`),不能 push 两次:那样
    // layout 比真实未知量多一倍,后面的槽位记账必然越界(实测踩过).
    if let Some((p, q)) = quadratic {
        layout.push(FractionPart::Quadratic {
            b: 0.0,
            c: 0.0,
            p,
            q,
        });
    }
    let unknowns: usize = layout
        .iter()
        .map(|part| match part {
            FractionPart::Linear { .. } => 1,
            FractionPart::Quadratic { .. } => 2,
        })
        .sum();
    if unknowns != degree {
        return None;
    }

    // 每个未知量的基多项式: 分母去掉该因子后的部分(乘上必要的幂次).
    let mut basis: Vec<Poly> = Vec::with_capacity(unknowns);
    for (root, count) in &linear_factors {
        for power in (1..=*count).rev() {
            // 基 = (分母 / (x-root)^count) * (x-root)^{count-power}.
            let mut without = Poly::constant(1.0);
            for (other_root, other_count) in &linear_factors {
                let times = if (other_root - root).abs() < EPSILON {
                    0
                } else {
                    *other_count
                };
                for _ in 0..times {
                    without = without.mul(&Poly::trimmed(vec![-*other_root, 1.0]));
                }
            }
            if let Some((p, q)) = quadratic {
                without = without.mul(&Poly::trimmed(vec![q, p, 1.0]));
            }
            for _ in 0..(count - power) {
                without = without.mul(&Poly::trimmed(vec![-*root, 1.0]));
            }
            basis.push(without);
        }
    }
    if quadratic.is_some() {
        // 二次因子:x*D/(x^2+px+q) 与 D/(x^2+px+q).
        let mut without = Poly::constant(1.0);
        for (root, count) in &linear_factors {
            for _ in 0..*count {
                without = without.mul(&Poly::trimmed(vec![-*root, 1.0]));
            }
        }
        basis.push(without.mul(&Poly::trimmed(vec![0.0, 1.0])));
        basis.push(without);
    }
    if basis.len() != unknowns {
        return None;
    }

    // Σ unknown_i * basis_i = numerator.
    let mut matrix = vec![vec![0.0; unknowns + 1]; degree];
    for (column, poly) in basis.iter().enumerate() {
        for (row, cell) in matrix.iter_mut().enumerate() {
            cell[column] = poly.coeff(row);
        }
    }
    for (row, cell) in matrix.iter_mut().enumerate() {
        cell[unknowns] = scaled_numerator.coeff(row);
    }
    let solution = solve_system(matrix, unknowns)?;

    let mut parts = Vec::with_capacity(unknowns);
    let mut used = 0;
    // 解向量按"layout 条目连续占槽"布局:一次因子占 1 槽,二次因子占连续 2 槽
    // (`b`,`c`).`used` 是**槽偏移**,不是条目序号--两种步长混用会让不可约二次
    // 因子在第二项越界(实测踩过).
    for part in layout {
        match part {
            FractionPart::Linear { root, power, .. } => {
                parts.push(FractionPart::Linear {
                    numerator: solution[used],
                    root,
                    power,
                });
                used += 1;
            }
            FractionPart::Quadratic { p, q, .. } => {
                parts.push(FractionPart::Quadratic {
                    b: solution[used],
                    c: solution[used + 1],
                    p,
                    q,
                });
                used += 2;
            }
        }
    }
    Some(parts)
}

/// 有理根搜索:按"小分母候选 + 多项式求值"筛选,找不到返回 `None`.
fn rational_root(poly: &Poly) -> Option<f64> {
    let degree = poly.degree()?;
    if degree == 0 {
        return None;
    }
    if poly.coeff(0).abs() < EPSILON {
        return Some(0.0);
    }
    // 候选来自常数项/首项系数的比与 1..12 的小分母分数:教学题目的根几乎都在
    // 这个集合里;更高次或无理根的情形由调用方退回给后续规则.
    let mut candidates: Vec<f64> = Vec::new();
    for numerator in 1..=12i64 {
        for denominator in 1..=6i64 {
            for sign in [1.0, -1.0] {
                let value = sign * numerator as f64 / denominator as f64;
                if !candidates
                    .iter()
                    .any(|existing: &f64| (existing - value).abs() < 1e-12)
                {
                    candidates.push(value);
                }
            }
        }
    }
    candidates
        .into_iter()
        .find(|candidate| poly.evaluate(*candidate).abs() < 1e-7)
}

/// 高斯消元(部分选主元);无解/奇异返回 `None`.
fn solve_system(mut matrix: Vec<Vec<f64>>, unknowns: usize) -> Option<Vec<f64>> {
    let rows = matrix.len();
    for column in 0..unknowns {
        let mut pivot = column;
        for row in column + 1..rows {
            if matrix[row][column].abs() > matrix[pivot][column].abs() {
                pivot = row;
            }
        }
        if matrix[pivot][column].abs() < 1e-12 {
            return None;
        }
        matrix.swap(column, pivot);
        let divisor = matrix[column][column];
        for value in matrix[column].iter_mut().skip(column) {
            *value /= divisor;
        }
        for row in 0..rows {
            if row == column {
                continue;
            }
            let factor = matrix[row][column];
            if factor.abs() < 1e-15 {
                continue;
            }
            let pivot_row = matrix[column].clone();
            for (cell, pivot_cell) in matrix[row][column..=unknowns]
                .iter_mut()
                .zip(pivot_row[column..=unknowns].iter())
            {
                *cell -= factor * pivot_cell;
            }
        }
    }
    Some((0..unknowns).map(|index| matrix[index][unknowns]).collect())
}

/// 积分一个部分分式项.
fn integrate_fraction_part(part: &FractionPart, variable: &str) -> Expr {
    let x = sym(variable);
    match part {
        FractionPart::Linear {
            numerator,
            root,
            power,
        } => {
            if *power == 1 {
                mul(
                    num(*numerator),
                    call("ln", vec![call("abs", vec![sub(x, num(*root))])]),
                )
            } else {
                let exponent = 1.0 - *power as f64;
                div(
                    mul(num(*numerator), pow(sub(x, num(*root)), num(exponent))),
                    num(exponent),
                )
            }
        }
        FractionPart::Quadratic { b, c, p, q } => {
            let denominator = add(
                pow(x.clone(), num(2.0)),
                add(mul(num(*p), x.clone()), num(*q)),
            );
            let shift = *p / 2.0;
            let constant = *q - *p * *p / 4.0;
            let mut result = mul(
                num(*b / 2.0),
                call("ln", vec![call("abs", vec![denominator.clone()])]),
            );
            let residual = *c - *b * *p / 2.0;
            if constant.abs() > EPSILON {
                let root = constant.abs().sqrt();
                let inside = div(add(x, num(shift)), num(root));
                let correction = if constant > 0.0 {
                    div(call("atan", vec![inside]), num(root))
                } else {
                    // 负常数项用对数形式给出(不引入 artanh).
                    mul(
                        num(0.5),
                        call(
                            "ln",
                            vec![call(
                                "abs",
                                vec![div(add(num(1.0), inside.clone()), sub(num(1.0), inside))],
                            )],
                        ),
                    )
                };
                result = add(result, mul(num(residual), correction));
            } else {
                result = add(result, div(num(-residual), add(x, num(shift))));
            }
            result
        }
    }
}

// ============================================================
// 验证与边界
// ============================================================

/// 对原函数求导,与被积函数抽样对拍.
///
/// 参数按 [`VERIFY_PARAM_VALUE`] 代入:符号比较需要多项式正规化(本项目刻意
/// 不做),数值抽样能在不引入新数据结构的前提下抓住绝大多数真实错误.
/// 有效抽样点为 0 时返回 `false`(证不出就不放行).
fn verify(integrand: &Expr, antiderivative: &Expr, variable: &str) -> bool {
    let Ok(derivative) = derivative(antiderivative, variable) else {
        return false;
    };
    let mut compared = 0;
    for sample in VERIFY_SAMPLES {
        let lookup = |name: &str| -> Option<f64> {
            if name == variable {
                Some(sample)
            } else {
                Some(VERIFY_PARAM_VALUE)
            }
        };
        let left = evaluate_with_lookup(integrand, &lookup);
        let right = evaluate_with_lookup(&derivative, &lookup);
        if left.is_err() || right.is_err() {
            continue;
        }
        let Ok(Some(left)) = left else { continue };
        let Ok(Some(right)) = right else { continue };
        if !left.is_finite() || !right.is_finite() {
            continue;
        }
        compared += 1;
        let scale = left.abs().max(right.abs()).max(1.0);
        if (left - right).abs() > VERIFY_TOLERANCE * scale {
            return false;
        }
    }
    compared > 0
}

/// 已知非初等的被积函数:给专门文案而不是笼统的"超出规则".
fn known_non_elementary(expr: &Expr, variable: &str) -> Option<&'static str> {
    let (name, inner) = match expr {
        Expr::Call(name, args) if args.len() == 1 => (name.as_str(), &args[0]),
        _ => return None,
    };
    let square_of_variable = matches!(
        inner,
        Expr::Binary(BinOp::Pow, base, exponent)
            if matches!(base.as_ref(), Expr::Sym(symbol) if symbol == variable)
                && matches!(exponent.as_ref(), Expr::Num(value) if (*value - 2.0).abs() < EPSILON)
    );
    match name {
        "exp" if square_of_variable => Some("e^{x^2} 的原函数是误差函数"),
        "sin" | "cos" if square_of_variable => Some("sin(x^2) / cos(x^2) 的原函数是 Fresnel 积分"),
        _ => None,
    }
}

/// 从 `c ± (a x + b)^2` 形状里取出**平方项本身** `(a x + b)^2`.
///
/// 化简器对 `1 - 4x^2` 保留成 `Sub`,且平方项是 `4 * x^2`(常数系数与幂是
/// **两个**节点).这里把"常数系数 + 平方"整串交出去,由 [`squared_base`]
/// 把系数开方并进底(`4x^2` 的底是 `2x`).
fn variable_square_term(
    expr: &Expr,
    variable: &str,
    coefficients: &HashMap<String, f64>,
) -> Option<Expr> {
    let Expr::Binary(BinOp::Add | BinOp::Sub, left, right) = expr else {
        return None;
    };
    for side in [left.as_ref(), right.as_ref()] {
        if is_square_form(side, variable, coefficients) {
            return Some(side.clone());
        }
    }
    None
}

/// 该子表达式是否形如 `[c *] u^2`(u 含积分变量,c 为常数).
fn is_square_form(expr: &Expr, variable: &str, coefficients: &HashMap<String, f64>) -> bool {
    if square_base(expr, coefficients).is_some() {
        return contains_var(expr, variable);
    }
    if let Expr::Binary(BinOp::Mul, factor, squared) = expr {
        if !contains_var(factor, variable) && square_base(squared, coefficients).is_some() {
            return true;
        }
    }
    false
}

/// 平方项的底 `u`,满足 `term = c * u^2`(c > 0 时取 `sqrt(c) * u`).
///
/// 常数系数要**开方后并进底**:`4x^2 = (2x)^2`,否则 `∫dx/√(1-4x^2)` 会得到
/// `asin(x)`,求导只剩 `1/√(1-x^2)`(实测踩过).负系数不带进底:平方项写成
/// `-4x^2` 时其符号已由常数侧吸收,底仍取 `2x`.
fn squared_base(term: &Expr, coefficients: &HashMap<String, f64>) -> Option<Expr> {
    if let Expr::Binary(BinOp::Mul, factor, squared) = term {
        if !contains_var(factor, "") {
            if let Some(base) = square_base(squared, coefficients) {
                let value = constant_or_none(factor, coefficients)?;
                let scale = value.abs().sqrt();
                if (scale - 1.0).abs() < EPSILON {
                    return Some(base);
                }
                return Some(mul(num(scale), base));
            }
        }
    }
    square_base(term, coefficients)
}

/// `x^2` 形式的底数;不是平方返回 `None`.
fn square_base(expr: &Expr, coefficients: &HashMap<String, f64>) -> Option<Expr> {
    let Expr::Binary(BinOp::Pow, base, exponent) = expr else {
        return None;
    };
    let value = constant_or_none(exponent, coefficients)?;
    if (value - 2.0).abs() < EPSILON {
        Some(base.as_ref().clone())
    } else {
        None
    }
}

/// `Expr` -> LaTeX;失败时回退到文本打印(不让排版问题吞掉结果).
fn latex(expr: &Expr) -> String {
    match super::latex::latex_expression(&expr.to_string()) {
        Ok(rendered) => rendered,
        Err(_) => expr.to_string(),
    }
}

// latex_number 目前只在个别公式里用到;保留导入会触发未使用告警.
#[cfg(test)]
mod tests {
    use super::*;

    fn integrate(source: &str) -> AntiderivativeOutcome {
        antiderivative(source, "x", &HashMap::new()).expect("应当能积分")
    }

    fn assert_success(source: &str) -> AntiderivativeOutcome {
        let outcome = integrate(source);
        assert!(
            outcome.error.is_none(),
            "{source} 应当可积,却报: {:?}",
            outcome.error
        );
        assert!(outcome.verified, "{source} 的结果未通过回代验证");
        assert!(!outcome.antiderivative_text.is_empty());
        assert_eq!(outcome.steps.last().expect("至少一步").kind, KIND_CHECK);
        outcome
    }

    #[test]
    fn polynomial_and_power_rule() {
        let outcome = assert_success("x^3 + 7/x^4 - 2/x");
        assert!(
            outcome.antiderivative_text.contains("ln"),
            "{}",
            outcome.antiderivative_text
        );
        assert_success("3*x^2 - 4*x + 5");
        assert_success("x^2");
        assert_success("1/x");
        assert_success("sqrt(x)");
    }

    #[test]
    fn basic_table_entries() {
        assert_success("sin(x)");
        assert_success("cos(x)");
        assert_success("exp(x)");
        assert_success("ln(x)");
        assert_success("1/(x^2 + 1)");
        assert_success("1/sqrt(1 - x^2)");
        assert_success("sqrt(1 - x^2)");
        assert_success("1/(4 - x^2)");
        assert_success("asin(x)");
        assert_success("atan(x)");
    }

    #[test]
    fn linear_inner_kernel() {
        assert_success("sin(2*x + 1)");
        assert_success("exp(3*x)");
        assert_success("1/(2*x + 1)");
        assert_success("sqrt(3*x + 2)");
        assert_success("(2*x + 1)^5");
    }

    #[test]
    fn integration_by_parts() {
        assert_success("x*exp(x)");
        assert_success("x*sin(x)");
        assert_success("x^2*exp(x)");
        assert_success("x*ln(x)");
    }

    #[test]
    fn rational_functions() {
        assert_success("1/(x^2 - 1)");
        assert_success("1/(x^2 + x + 1)");
        assert_success("(2*x + 1)/(x^2 + x + 1)");
        assert_success("(x + 1)/(x^2 + 1)");
        assert_success("(x^2 + 1)/(x - 1)");
        assert_success("1/(x*(x + 1))");
        assert_success("1/(x - 3)^2");
    }

    #[test]
    fn trig_powers() {
        assert_success("sin(x)^3");
        assert_success("cos(x)^2");
    }

    #[test]
    fn broader_textbook_cases_all_verify() {
        // 覆盖面清单:每一类至少两例,全部要求回代验证通过.
        for source in [
            // 幂与线性内核
            "x^7",
            "1/(3*x - 2)",
            "(5*x + 4)^3",
            "sqrt(x + 1)",
            // 指数/对数/三角
            "exp(2*x)",
            "x^3*exp(x)",
            "x*cos(x)",
            "x^2*ln(x)",
            "sin(3*x + 1)",
            "cos(x/2)",
            // 有理函数(部分分式:互异因子 / 重因子 / 不可约二次)
            "1/(x^2 - 4)",
            "1/(x*(x + 2))",
            "1/(x - 1)^3",
            "(3*x + 2)/(x^2 + 4)",
            "x/(x^2 + 1)",
            "1/(x^2 - x + 1)",
            "(x^2 + 2*x + 3)/(x + 1)",
            // 根式与反三角
            "1/sqrt(1 - 4*x^2)",
            "1/(9 + x^2)",
            "sqrt(1 - x^2)",
            "atan(x)",
            // 三角幂
            "sin(x)^5",
            "cos(x)^4",
            "sin(x)^2",
        ] {
            assert_success(source);
        }
    }

    #[test]
    fn out_of_scope_is_rejected_with_a_reason() {
        // 非初等:必须报错而不是给错答案.
        assert!(integrate("exp(x^2)").error.is_some());
        assert!(integrate("sin(x^2)").error.is_some());
        // 超出规则的初等形状(当前内核不做一般换元):同样要明确报错.
        let outcome = integrate("exp(sin(x))");
        assert!(outcome.error.is_some(), "{:?}", outcome.antiderivative_text);
        assert!(outcome.antiderivative_text.is_empty());
    }

    #[test]
    fn known_non_elementary_is_reported_not_solved() {
        let outcome = integrate("exp(x^2)");
        assert!(outcome.error.is_some(), "e^(x^2) 不应当给出原函数");
        assert!(outcome.antiderivative_text.is_empty());
        assert!(integrate("sin(x^2)").error.is_some());
    }

    #[test]
    fn undeclared_symbol_is_rejected() {
        let outcome = integrate("y*x");
        assert!(outcome.error.is_some());
        assert!(outcome.error.as_deref().expect("有理由").contains("未声明"));
    }

    #[test]
    fn coefficients_are_folded_into_numbers() {
        let coefficients = HashMap::from([("a".to_string(), 2.0)]);
        let outcome = antiderivative("sin(a*x)", "x", &coefficients).expect("应当能积分");
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(
            !outcome.antiderivative_text.contains('a'),
            "参数应当已折叠成数值: {}",
            outcome.antiderivative_text
        );
    }

    #[test]
    fn constant_integrand_short_circuits() {
        let outcome = integrate("5");
        assert!(outcome.error.is_none());
        assert_eq!(outcome.antiderivative_text, "5 * x");
    }

    #[test]
    fn empty_variable_is_an_input_error() {
        assert!(antiderivative("x", "  ", &HashMap::new()).is_err());
    }
}
