//! 单变量方程求解内核(保守式新增:见设计文档 `docs/equation-solving-process.md`
//! 第 6 节的三期口径).
//!
//! 产物是**独立类型** [`SolveOutcome`] / [`SolveStep`]:只有字符串与计数,
//! 不含 `Expr`.符号引擎内部表示(`Expr` 是 `pub(crate)`)不越过这一层,更不
//! 会变成项目级 API(路线图 §7.1 的结论).WASM 边界再把它序列化成 JSON,
//! 于是"三期只换数据源,UI 层零改动"这条口径在后端也成立.
//!
//! 能力边界(v1,**刻意保守**):
//! - 单变量,数值系数的**一次/二次**多项式方程;
//! - 参数名由调用方给当前值(与积分/分析同一条"系数"链路),不做符号系数代数;
//! - 二次方程分两条推导路径:
//!   - 首项系数为 1 且判别式是完全平方 -> 因式分解 + 零积律(与设计文档
//!     §4.1 的例子同形);
//!   - 其余 -> 求根公式;有理根给精确分式,无理根给根式 + 数值近似;
//! - 三次及以上**明确报错**,而不是给一个看起来像推导的东西.
//!
//! 每一步都带 `reason`(依据文案)与 `kind`(依据分区),分区取值与
//! `ui/process/processSteps.ts` 的 `ProcessStepKind` 同域:
//! `rule`(求根公式/零积律)/ `algebra`(移项/因式分解)/ `definition`(定义式)/
//! `numeric`(判别式取值/数值近似).

use std::collections::HashMap;

use serde::Serialize;

use super::latex::latex_number;
use super::parser::{parse_expr, rewrite_aliases, validate_supported};
use super::poly::{integer_sqrt, Poly};
use super::printing::{format_expr, PrintMode};
use super::{collect_symbols, BinOp, Expr};

/** 依据分区:法则. */
const KIND_RULE: &str = "rule";
/** 依据分区:代数化简. */
const KIND_ALGEBRA: &str = "algebra";
/** 依据分区:定义式. */
const KIND_DEFINITION: &str = "definition";
/** 依据分区:数值. */
const KIND_NUMERIC: &str = "numeric";

/// 一步求解过程:一行 LaTeX + 依据文案 + 依据分区.
///
/// 独立类型的第一层:它不引用 `Expr`,只带渲染需要的字符串.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SolveStep {
    pub latex: String,
    pub reason: String,
    pub kind: String,
}

/// 一条方程的求解结果.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SolveOutcome {
    /// 求解变量名.
    pub variable: String,
    /// 题目(原方程的 LaTeX,保留用户写法).
    pub equation_latex: String,
    /// 解集 LaTeX;无实数解或恒等式之外没有解时为 `None`.
    pub solution_latex: Option<String>,
    /// 实数解个数;恒等式用 `usize::MAX` 不表达,这里对恒等式给 0 并在 steps 里说明.
    pub real_root_count: usize,
    /// 恒等式(任意实数都是解)标记:与"无解"必须区分.
    pub identity: bool,
    pub steps: Vec<SolveStep>,
}

fn step(latex: impl Into<String>, reason: &str, kind: &str) -> SolveStep {
    SolveStep {
        latex: latex.into(),
        reason: reason.to_string(),
        kind: kind.to_string(),
    }
}

/// 把方程文本按**顶层**等号切成左右两段.
///
/// 只需处理括号深度:函数调用/数组字面量里的 `=` 不可能是方程的等号,而
/// 本项目 DSL 也没有 `==` 运算符.
fn split_equation(source: &str) -> Result<(&str, &str), String> {
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

/// 未显式给 `variable` 时从方程里推断:恰好一个"既不是内置常量也不是已声明
/// 参数"的自由符号才算唯一未知量.
fn infer_variable(expr: &Expr, coefficients: &HashMap<String, f64>) -> Result<String, String> {
    let mut names = Vec::new();
    collect_symbols(expr, &mut names);
    let mut unknown: Vec<String> = Vec::new();
    for name in names {
        if coefficients.contains_key(&name) || unknown.contains(&name) {
            continue;
        }
        unknown.push(name);
    }
    match unknown.len() {
        0 => Err("方程里没有未知量".to_string()),
        1 => Ok(unknown.remove(0)),
        _ => Err(format!(
            "方程含多个未知量({}),请用 variable 选项指定要求解哪一个",
            unknown.join(", ")
        )),
    }
}

/// 负数加括号(幂底数与乘积因子位置),其余原样.
fn parenthesize_number(value: f64) -> String {
    if value < 0.0 {
        format!("({})", latex_number(value))
    } else {
        latex_number(value)
    }
}

/// 去掉 `-0.0`:展示层不该出现 "-0".
fn without_negative_zero(value: f64) -> f64 {
    if value == 0.0 {
        0.0
    } else {
        value
    }
}

/// 未知量的一次项 `c x`(`c` 为 1 时省略系数).
fn linear_term(coeff: f64, variable: &str) -> String {
    let symbol = super::latex::latex_symbol(variable);
    match coeff {
        1.0 => symbol,
        -1.0 => format!("-{symbol}"),
        _ => format!("{}{}", latex_number(coeff), symbol),
    }
}

/// `num/den` 的精确分式 LaTeX;两者都是整数时约分,返回 `None` 表示不适合分数.
fn rational_latex(numerator: f64, denominator: f64) -> Option<String> {
    if denominator == 0.0 {
        return None;
    }
    let numerator_rounded = numerator.round();
    let denominator_rounded = denominator.round();
    if (numerator - numerator_rounded).abs() > 1e-9
        || (denominator - denominator_rounded).abs() > 1e-9
    {
        return None;
    }
    let mut numerator = numerator_rounded as i64;
    let mut denominator = denominator_rounded as i64;
    if denominator < 0 {
        numerator = -numerator;
        denominator = -denominator;
    }
    let divisor = gcd(numerator.unsigned_abs(), denominator.unsigned_abs());
    if divisor > 1 {
        numerator /= divisor as i64;
        denominator /= divisor as i64;
    }
    Some(if denominator == 1 {
        format!("{numerator}")
    } else {
        format!("\\frac{{{numerator}}}{{{denominator}}}")
    })
}

fn gcd(left: u64, right: u64) -> u64 {
    if right == 0 {
        left
    } else {
        gcd(right, left % right)
    }
}

/// `(x - root)` 的因式;整数根时系数是整数.
fn factor_latex(root: f64, variable: &str) -> String {
    let symbol = super::latex::latex_symbol(variable);
    if root == 0.0 {
        return symbol;
    }
    if root > 0.0 {
        format!("\\left({symbol} - {}\\right)", latex_number(root))
    } else {
        format!("\\left({symbol} + {}\\right)", latex_number(-root))
    }
}

/// 零积律里的一元一次方程 `x - root = 0`(根为负时写成 `x + |root| = 0`).
fn linear_factor_equation(root: f64, variable: &str) -> String {
    if root == 0.0 {
        return format!("{variable} = 0");
    }
    if root > 0.0 {
        format!("{variable} - {} = 0", latex_number(root))
    } else {
        format!("{variable} + {} = 0", latex_number(-root))
    }
}

/// 二次方程整数系数的判别式完全平方检测:返回 `sqrt(Delta)`.
fn integer_discriminant(a: f64, b: f64, c: f64) -> Option<i64> {
    let (a_rounded, b_rounded, c_rounded) = (a.round(), b.round(), c.round());
    if (a - a_rounded).abs() > 1e-9 || (b - b_rounded).abs() > 1e-9 || (c - c_rounded).abs() > 1e-9
    {
        return None;
    }
    if a_rounded.abs() > 1e6 || b_rounded.abs() > 1e6 || c_rounded.abs() > 1e6 {
        return None;
    }
    if a_rounded == 0.0 {
        return None;
    }
    integer_sqrt(b_rounded * b_rounded - 4.0 * a_rounded * c_rounded)
}

/// 一次方程:`b x + c = 0` -> `x = -c/b`.
fn solve_linear(variable: &str, poly: &Poly) -> (Vec<SolveStep>, Option<String>, usize, bool) {
    let b = poly.coeff(1);
    let c = poly.coeff(0);
    let mut steps = Vec::new();

    if c != 0.0 {
        steps.push(step(
            format!(
                "{} = {}",
                linear_term(b, variable),
                latex_number(without_negative_zero(-c))
            ),
            "移项",
            KIND_ALGEBRA,
        ));
    }
    let root = without_negative_zero(-c / b);
    let root_latex = rational_latex(-c, b).unwrap_or_else(|| latex_number(root));
    steps.push(step(
        format!("{variable} = {root_latex}"),
        "两边同除未知量系数",
        KIND_ALGEBRA,
    ));
    let solution = format!("{variable} = {root_latex}");
    (steps, Some(solution), 1, false)
}

/// 二次方程:`a x^2 + b x + c = 0`.
fn solve_quadratic(variable: &str, poly: &Poly) -> (Vec<SolveStep>, Option<String>, usize, bool) {
    let a = poly.coeff(2);
    let b = poly.coeff(1);
    let c = poly.coeff(0);
    let mut steps = Vec::new();

    // 首项系数为 1 且判别式是完全平方(正) -> 因式分解 + 零积律.这是课堂
    // 板书路径,与设计文档 §4.1 的例子同形;分解本身就是依据,再插一行判别式
    // 只会打断节奏,所以这条路径不显示 Δ.
    if a == 1.0 {
        if let Some(root_of_discriminant) = integer_discriminant(a, b, c) {
            if root_of_discriminant > 0 {
                let first = (-b - root_of_discriminant as f64) / 2.0;
                let second = (-b + root_of_discriminant as f64) / 2.0;
                steps.push(step(
                    format!(
                        "{}{} = 0",
                        factor_latex(first, variable),
                        factor_latex(second, variable),
                    ),
                    "因式分解",
                    KIND_ALGEBRA,
                ));
                steps.push(step(
                    format!(
                        "{} \\quad\\text{{或}}\\quad {}",
                        linear_factor_equation(first, variable),
                        linear_factor_equation(second, variable),
                    ),
                    "零积律",
                    KIND_RULE,
                ));
                let solution = format!(
                    "{variable} = {} \\quad\\text{{或}}\\quad {variable} = {}",
                    latex_number(first),
                    latex_number(second),
                );
                steps.push(step(solution.clone(), "移项", KIND_ALGEBRA));
                return (steps, Some(solution), 2, false);
            }
        }
    }

    let discriminant = b * b - 4.0 * a * c;
    steps.push(step(
        format!(
            "\\Delta = {}^{{2}} - 4 \\cdot {} \\cdot {} = {}",
            parenthesize_number(b),
            parenthesize_number(a),
            parenthesize_number(c),
            latex_number(discriminant),
        ),
        "判别式",
        KIND_NUMERIC,
    ));

    if discriminant < 0.0 {
        steps.push(step(
            "\\Delta < 0 \\;\\Rightarrow\\; \\text{方程无实数解}",
            "判别式",
            KIND_NUMERIC,
        ));
        return (steps, None, 0, false);
    }

    if discriminant == 0.0 {
        let root = without_negative_zero(-b / (2.0 * a));
        let root_latex = rational_latex(-b, 2.0 * a).unwrap_or_else(|| latex_number(root));
        steps.push(step(
            format!("{variable} = \\frac{{-b}}{{2a}} = {root_latex}"),
            "求根公式(重根)",
            KIND_RULE,
        ));
        let solution = format!("{variable} = {root_latex}");
        return (steps, Some(solution), 1, false);
    }

    // 一般路径:求根公式.有理根给精确分式,无理根给根式加数值近似.
    if let Some(root_of_discriminant) = integer_discriminant(a, b, c) {
        let first = rational_latex(-b - root_of_discriminant as f64, 2.0 * a);
        let second = rational_latex(-b + root_of_discriminant as f64, 2.0 * a);
        if let (Some(first), Some(second)) = (first, second) {
            steps.push(step(
                format!(
                    "{variable} = \\frac{{{} \\pm {}}}{{{}}}",
                    latex_number(without_negative_zero(-b)),
                    latex_number(root_of_discriminant as f64),
                    latex_number(2.0 * a),
                ),
                "求根公式",
                KIND_RULE,
            ));
            let solution =
                format!("{variable} = {first} \\quad\\text{{或}}\\quad {variable} = {second}");
            steps.push(step(solution.clone(), "化简", KIND_ALGEBRA));
            return (steps, Some(solution), 2, false);
        }
    }

    let first = without_negative_zero((-b - discriminant.sqrt()) / (2.0 * a));
    let second = without_negative_zero((-b + discriminant.sqrt()) / (2.0 * a));
    steps.push(step(
        format!(
            "{variable} = \\frac{{{} \\pm \\sqrt{{{}}}}}{{{}}}",
            latex_number(without_negative_zero(-b)),
            latex_number(discriminant),
            latex_number(2.0 * a),
        ),
        "求根公式",
        KIND_RULE,
    ));
    steps.push(step(
        format!(
            "{variable}_1 \\approx {},\\quad {variable}_2 \\approx {}",
            latex_number(first),
            latex_number(second),
        ),
        "数值近似",
        KIND_NUMERIC,
    ));
    let solution = format!(
        "{variable} = \\frac{{{} \\pm \\sqrt{{{}}}}}{{{}}}",
        latex_number(without_negative_zero(-b)),
        latex_number(discriminant),
        latex_number(2.0 * a),
    );
    (steps, Some(solution), 2, false)
}

/// 从"移项后的多项式"继续推导,返回(步骤, 解集, 实数解个数, 是否恒等式).
fn solve_polynomial(
    variable: &str,
    poly: &Poly,
) -> Result<(Vec<SolveStep>, Option<String>, usize, bool), String> {
    match poly.degree() {
        None => {
            // 移项后恒为 0:原方程是恒等式.
            Ok((
                vec![step(
                    "0 = 0 \\;\\Rightarrow\\; \\text{恒等式,任意实数都是解}",
                    "化简",
                    KIND_ALGEBRA,
                )],
                None,
                0,
                true,
            ))
        }
        Some(0) => Ok((
            vec![step(
                "\\text{矛盾:常数不为 0} \\;\\Rightarrow\\; \\text{无解}",
                "化简",
                KIND_ALGEBRA,
            )],
            None,
            0,
            false,
        )),
        Some(1) => Ok(solve_linear(variable, poly)),
        Some(2) => Ok(solve_quadratic(variable, poly)),
        Some(degree) => Err(format!(
            "求解内核目前只支持一次/二次方程,当前方程的次数是 {degree};三次以上留待后续分期"
        )),
    }
}

/// 方程求解入口.
///
/// - `equation`:DSL 里写的方程原文(必须含一个顶层 `=`);
/// - `variable`:`variable` 选项的值;`None`/空串表示从方程推断;
/// - `coefficients`:参数名 -> 当前值(与积分/分析同一条链路).
pub fn solve_equation(
    equation: &str,
    variable: Option<&str>,
    coefficients: &[(String, f64)],
) -> Result<SolveOutcome, String> {
    let source = equation.trim();
    if source.is_empty() {
        return Err("方程不能为空".to_string());
    }
    let (lhs_text, rhs_text) = split_equation(source)?;

    // 排版用解析出的原树(保留 `pi`/别名写法),代数用别名展开后的树.
    let lhs_parsed = parse_expr(lhs_text)?;
    let rhs_parsed = parse_expr(rhs_text)?;
    let lhs = rewrite_aliases(&lhs_parsed)?;
    let rhs = rewrite_aliases(&rhs_parsed)?;
    validate_supported(&lhs)?;
    validate_supported(&rhs)?;

    let coefficient_map: HashMap<String, f64> = coefficients.iter().cloned().collect();
    // 右端本来就是 0 时,"移项"这一步没有信息量(原式已经是标准形),不补冗余行.
    let rhs_is_zero = matches!(&rhs, Expr::Num(value) if *value == 0.0);
    let difference = Expr::Binary(BinOp::Sub, Box::new(lhs), Box::new(rhs));

    let variable = match variable {
        Some(name) if !name.trim().is_empty() => name.trim().to_string(),
        _ => infer_variable(&difference, &coefficient_map)?,
    };

    let poly = Poly::from_expr(&difference, &variable, &coefficient_map)?;

    let equation_latex = format!(
        "{}={}",
        format_expr(&lhs_parsed, PrintMode::Latex, 0),
        format_expr(&rhs_parsed, PrintMode::Latex, 0),
    );

    let mut steps = vec![step(equation_latex.clone(), "原式", KIND_DEFINITION)];
    if !rhs_is_zero {
        steps.push(step(
            format!("{}=0", poly.to_latex(&variable)),
            "移项,合并同类项",
            KIND_ALGEBRA,
        ));
    }

    let (tail, solution_latex, real_root_count, identity) = solve_polynomial(&variable, &poly)?;
    steps.extend(tail);

    Ok(SolveOutcome {
        variable,
        equation_latex,
        solution_latex,
        real_root_count,
        identity,
        steps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solve(equation: &str) -> SolveOutcome {
        solve_equation(equation, None, &[]).expect("应当可解")
    }

    fn reasons(outcome: &SolveOutcome) -> Vec<&str> {
        outcome
            .steps
            .iter()
            .map(|entry| entry.reason.as_str())
            .collect()
    }

    #[test]
    fn factors_monic_quadratic_with_integer_roots() {
        let outcome = solve("x^2 - 5*x + 6 = 0");

        assert_eq!(outcome.variable, "x");
        assert_eq!(outcome.real_root_count, 2);
        assert!(!outcome.identity);
        let solution = outcome.solution_latex.as_deref().expect("有实数解");
        assert!(solution.contains("x = 2"), "{solution}");
        assert!(solution.contains("x = 3"), "{solution}");

        // 板书路径:原式 -> 因式分解 -> 零积律 -> 移项.
        assert_eq!(
            reasons(&outcome),
            vec!["原式", "因式分解", "零积律", "移项"]
        );
        assert_eq!(outcome.steps[0].kind, KIND_DEFINITION);
        assert_eq!(outcome.steps[1].kind, KIND_ALGEBRA);
        assert_eq!(outcome.steps[2].kind, KIND_RULE);
        assert!(
            outcome.steps[1].latex.contains("x - 2") && outcome.steps[1].latex.contains("x - 3"),
            "{}",
            outcome.steps[1].latex
        );
        assert!(
            outcome.steps[2].latex.contains("x - 2 = 0"),
            "{}",
            outcome.steps[2].latex
        );
    }

    #[test]
    fn factors_quadratic_missing_linear_term() {
        let outcome = solve("x^2 - 4 = 0");
        let solution = outcome.solution_latex.as_deref().expect("有实数解");

        assert_eq!(outcome.real_root_count, 2);
        assert!(solution.contains("x = -2"), "{solution}");
        assert!(solution.contains("x = 2"), "{solution}");
        assert!(
            outcome.steps[1].latex.contains("x + 2"),
            "{}",
            outcome.steps[1].latex
        );
        // 根为负时零积律写 `x + 2 = 0`,不能写成 `x - -2 = 0`.
        assert!(
            outcome.steps[2].latex.contains("x + 2 = 0"),
            "{}",
            outcome.steps[2].latex
        );
    }

    #[test]
    fn negative_discriminant_has_no_real_roots() {
        let outcome = solve("x^2 + 1 = 0");

        assert_eq!(outcome.real_root_count, 0);
        assert!(outcome.solution_latex.is_none());
        assert!(!outcome.identity);
        assert_eq!(reasons(&outcome), vec!["原式", "判别式", "判别式"]);
        assert!(
            outcome.steps[1].latex.contains("\\Delta"),
            "{}",
            outcome.steps[1].latex
        );
    }

    #[test]
    fn zero_discriminant_gives_double_root() {
        let outcome = solve("x^2 - 2*x + 1 = 0");

        assert_eq!(outcome.real_root_count, 1);
        let solution = outcome.solution_latex.as_deref().expect("有实数解");
        assert!(solution.contains("x = 1"), "{solution}");
        assert_eq!(reasons(&outcome), vec!["原式", "判别式", "求根公式(重根)"]);
    }

    #[test]
    fn non_monic_quadratic_with_rational_roots() {
        let outcome = solve("2*x^2 - 3*x + 1 = 0");

        assert_eq!(outcome.real_root_count, 2);
        let solution = outcome.solution_latex.as_deref().expect("有实数解");
        assert!(solution.contains("\\frac{1}{2}"), "{solution}");
        assert!(solution.contains("x = 1"), "{solution}");
        assert_eq!(
            reasons(&outcome),
            vec!["原式", "判别式", "求根公式", "化简"]
        );
    }

    #[test]
    fn irrational_roots_get_surd_and_numeric_steps() {
        let outcome = solve("x^2 - 2 = 0");

        assert_eq!(outcome.real_root_count, 2);
        let solution = outcome.solution_latex.as_deref().expect("有实数解");
        assert!(solution.contains("\\sqrt{8}"), "{solution}");
        assert_eq!(
            reasons(&outcome),
            vec!["原式", "判别式", "求根公式", "数值近似"]
        );
        assert_eq!(outcome.steps[3].kind, KIND_NUMERIC);
    }

    #[test]
    fn linear_equation_moves_terms_then_divides() {
        let outcome = solve("2*x + 3 = x - 1");

        assert_eq!(outcome.real_root_count, 1);
        let solution = outcome.solution_latex.as_deref().expect("有解");
        assert_eq!(solution, "x = -4");
        assert_eq!(
            reasons(&outcome),
            vec!["原式", "移项,合并同类项", "移项", "两边同除未知量系数"]
        );
        // 标准形一步给出移项合并后的 `x + 4 = 0`.
        assert_eq!(outcome.steps[1].latex, "x + 4=0");
    }

    #[test]
    fn linear_equation_without_constant_term() {
        let outcome = solve("3*x = 0");

        assert_eq!(outcome.solution_latex.as_deref(), Some("x = 0"));
        // 右端本来就是 0:不补"移项"标准形这一步.
        assert_eq!(reasons(&outcome), vec!["原式", "两边同除未知量系数"]);
    }

    #[test]
    fn identity_and_contradiction_are_distinguished() {
        // 没有未知量可推断时要求显式给变量:恒等式/矛盾式仍然可解.
        let identity = solve_equation("0 = 0", Some("x"), &[]).expect("恒等式");
        assert!(identity.identity);
        assert!(identity.solution_latex.is_none());
        assert_eq!(identity.real_root_count, 0);

        let contradiction = solve_equation("3 = 0", Some("x"), &[]).expect("矛盾式");
        assert!(!contradiction.identity);
        assert!(contradiction.solution_latex.is_none());
    }

    #[test]
    fn coefficients_come_from_declared_parameters() {
        let with_parameter =
            solve_equation("a*x - 6 = 0", None, &[("a".to_string(), 3.0)]).expect("参数已声明");

        assert_eq!(with_parameter.variable, "x");
        assert_eq!(with_parameter.solution_latex.as_deref(), Some("x = 2"));

        let quadratic =
            solve_equation("a*x^2 - 4 = 0", None, &[("a".to_string(), 1.0)]).expect("参数已声明");
        assert!(quadratic.solution_latex.unwrap().contains("x = 2"));
    }

    #[test]
    fn explicit_variable_selects_the_unknown() {
        let outcome = solve_equation("t^2 - 9 = 0", Some("t"), &[]).expect("可用 t 求解");
        assert_eq!(outcome.variable, "t");
        assert!(outcome.solution_latex.as_deref().unwrap().contains("t = 3"));
    }

    #[test]
    fn rejects_non_polynomial_and_multi_unknown() {
        let multiple = solve_equation("x + y = 0", None, &[]).unwrap_err();
        assert!(multiple.contains("多个未知量"), "{multiple}");

        let undeclared = solve_equation("x + y = 0", Some("x"), &[]).unwrap_err();
        assert!(undeclared.contains("未声明参数 y"), "{undeclared}");

        let transcendental = solve_equation("sin(x) = 0", None, &[]).unwrap_err();
        assert!(transcendental.contains("非多项式"), "{transcendental}");

        let missing_equals = solve_equation("x + 1", None, &[]).unwrap_err();
        assert!(missing_equals.contains("缺少等号"), "{missing_equals}");
    }

    #[test]
    fn rejects_degree_above_two_and_over_cap_degree() {
        let cubic = solve_equation("x^3 - 1 = 0", None, &[]).unwrap_err();
        assert!(cubic.contains("只支持一次/二次"), "{cubic}");

        let too_deep = solve_equation("(x + 1)^20 = 0", None, &[]).unwrap_err();
        assert!(too_deep.contains("上限"), "{too_deep}");
    }
}
