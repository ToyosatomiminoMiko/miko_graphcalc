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
    /// 求解变量名;推断不出未知量时为空串.
    pub variable: String,
    /// 题目(原方程的 LaTeX,保留用户写法).
    ///
    /// **能力边界错误也照给**:方程已经解析成功,题目就该排成公式--调用方
    /// 不该因为"解不出来"而退回纯文本原文(见 `error`).
    pub equation_latex: String,
    /// 解集 LaTeX;无实数解或恒等式之外没有解时为 `None`.
    pub solution_latex: Option<String>,
    /// 实数解个数;恒等式用 `usize::MAX` 不表达,这里对恒等式给 0 并在 steps 里说明.
    pub real_root_count: usize,
    /// 恒等式(任意实数都是解)标记:与"无解"必须区分.
    pub identity: bool,
    pub steps: Vec<SolveStep>,
    /// 能力边界错误(多未知量/三次以上/非多项式/未声明参数);`None` 表示求解成功.
    ///
    /// 它是**结果的一部分**,不是调用层的失败:源码没写错,只是这条方程超出
    /// 内核能力.所以方程能解析时一律走这条通道返回(而不是 `Err`),`Err` 只留给
    /// "方程文本本身读不出来"(缺等号/多个等号/解析失败)这类真正的输入错误.
    #[serde(rename = "error")]
    pub error_message: Option<String>,
}

fn step(latex: impl Into<String>, reason: &str, kind: &str) -> SolveStep {
    SolveStep {
        latex: latex.into(),
        reason: reason.to_string(),
        kind: kind.to_string(),
    }
}

/// 方程里实际用到的**参数**(即系数),按在方程文本里出现的先后去重.
///
/// 只认调用方给了值的名字:它们是"当前系数",读板书的人要靠它们把符号换成数
/// (拖动滑块时这条就是唯一能看出系数变了的地方).`x` 这种未知量不在
/// `coefficients` 里,自然不会被列成系数.
///
/// 文本匹配加了一层边界判断(`a` 不会匹配 `ax`/`a_1`),避免子串误判;
/// `a^2`/`a*x` 这类正常写法两边都是运算符,照样命中.
fn equation_parameters(source: &str, coefficients: &HashMap<String, f64>) -> Vec<String> {
    let bytes = source.as_bytes();
    let mut used = Vec::new();

    for (index, _) in source.char_indices() {
        if index > 0 {
            let previous = bytes[index - 1];
            if previous.is_ascii_alphanumeric() || previous == b'_' {
                continue;
            }
        }
        let mut end = index;
        while end < source.len() && bytes[end].is_ascii_alphanumeric() {
            end += 1;
        }
        // 名字本身必须是完整标识符(后面不接字母/下划线/数字).
        if end == index || end >= source.len() {
            continue;
        }
        let following = bytes[end];
        if following == b'_' {
            continue;
        }
        let name = &source[index..end];
        if coefficients.contains_key(name) && !used.iter().any(|entry| entry == name) {
            used.push(name.to_string());
        }
    }

    used
}

/// "参数取值"那一步的 LaTeX:方程与 `a=1` 一行一项,叠成两行.
///
/// 用 `gathered` 而不是把 `a=1` 接在等号后面:参数多起来(或方程本身很长)时
/// 一行放不下,横向滚动会把最关键的系数挤到屏幕外.步内换行是 LaTeX 自己的
/// 排版,不动过程页"一行一步"的结构.
fn parameter_values_latex(equation_latex: &str, entries: &[String]) -> String {
    let mut stacked = equation_latex.to_string();
    for entry in entries {
        stacked.push_str(" \\\\ ");
        stacked.push_str(entry);
    }
    format!("\\begin{{gathered}} {stacked} \\end{{gathered}}")
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

/// 求根公式里 `\sqrt{...}` 的内容:判别式是完全平方时给**精确的根**,
/// 否则给判别式本身(与有理根路径同一份"能精确就精确"的口径).
fn surd_latex(discriminant: f64) -> String {
    integer_sqrt(discriminant)
        .map(|value| value as f64)
        .unwrap_or(discriminant)
        .to_string()
}

/// 求根公式分子:普通情况是 `-b \pm \sqrt{\Delta}`;重根(`\Delta = 0`)时只有
/// 一个值,不写 `\pm \sqrt{0}` 这种装饰性根号(也不留 `+ 0` 的排版噪音).
fn quadratic_numerator_latex(b: f64, discriminant: f64) -> String {
    let minus_b = without_negative_zero(-b);
    if discriminant == 0.0 {
        return latex_number(minus_b);
    }
    let signed = if minus_b < 0.0 {
        latex_number(minus_b)
    } else {
        format!("+ {}", latex_number(minus_b))
    };
    format!("{signed} \\pm \\sqrt{{{}}}", surd_latex(discriminant))
}

/// 已代入系数的求根公式 `x = \frac{-b \pm \sqrt{\Delta}}{2a}` 的 LaTeX.
///
/// 板书口径:系数一律换成当前数值,不在换元之后停在 `-b` / `2a` 这样的字母上
/// (判别式那一步早就这么做了,两处必须同形).
fn quadratic_formula_latex(variable: &str, a: f64, b: f64, discriminant: f64) -> String {
    let symbol = super::latex::latex_symbol(variable);
    format!(
        "{symbol} = \\frac{{{}}}{{{}}}",
        quadratic_numerator_latex(b, discriminant),
        latex_number(2.0 * a),
    )
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
            format!(
                "{} = {root_latex}",
                quadratic_formula_latex(variable, a, b, discriminant)
            ),
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
                quadratic_formula_latex(variable, a, b, discriminant),
                "求根公式",
                KIND_RULE,
            ));
            let solution =
                format!("{variable} = {first} \\quad\\text{{或}}\\quad {variable} = {second}");
            steps.push(step(solution.clone(), "化简", KIND_ALGEBRA));
            return (steps, Some(solution), 2, false);
        }
    }

    let root_of_discriminant = discriminant.sqrt();
    let first = without_negative_zero((-b - root_of_discriminant) / (2.0 * a));
    let second = without_negative_zero((-b + root_of_discriminant) / (2.0 * a));
    steps.push(step(
        quadratic_formula_latex(variable, a, b, discriminant),
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
    let solution = quadratic_formula_latex(variable, a, b, discriminant);
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
///
/// 返回 `Err` 只表示**方程文本读不出来**(缺等号/多个等号/表达式解析失败);
/// "读出来了但超出内核能力"落在 [`SolveOutcome::error_message`],题目 LaTeX 照给.
pub fn solve_equation(
    equation: &str,
    variable: Option<&str>,
    coefficients: &[(String, f64)],
) -> Result<SolveOutcome, String> {
    let source = equation.trim();
    // 空方程没有可排的题目:走结构化错误,让调用方拿到与其它能力边界一致的结果.
    if source.is_empty() {
        return Ok(failure(None, "方程不能为空"));
    }
    let (lhs_text, rhs_text) = split_equation(source)?;

    // 排版用解析出的原树(保留 `pi`/别名写法),代数用别名展开后的树.
    let lhs_parsed = parse_expr(lhs_text)?;
    let rhs_parsed = parse_expr(rhs_text)?;
    let lhs = rewrite_aliases(&lhs_parsed)?;
    let rhs = rewrite_aliases(&rhs_parsed)?;
    validate_supported(&lhs)?;
    validate_supported(&rhs)?;

    let equation_latex = format!(
        "{}={}",
        format_expr(&lhs_parsed, PrintMode::Latex, 0),
        format_expr(&rhs_parsed, PrintMode::Latex, 0),
    );

    let coefficient_map: HashMap<String, f64> = coefficients.iter().cloned().collect();
    // 右端本来就是 0 时,"移项"这一步没有信息量(原式已经是标准形),不补冗余行.
    let rhs_is_zero = matches!(&rhs, Expr::Num(value) if *value == 0.0);
    let difference = Expr::Binary(BinOp::Sub, Box::new(lhs), Box::new(rhs));

    let variable = match variable {
        Some(name) if !name.trim().is_empty() => name.trim().to_string(),
        _ => match infer_variable(&difference, &coefficient_map) {
            Ok(name) => name,
            Err(message) => return Ok(failure(Some(equation_latex), &message)),
        },
    };

    let poly = match Poly::from_expr(&difference, &variable, &coefficient_map) {
        Ok(poly) => poly,
        Err(message) => return Ok(failure(Some(equation_latex), &message)),
    };

    let mut steps = vec![step(equation_latex.clone(), "原式", KIND_DEFINITION)];
    // 系数是参数时,紧跟着把"当前取值"逐条写出来:拖动系数之后,这一行是读者
    // 唯一能看出"代进去的数变了"的地方(方程本身仍写 `a x^{2}`,不隐藏符号).
    let parameters = equation_parameters(source, &coefficient_map);
    if !parameters.is_empty() {
        let entries: Vec<String> = parameters
            .iter()
            .map(|name| {
                format!(
                    "{}={}",
                    super::latex::latex_symbol(name),
                    latex_number(coefficient_map[name]),
                )
            })
            .collect();
        steps.push(step(
            parameter_values_latex(&equation_latex, &entries),
            "参数取值",
            KIND_NUMERIC,
        ));
    }
    if !rhs_is_zero {
        steps.push(step(
            format!("{}=0", poly.to_latex(&variable)),
            "移项,合并同类项",
            KIND_ALGEBRA,
        ));
    }

    let (tail, solution_latex, real_root_count, identity) = match solve_polynomial(&variable, &poly)
    {
        Ok(solved) => solved,
        Err(message) => return Ok(failure(Some(equation_latex), &message)),
    };
    steps.extend(tail);

    Ok(SolveOutcome {
        variable,
        equation_latex,
        solution_latex,
        real_root_count,
        identity,
        steps,
        error_message: None,
    })
}

/// 能力边界结果:题目 LaTeX 尽可能保留(`equation_latex` 为 `None` 时才留空),
/// `steps` 为空(没有可展示的推导),`error_message` 给出可读理由.
fn failure(equation_latex: Option<String>, error_message: &str) -> SolveOutcome {
    SolveOutcome {
        variable: String::new(),
        equation_latex: equation_latex.unwrap_or_default(),
        solution_latex: None,
        real_root_count: 0,
        identity: false,
        steps: Vec::new(),
        error_message: Some(error_message.to_string()),
    }
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
        // 重根只有一个值:公式里的字母要换成数,且不留 `\pm \sqrt{0}` 与 `+ 0`.
        let formula = &outcome.steps[2].latex;
        assert_eq!(formula, "x = \\frac{2}{2} = 1");
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
        // 板书口径:系数换元后不留字母,完全平方的判别式给精确根号.
        let formula = &outcome.steps[2].latex;
        assert_eq!(formula, "x = \\frac{+ 3 \\pm \\sqrt{1}}{4}");
        assert!(
            !formula.contains("2a") && !formula.contains("-b"),
            "{formula}"
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
        assert_eq!(outcome.steps[2].latex, "x = \\frac{+ 0 \\pm \\sqrt{8}}{2}");
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
    fn quadratic_steps_substitute_the_coefficients() {
        // 题目里的 a 是参数:换元之后公式里必须是当前数值,不能停在字母上.
        let outcome =
            solve_equation("a*x^2 - 2 = 0", None, &[("a".to_string(), 1.0)]).expect("可解");
        let formula = outcome
            .steps
            .iter()
            .find(|entry| entry.reason == "求根公式")
            .expect("应当有求根公式一步")
            .latex
            .clone();

        assert_eq!(formula, "x = \\frac{+ 0 \\pm \\sqrt{8}}{2}");
        assert!(!formula.contains("2a"), "{formula}");
        assert!(!formula.contains("-b"), "{formula}");
        // 判别式那一步早就是代入形式,两步口径必须一致.
        let discriminant = outcome
            .steps
            .iter()
            .find(|entry| entry.reason == "判别式")
            .expect("应当有判别式一步");
        assert!(discriminant.latex.contains("4 \\cdot 1 \\cdot (-2)"));

        // 系数取值单独成一步:方程 + `a=1`,叠成两行(参数多时不会横向挤出屏幕).
        let values = outcome
            .steps
            .iter()
            .find(|entry| entry.reason == "参数取值")
            .expect("参数是系数时应当给出取值一步");
        assert_eq!(
            values.latex,
            "\\begin{gathered} a\\,x^{2} - 2=0 \\\\ a=1 \\end{gathered}"
        );
        assert_eq!(values.kind, KIND_NUMERIC);
    }

    #[test]
    fn parameter_values_step_lists_only_parameters_the_equation_uses() {
        // 声明了 a 但方程里没有:不该出现在"参数取值"里(它影响不了这道题).
        let outcome = solve_equation(
            "k*x^2 + m*x - 2 = 0",
            None,
            &[
                ("k".to_string(), 1.0),
                ("m".to_string(), 2.0),
                ("unused".to_string(), 9.0),
            ],
        )
        .expect("可解");
        let values = outcome
            .steps
            .iter()
            .find(|entry| entry.reason == "参数取值")
            .expect("应当有参数取值一步");

        // 顺序跟着方程里出现的先后,不跟参数表.
        assert_eq!(
            values.latex,
            "\\begin{gathered} k\\,x^{2} + m\\,x - 2=0 \\\\ k=1 \\\\ m=2 \\end{gathered}"
        );
        assert!(!values.latex.contains("unused"));

        // 系数全是数值时没有这一步:空壳不给.
        let numeric = solve_equation("x^2 - 2 = 0", None, &[]).expect("可解");
        assert!(!numeric.steps.iter().any(|entry| entry.reason == "参数取值"));
    }

    #[test]
    fn parameter_names_are_matched_as_whole_identifiers() {
        // `a` 不能匹配到 `ax` 或 `a_1`:那是另一个名字,取值写出来就是错的.
        let outcome = solve_equation(
            "a*x - 3 = 0",
            None,
            &[("a".to_string(), 2.0), ("ax".to_string(), 5.0)],
        )
        .expect("可解");
        let values = outcome
            .steps
            .iter()
            .find(|entry| entry.reason == "参数取值")
            .expect("应当有参数取值一步");

        assert!(values.latex.contains("a=2"));
        assert!(!values.latex.contains("ax=5"));
    }

    #[test]
    fn explicit_variable_selects_the_unknown() {
        let outcome = solve_equation("t^2 - 9 = 0", Some("t"), &[]).expect("可用 t 求解");
        assert_eq!(outcome.variable, "t");
        assert!(outcome.solution_latex.as_deref().unwrap().contains("t = 3"));
    }

    #[test]
    fn rejects_non_polynomial_and_multi_unknown() {
        // 能力边界错误是**结果的一部分**:方程解析成功,所以题目 LaTeX 照给,
        // 只有"方程文本读不出来"才走 Err.
        let multiple = solve_equation("x + y = 0", None, &[])
            .expect("能力边界不抛错")
            .error_message
            .expect("多未知量应当给理由");
        assert!(multiple.contains("多个未知量"), "{multiple}");

        let undeclared = solve_equation("x + y = 0", Some("x"), &[])
            .expect("能力边界不抛错")
            .error_message
            .expect("未声明参数应当给理由");
        assert!(undeclared.contains("未声明参数 y"), "{undeclared}");

        let transcendental = solve_equation("sin(x) = 0", None, &[])
            .expect("能力边界不抛错")
            .error_message
            .expect("非多项式应当给理由");
        assert!(transcendental.contains("非多项式"), "{transcendental}");

        let missing_equals = solve_equation("x + 1", None, &[]).unwrap_err();
        assert!(missing_equals.contains("缺少等号"), "{missing_equals}");
    }

    #[test]
    fn failure_keeps_the_equation_latex() {
        // 内核拒绝也不能把题目弄丢:调用方要能用同一份 LaTeX 排版题目.
        let outcome = solve_equation("x^3 - 1 = 0", None, &[]).expect("能力边界不抛错");

        assert!(outcome.error_message.is_some());
        assert!(outcome.steps.is_empty());
        assert!(outcome.variable.is_empty());
        assert!(outcome.solution_latex.is_none());
        assert!(
            outcome.equation_latex.contains("x^{3}"),
            "{}",
            outcome.equation_latex
        );

        let empty = solve_equation("   ", None, &[]).expect("空方程也是结构化错误");
        assert!(empty.error_message.is_some());
        assert_eq!(empty.equation_latex, "");
    }

    #[test]
    fn rejects_degree_above_two_and_over_cap_degree() {
        let cubic = solve_equation("x^3 - 1 = 0", None, &[])
            .expect("能力边界不抛错")
            .error_message
            .expect("三次方程应当给理由");
        assert!(cubic.contains("只支持一次/二次"), "{cubic}");

        let too_deep = solve_equation("(x + 1)^20 = 0", None, &[])
            .expect("能力边界不抛错")
            .error_message
            .expect("超上限应当给理由");
        assert!(too_deep.contains("上限"), "{too_deep}");
    }
}
