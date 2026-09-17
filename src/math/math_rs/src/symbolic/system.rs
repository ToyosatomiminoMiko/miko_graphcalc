//! 联立方程组求解内核(v1):线性精确解 + 教学步骤,非线性走数值路径.
//!
//! ## 定位
//!
//! 与 `symbolic::solve` 同一档的**独立产物类型** [`SystemOutcome`](不含 `Expr`),
//! 是"约束求解统一词汇"(`crate::solve_core`)在精确侧的第二块后端:
//! 单方程走 [`super::solve`],方程组走这里.
//!
//! v1 能力边界(刻意保守,与"绝不给看起来像推导的东西"一致):
//! - **线性方程组**:精确求解(高斯消元),产出减法消元的板书步骤;
//! - **非线性方程组**:不伪造消元推导,改走数值路径(网格起点 + 阻尼 Newton),
//!   过程里如实标注"数值解"与搜索区间;
//! - 方程数 != 未知量数(超定/欠定),系数矩阵奇异:明确给能力边界理由,
//!   不假装能解.
//!
//! 系数是参数时与单方程同一条链路:参数按当前值代入,内核不做符号系数代数.

use std::collections::HashMap;

use serde::Serialize;

use super::eval::{evaluate_with_lookup, real_pow};
use super::latex::{latex_number, latex_symbol};
use super::parser::{parse_expr, rewrite_aliases, validate_supported};
use super::poly::constant_value;
use super::printing::{format_expr, PrintMode};
use super::solve::{
    equation_parameters, parameter_values_latex, rational_latex, split_equation, step,
    without_negative_zero, SolveStep, KIND_ALGEBRA, KIND_DEFINITION, KIND_NUMERIC, KIND_RULE,
};
use super::{collect_symbols, BinOp, Expr, UnaryOp};
use crate::numeric_core::linalg::{solve_system as solve_linear_system, upper_triangle};
use crate::numeric_core::newton::scan_roots;

/// 数值路径未给 `range` 时的默认搜索区间(每个未知量一条).
const DEFAULT_DOMAIN: [f64; 2] = [-10.0, 10.0];
/// 数值路径未给 `segments` 时的默认网格分段数.
const DEFAULT_SEGMENTS: usize = 24;
/// 数值路径允许的最高未知量个数:网格大小是 `(segments + 1)^d`.
const MAX_NUMERIC_DIMENSION: usize = 3;
/// 多起点 Newton 的起点上限(防止高维网格把工作量顶爆).
const MAX_NUMERIC_STARTS: usize = 4096;
/// 数值网格的节点数上限:`(segments + 1)^未知量`.
///
/// 这个上限是**必须**的:网格节点在选起点之前要逐个求值(每个节点还要为
/// Jacobian 再求若干次),而联立求解跑在主线程上,参数滑块每动一次就重算一遍.
/// 实测 3 未知量 / `segments = 64`(274,625 个节点)单次编译约 190ms,峰值
/// 内存约 26MB;按一次拖动上百帧算,不设上限就是明确的卡顿与内存尖峰.
///
/// 取 `MAX_NUMERIC_STARTS × 16`:保证每个起点平均有 16 个候选节点可选,
/// 规模守卫只拦"真的会爆"的输入,常规 2 维 64 段(4225)与 3 维 32 段(35937)
/// 都照常求解.
const MAX_NUMERIC_NODES: usize = MAX_NUMERIC_STARTS * 16;

/// 方程组求解方法(内核内部;与 `crate::solve_core::SolveMethod` 一一对应).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemMethod {
    /// 只走精确后端;非线性直接给能力边界.
    Exact,
    /// 只走数值后端.
    Numeric,
    /// 线性走精确,非线性自动落到数值.
    Auto,
}

/// 联立方程组的求解结果.
///
/// 与 `SolveOutcome` 同域:只有字符串,计数与数值解点,不含 `Expr`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SystemOutcome {
    /// 未知量名(按方程组里首次出现的顺序,或 `variables` 选项给的顺序).
    pub variables: Vec<String>,
    /// 题目(方程组的 `cases` LaTeX).
    pub problem_latex: String,
    /// 解集 LaTeX;无解或超出能力时为 `None`.
    pub solution_latex: Option<String>,
    /// 解的个数(精确路径恒为 1 表示唯一解;数值路径是找出的解点个数).
    pub solution_count: usize,
    pub steps: Vec<SolveStep>,
    /// 能力边界理由;`None` 表示求解成功.
    pub error: Option<String>,
    /// 实际使用的方法:`"exact"` 或 `"numeric"`.
    pub method: String,
}

/// 一条方程:排版用 LaTeX,代数用残差 `左 - 右`.
struct EquationForm {
    latex: String,
    residual: Expr,
}

/// 多变量仿射式:`constant + Σ coeffs[i] * variables[i]`.
#[derive(Debug, Clone)]
struct AffineForm {
    coeffs: Vec<f64>,
    constant: f64,
}

impl AffineForm {
    fn constant(value: f64, dimension: usize) -> Self {
        Self {
            coeffs: vec![0.0; dimension],
            constant: value,
        }
    }

    fn unknown(index: usize, dimension: usize) -> Self {
        let mut coeffs = vec![0.0; dimension];
        coeffs[index] = 1.0;
        Self {
            coeffs,
            constant: 0.0,
        }
    }

    fn is_constant(&self) -> bool {
        self.coeffs.iter().all(|value| *value == 0.0)
    }

    /// 系数与常数项是否都是有限实数.
    ///
    /// 消元本身不拦 NaN/inf(NaN 参与的比较恒为 false,会绕过奇异判据),
    /// 所以抽完仿射式后必须在这里统一验一次;否则非有限值会一路算到 `values`,
    /// 最后作为"解"排版出去.
    fn is_finite(&self) -> bool {
        self.constant.is_finite() && self.coeffs.iter().all(|value| value.is_finite())
    }

    fn add(&self, other: &Self) -> Self {
        Self {
            coeffs: self
                .coeffs
                .iter()
                .zip(&other.coeffs)
                .map(|(left, right)| left + right)
                .collect(),
            constant: self.constant + other.constant,
        }
    }

    fn sub(&self, other: &Self) -> Self {
        Self {
            coeffs: self
                .coeffs
                .iter()
                .zip(&other.coeffs)
                .map(|(left, right)| left - right)
                .collect(),
            constant: self.constant - other.constant,
        }
    }

    fn scale(&self, factor: f64) -> Self {
        Self {
            coeffs: self.coeffs.iter().map(|value| value * factor).collect(),
            constant: self.constant * factor,
        }
    }
}

/// 把方程组排版成 `cases`.
fn cases_latex(lines: &[String]) -> String {
    let mut out = String::from("\\begin{cases}");
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            out.push_str(" \\\\ ");
        }
        out.push_str(line);
    }
    out.push_str("\\end{cases}");
    out
}

/// 一行线性方程 `Σ a_i x_i = rhs` 的 LaTeX(零系数省略,常数项在右端).
fn linear_row_latex(coeffs: &[f64], rhs: f64, unknowns: &[String]) -> String {
    let mut lhs = String::new();
    for (index, coeff) in coeffs.iter().enumerate() {
        if *coeff == 0.0 {
            continue;
        }
        let symbol = latex_symbol(&unknowns[index]);
        let term = match coeff {
            1.0 => symbol,
            -1.0 => format!("-{symbol}"),
            _ => format!("{}{}", latex_number(*coeff), symbol),
        };
        if lhs.is_empty() {
            lhs.push_str(&term);
        } else if let Some(rest) = term.strip_prefix('-') {
            lhs.push_str(&format!(" - {rest}"));
        } else {
            lhs.push_str(&format!(" + {term}"));
        }
    }
    if lhs.is_empty() {
        lhs.push('0');
    }
    format!("{lhs} = {}", latex_number(without_negative_zero(rhs)))
}

/// 实数解点 -> 精确 LaTeX:整数/有限小数给数值,分母小的有理数给分式.
fn exact_value_latex(value: f64) -> String {
    let value = without_negative_zero(value);
    if value == 0.0 {
        return "0".to_string();
    }
    if value.fract() == 0.0 && value.abs() < 1e12 {
        return format!("{}", value as i64);
    }
    // 试小分母:`1/3` 这类教学常见值必须是分式,不能写成 0.333... .
    for denominator in 2..=1000i64 {
        let numerator = value * denominator as f64;
        if (numerator - numerator.round()).abs() < 1e-9 {
            if let Some(latex) = rational_latex(numerator.round(), denominator as f64) {
                return latex;
            }
        }
    }
    latex_number(value)
}

/// 子树里是否出现任一未知量.
fn contains_any_unknown(expr: &Expr, unknown_index: &HashMap<String, usize>) -> bool {
    match expr {
        Expr::Num(_) => false,
        Expr::Sym(name) => unknown_index.contains_key(name),
        Expr::Unary(_, operand) => contains_any_unknown(operand, unknown_index),
        Expr::Binary(_, left, right) => {
            contains_any_unknown(left, unknown_index) || contains_any_unknown(right, unknown_index)
        }
        Expr::Call(_, args) => args
            .iter()
            .any(|arg| contains_any_unknown(arg, unknown_index)),
        Expr::List(items) => items
            .iter()
            .any(|item| contains_any_unknown(item, unknown_index)),
    }
}

/// 仿射抽取的失败原因.
///
/// 必须区分两类:非线性可以落到数值路径,而"未声明参数/数组/分母为 0"是输入
/// 本身有问题,数值路径也救不了(否则会给出"没有找到数值解"这种误导理由).
enum AffineError {
    /// 该方程不是线性的(数值路径可以尝试).
    Nonlinear(String),
    /// 输入本身有问题(两条路径都直接给能力边界).
    Invalid(String),
}

/// `Expr` -> 仿射式;非线性/输入错误分别返回可读理由.
fn affine_from_expr(
    expr: &Expr,
    unknown_index: &HashMap<String, usize>,
    coefficients: &HashMap<String, f64>,
    dimension: usize,
) -> Result<AffineForm, AffineError> {
    match expr {
        Expr::Num(value) => Ok(AffineForm::constant(*value, dimension)),
        Expr::Sym(name) => {
            if let Some(index) = unknown_index.get(name) {
                Ok(AffineForm::unknown(*index, dimension))
            } else if let Some(value) = coefficients.get(name) {
                Ok(AffineForm::constant(*value, dimension))
            } else {
                Err(AffineError::Invalid(format!(
                    "方程组含未声明参数 {name}:请先用 param 声明,或用 variables 选项指定未知量"
                )))
            }
        }
        Expr::Unary(UnaryOp::Neg, operand) => {
            Ok(affine_from_expr(operand, unknown_index, coefficients, dimension)?.scale(-1.0))
        }
        Expr::Binary(BinOp::Add, left, right) => {
            Ok(
                affine_from_expr(left, unknown_index, coefficients, dimension)?.add(
                    &affine_from_expr(right, unknown_index, coefficients, dimension)?,
                ),
            )
        }
        Expr::Binary(BinOp::Sub, left, right) => {
            Ok(
                affine_from_expr(left, unknown_index, coefficients, dimension)?.sub(
                    &affine_from_expr(right, unknown_index, coefficients, dimension)?,
                ),
            )
        }
        Expr::Binary(BinOp::Mul, left, right) => {
            let left = affine_from_expr(left, unknown_index, coefficients, dimension)?;
            let right = affine_from_expr(right, unknown_index, coefficients, dimension)?;
            match (left.is_constant(), right.is_constant()) {
                (true, _) => Ok(right.scale(left.constant)),
                (_, true) => Ok(left.scale(right.constant)),
                _ => Err(AffineError::Nonlinear(
                    "方程含未知量的乘积,不是线性方程".to_string(),
                )),
            }
        }
        Expr::Binary(BinOp::Div, numerator, denominator) => {
            let divisor = affine_from_expr(denominator, unknown_index, coefficients, dimension)?;
            if !divisor.is_constant() {
                return Err(AffineError::Nonlinear(
                    "方程的分母含未知量,不是线性方程".to_string(),
                ));
            }
            if divisor.constant == 0.0 {
                return Err(AffineError::Invalid("方程的分母为 0".to_string()));
            }
            Ok(
                affine_from_expr(numerator, unknown_index, coefficients, dimension)?
                    .scale(1.0 / divisor.constant),
            )
        }
        Expr::Binary(BinOp::Pow, base, exponent) => {
            let exponent = affine_from_expr(exponent, unknown_index, coefficients, dimension)?;
            if !exponent.is_constant() {
                return Err(AffineError::Nonlinear(
                    "方程含未知量指数,不是线性方程".to_string(),
                ));
            }
            let power = exponent.constant;
            if power == 0.0 {
                return Ok(AffineForm::constant(1.0, dimension));
            }
            if power == 1.0 {
                return affine_from_expr(base, unknown_index, coefficients, dimension);
            }
            let base = affine_from_expr(base, unknown_index, coefficients, dimension)?;
            if base.is_constant() {
                // 常量底数的幂在这里折成系数:结果必须是**有限实数**.
                // `(-1)^0.5`(无实值)与 `0^-1` 分别给出 NaN / inf,一旦当成系数
                // 进了消元,NaN 会绕过奇异判据(`NaN < 阈值` 恒为 false),最后
                // 把 `x = NaN` 印成"解".与单方程内核同一条底线:宁可不给,
                // 也不给看起来像解的东西.
                let value = real_pow(base.constant, power);
                if !value.is_finite() {
                    return Err(AffineError::Invalid(format!(
                        "方程的系数 {}^{power} 不是有限实数",
                        base.constant
                    )));
                }
                return Ok(AffineForm::constant(value, dimension));
            }
            Err(AffineError::Nonlinear(
                "方程含未知量的幂,不是线性方程".to_string(),
            ))
        }
        Expr::Call(name, _) => {
            if contains_any_unknown(expr, unknown_index) {
                return Err(AffineError::Nonlinear(format!(
                    "方程含未知量的函数 {name}(...),不是线性方程"
                )));
            }
            match constant_value(expr, coefficients) {
                Ok(value) => Ok(AffineForm::constant(value, dimension)),
                Err(message) => Err(AffineError::Invalid(message)),
            }
        }
        Expr::List(_) => Err(AffineError::Invalid("方程里不能出现数组".to_string())),
    }
}

/// 未显式给 `variables` 时从方程组推断:全部"既不是内置常量也不是已声明参数"
/// 的自由符号,按首次出现顺序去重.
fn infer_variables(
    residuals: &[Expr],
    coefficients: &HashMap<String, f64>,
) -> Result<Vec<String>, String> {
    let mut unknown: Vec<String> = Vec::new();
    for residual in residuals {
        let mut names = Vec::new();
        collect_symbols(residual, &mut names);
        for name in names {
            if coefficients.contains_key(&name) || unknown.contains(&name) {
                continue;
            }
            unknown.push(name);
        }
    }
    if unknown.is_empty() {
        return Err("方程组里没有未知量".to_string());
    }
    Ok(unknown)
}

/// 方程组里第一个"既不是未知量也不是已声明参数"的自由符号(按出现顺序).
///
/// 显式给了 `variables` 时,`infer_variables` 不会执行,也就没人检查未声明
/// 符号;线性路径由 `affine_from_expr` 兜住,非线性路径必须在这里兜住
/// (见 `solve_numeric` 的说明).
fn first_undeclared_symbol(
    residuals: &[Expr],
    unknown_index: &HashMap<String, usize>,
    coefficients: &HashMap<String, f64>,
) -> Option<String> {
    for residual in residuals {
        let mut names = Vec::new();
        collect_symbols(residual, &mut names);
        for name in names {
            if !unknown_index.contains_key(&name) && !coefficients.contains_key(&name) {
                return Some(name);
            }
        }
    }
    None
}

/// 能力边界结果:题目 LaTeX 照给,步骤留空.
///
/// 步骤必须为空:IR 契约(`contract/ir.ts` 的 `SolveTask.steps`)写明
/// "`error !== null` 时为空",而 UI 的"过程"入口正是按 `steps.length === 0`
/// 判断"内核拒绝就置灰并给明文理由".能力边界带着半截推导回去,入口会变成
/// 可点但只显示"原式"的假过程.
///
/// `method` 是**实际尝试过的方法**("auto" / "exact" / "numeric"):能力边界也
/// 要如实说明内核走的是哪条路,否则调用方与 UI 只能猜.
fn failure(
    method: &str,
    variables: Vec<String>,
    problem_latex: String,
    message: &str,
) -> SystemOutcome {
    SystemOutcome {
        variables,
        problem_latex,
        solution_latex: None,
        solution_count: 0,
        steps: Vec::new(),
        error: Some(message.to_string()),
        method: method.to_string(),
    }
}

/// 线性方程组的精确求解(方阵):返回(解集 LaTeX, 板书步骤).
fn solve_exact(
    unknowns: &[String],
    forms: &[AffineForm],
) -> Result<(String, Vec<SolveStep>), String> {
    let rows = forms.len();
    let columns = unknowns.len();
    if rows > columns {
        return Err(format!(
            "方程数 {rows} 多于未知量数 {columns}:联立 v1 只解方程数与未知量数相等的方程组"
        ));
    }
    if rows < columns {
        return Err(format!(
            "未知量数 {columns} 多于方程数 {rows}:解不唯一,联立 v1 暂不给通解"
        ));
    }

    let mut matrix = vec![vec![0.0; columns + 1]; rows];
    for (row, form) in forms.iter().enumerate() {
        matrix[row][..columns].copy_from_slice(&form.coeffs);
        matrix[row][columns] = -form.constant;
    }
    let display_matrix = matrix.clone();
    let Some(values) = solve_linear_system(matrix, columns) else {
        return Err("系数矩阵奇异:该方程组无解或有无穷多解".to_string());
    };
    // 最后一道有限性防线:消元里除以极小主元同样能溢出成 inf.
    // 到这一步还不是有限实数,就说明这道题超出了"能给精确解"的范围 --
    // 绝不能把 NaN/inf 当成解排版出去.
    if values.iter().any(|value| !value.is_finite()) {
        return Err("方程组的解不是有限实数:请检查参数取值与系数数量级".to_string());
    }

    let mut steps = Vec::new();

    // 标准形:每条方程移项合并成 `Σ a x = c`.
    let standard: Vec<String> = forms
        .iter()
        .map(|form| linear_row_latex(&form.coeffs, -form.constant, unknowns))
        .collect();
    steps.push(step(
        cases_latex(&standard),
        "移项,合并同类项",
        KIND_ALGEBRA,
    ));

    // 消元:上三角化之后回显(只展示非零行).上三角化与求解共用
    // `numeric_core::linalg` 的主元策略,这里拿不到结果就不展示"消元结果".
    if columns >= 2 {
        if let Some(triangular) = upper_triangle(display_matrix, columns) {
            let lines: Vec<String> = triangular
                .iter()
                .filter(|row| row[..columns].iter().any(|value| *value != 0.0))
                .map(|row| linear_row_latex(&row[..columns], row[columns], unknowns))
                .collect();
            if !lines.is_empty() {
                steps.push(step(cases_latex(&lines), "加减消元", KIND_RULE));
            }
        }
    }

    // 回代:逐个给出未知量的值.
    let back_substitution: Vec<String> = unknowns
        .iter()
        .zip(&values)
        .map(|(name, value)| format!("{} = {}", latex_symbol(name), exact_value_latex(*value)))
        .collect();
    steps.push(step(
        cases_latex(&back_substitution),
        "回代求解",
        KIND_ALGEBRA,
    ));

    let solution = unknowns
        .iter()
        .zip(&values)
        .map(|(name, value)| format!("{} = {}", latex_symbol(name), exact_value_latex(*value)))
        .collect::<Vec<_>>()
        .join(",\\quad ");

    Ok((solution, steps))
}

/// 数值解的 LaTeX:每个解点排成一个 `cases`,多个解用"或"连接.
fn numeric_solution_latex(unknowns: &[String], solutions: &[Vec<f64>]) -> String {
    let blocks: Vec<String> = solutions
        .iter()
        .map(|solution| {
            let lines: Vec<String> = unknowns
                .iter()
                .zip(solution)
                .map(|(name, value)| {
                    format!("{} \\approx {}", latex_symbol(name), latex_number(*value))
                })
                .collect();
            cases_latex(&lines)
        })
        .collect();
    blocks.join(" \\quad\\text{或}\\quad ")
}

/// 数值路径:网格起点 + 阻尼 Newton,结果如实标成"数值解".
#[allow(clippy::too_many_arguments)]
fn solve_numeric(
    residuals: &[Expr],
    unknown_index: &HashMap<String, usize>,
    unknowns: &[String],
    coefficients: &HashMap<String, f64>,
    domain: &[[f64; 2]],
    segments: usize,
    problem_latex: String,
    mut steps: Vec<SolveStep>,
) -> SystemOutcome {
    let dimension = unknowns.len();
    if residuals.len() != dimension {
        return failure(
            "numeric",
            unknowns.to_vec(),
            problem_latex,
            &format!(
                "数值路径需要方程数与未知量数相等(当前 {} 条方程,{} 个未知量)",
                residuals.len(),
                dimension
            ),
        );
    }
    if dimension > MAX_NUMERIC_DIMENSION {
        return failure(
            "numeric",
            unknowns.to_vec(),
            problem_latex,
            &format!("数值路径目前最多支持 {MAX_NUMERIC_DIMENSION} 个未知量"),
        );
    }

    // 未声明符号必须在这里拦下来.数值残差求值时它只会让该点"不可求值",
    // 所有网格点被跳过,最后报成"区间内没有找到数值解",让用户去调
    // range/segments -- 理由完全不对(线性路径在 `affine_from_expr` 里报的是
    // "方程组含未声明参数",两条路径必须给同一个理由).
    if let Some(name) = first_undeclared_symbol(residuals, unknown_index, coefficients) {
        return failure(
            "numeric",
            unknowns.to_vec(),
            problem_latex,
            &format!("方程组含未声明参数 {name}:请先用 param 声明,或用 variables 选项指定未知量"),
        );
    }

    let axes: Vec<[f64; 2]> = match domain.len() {
        0 => vec![DEFAULT_DOMAIN; dimension],
        1 => vec![domain[0]; dimension],
        length if length == dimension => domain.to_vec(),
        length => {
            return failure(
                "numeric",
                unknowns.to_vec(),
                problem_latex,
                &format!("range 选项给了 {length} 条区间,需要 1 条或 {dimension} 条"),
            );
        }
    };
    let Some(scan_box) = crate::numeric_core::newton::ScanBox::new(axes) else {
        return failure(
            "numeric",
            unknowns.to_vec(),
            problem_latex,
            "range 选项的区间非法(需要上界大于下界的有限区间)",
        );
    };

    let segments = if segments == 0 {
        DEFAULT_SEGMENTS
    } else {
        segments
    };
    // 网格规模守卫:节点数是 `(segments + 1)^未知量`,不做这一步就会在主线程上
    // 凭空求值几十万个点(见 docs/equation-solving-process.md §11.4 的同一条承诺).
    let node_count = crate::numeric_core::newton::grid_node_count(dimension, segments);
    if node_count > MAX_NUMERIC_NODES {
        return failure(
            "numeric",
            unknowns.to_vec(),
            problem_latex,
            &format!(
                "数值网格 {node_count} 个节点超过上限 {MAX_NUMERIC_NODES}\
                 (节点数是 (segments+1)^未知量):请减小 segments,或缩小 range 的维度"
            ),
        );
    }

    // 区间先如实写进过程:数值解只在区间内有效,读者必须知道搜了哪儿.
    let box_latex = unknowns
        .iter()
        .zip(&scan_box.axes)
        .map(|(name, axis)| {
            format!(
                "{} \\in \\left[{}, {}\\right]",
                latex_symbol(name),
                latex_number(axis[0]),
                latex_number(axis[1])
            )
        })
        .collect::<Vec<_>>()
        .join(",\\quad ");
    steps.push(step(box_latex, "数值搜索区间", KIND_NUMERIC));

    let mut residual_fn = |point: &[f64]| -> Option<Vec<f64>> {
        let mut values = Vec::with_capacity(residuals.len());
        for residual in residuals {
            let evaluated = evaluate_with_lookup(residual, &|name: &str| {
                if let Some(index) = unknown_index.get(name) {
                    Some(point[*index])
                } else {
                    coefficients.get(name).copied()
                }
            })
            .ok()?;
            values.push(evaluated?);
        }
        Some(values)
    };

    let solutions = scan_roots(&mut residual_fn, &scan_box, segments, MAX_NUMERIC_STARTS);

    if solutions.is_empty() {
        return failure(
            "numeric",
            unknowns.to_vec(),
            problem_latex,
            "在给定区间内没有找到数值解:可调整 range 与 segments 后重试(数值搜索不保证不漏根)",
        );
    }

    let solution_latex = numeric_solution_latex(unknowns, &solutions);
    steps.push(step(solution_latex.clone(), "数值解", KIND_NUMERIC));
    SystemOutcome {
        variables: unknowns.to_vec(),
        problem_latex,
        solution_count: solutions.len(),
        solution_latex: Some(solution_latex),
        steps,
        error: None,
        method: "numeric".to_string(),
    }
}

/// 联立方程组求解入口.
///
/// - `equations`:每条方程原文(含一个顶层 `=`),至少一条;
/// - `variables`:`variables` 选项给的未知量;`None`/空表示从方程组推断;
/// - `coefficients`:参数名 -> 当前值(与积分/分析/单方程同一条链路);
/// - `domain`:数值路径的搜索区间(空表示用默认区间);
/// - `segments`:数值路径的网格分段数(0 表示用默认值).
///
/// 返回 `Err` 只表示**方程组文本读不出来**(缺等号/多等号/解析失败/未知量推断
/// 失败);"读出来了但超出内核能力"落在 [`SystemOutcome::error`].
pub fn solve_system(
    equations: &[String],
    variables: Option<&[String]>,
    coefficients: &[(String, f64)],
    method: SystemMethod,
    domain: &[[f64; 2]],
    segments: usize,
) -> Result<SystemOutcome, String> {
    if equations.is_empty() {
        return Ok(failure("auto", Vec::new(), String::new(), "方程组不能为空"));
    }

    let coefficient_map: HashMap<String, f64> = coefficients.iter().cloned().collect();

    // 逐条解析:排版用原树,代数用别名展开后的树.
    let mut forms = Vec::with_capacity(equations.len());
    for source in equations {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            return Ok(failure(
                "auto",
                Vec::new(),
                String::new(),
                "方程组里有空方程",
            ));
        }
        let (lhs_text, rhs_text) = split_equation(trimmed)?;
        let lhs_parsed = parse_expr(lhs_text)?;
        let rhs_parsed = parse_expr(rhs_text)?;
        let lhs = rewrite_aliases(&lhs_parsed)?;
        let rhs = rewrite_aliases(&rhs_parsed)?;
        validate_supported(&lhs)?;
        validate_supported(&rhs)?;
        forms.push(EquationForm {
            latex: format!(
                "{}={}",
                format_expr(&lhs_parsed, PrintMode::Latex, 0),
                format_expr(&rhs_parsed, PrintMode::Latex, 0),
            ),
            residual: Expr::Binary(BinOp::Sub, Box::new(lhs), Box::new(rhs)),
        });
    }

    // 先取排版行,再把残差**移出** `forms`:留着 `forms` 只为拼题目,不必再深拷
    // 一份 AST(每条方程的表达式都要克隆一次,方程组越大越亏).
    let problem_latex = cases_latex(
        &forms
            .iter()
            .map(|form| form.latex.clone())
            .collect::<Vec<_>>(),
    );
    let residuals: Vec<Expr> = forms.into_iter().map(|form| form.residual).collect();

    // 未知量:显式 `variables` 优先,否则从方程组推断.
    let unknowns = match variables {
        Some(names) if !names.is_empty() => {
            let mut cleaned: Vec<String> = Vec::new();
            for name in names {
                let name = name.trim();
                if name.is_empty() {
                    continue;
                }
                if coefficient_map.contains_key(name) {
                    return Ok(failure(
                        "auto",
                        Vec::new(),
                        problem_latex,
                        &format!("变量 {name} 与已声明参数同名,无法区分"),
                    ));
                }
                if !cleaned.iter().any(|existing| existing == name) {
                    cleaned.push(name.to_string());
                }
            }
            if cleaned.is_empty() {
                return Ok(failure(
                    "auto",
                    Vec::new(),
                    problem_latex,
                    "variables 选项没有给出任何变量",
                ));
            }
            cleaned
        }
        _ => match infer_variables(&residuals, &coefficient_map) {
            Ok(names) => names,
            Err(message) => return Ok(failure("auto", Vec::new(), problem_latex, &message)),
        },
    };

    let unknown_index: HashMap<String, usize> = unknowns
        .iter()
        .enumerate()
        .map(|(index, name)| (name.clone(), index))
        .collect();

    // 前置步骤:原式 + (参数取值).
    let mut steps = vec![step(problem_latex.clone(), "原式", KIND_DEFINITION)];
    let parameters = equation_parameters(&equations.join("\n"), &coefficient_map);
    if !parameters.is_empty() {
        let entries: Vec<String> = parameters
            .iter()
            .map(|name| {
                format!(
                    "{}={}",
                    latex_symbol(name),
                    latex_number(coefficient_map[name])
                )
            })
            .collect();
        steps.push(step(
            parameter_values_latex(&problem_latex, &entries),
            "参数取值",
            KIND_NUMERIC,
        ));
    }

    // 仿射抽取:全部成功才能走精确后端.
    let dimension = unknowns.len();
    let mut affine_forms = Vec::with_capacity(residuals.len());
    let mut nonlinear_reason: Option<String> = None;
    for residual in &residuals {
        let form = match affine_from_expr(residual, &unknown_index, &coefficient_map, dimension) {
            Ok(form) => form,
            // 输入本身有问题:两条路径都救不了,直接给能力边界.
            Err(AffineError::Invalid(message)) => {
                return Ok(failure("auto", unknowns, problem_latex, &message));
            }
            Err(AffineError::Nonlinear(message)) => {
                nonlinear_reason = Some(message);
                break;
            }
        };
        // 系数必须全有限:NaN/inf 会在消元里传递并绕过奇异判据,最后当成解印出去.
        // 常量幂只堵住了 `(-1)^0.5` / `0^-1` 这一类来源,加减乘与除法同样能
        // 溢出成 inf,所以这里统一再验一次(两道防线都要有).
        if !form.is_finite() {
            return Ok(failure(
                "auto",
                unknowns,
                problem_latex,
                "方程的系数不是有限实数(参数取值或幂指数可能导致 NaN/inf)",
            ));
        }
        affine_forms.push(form);
    }

    if let Some(reason) = nonlinear_reason {
        return Ok(match method {
            SystemMethod::Exact => failure(
                "exact",
                unknowns,
                problem_latex,
                &format!("{reason};联立 v1 的精确路径只解线性方程组"),
            ),
            SystemMethod::Numeric | SystemMethod::Auto => solve_numeric(
                &residuals,
                &unknown_index,
                &unknowns,
                &coefficient_map,
                domain,
                segments,
                problem_latex,
                steps,
            ),
        });
    }

    match solve_exact(&unknowns, &affine_forms) {
        Ok((solution, mut solved_steps)) => {
            steps.append(&mut solved_steps);
            Ok(SystemOutcome {
                variables: unknowns,
                problem_latex,
                solution_latex: Some(solution),
                solution_count: 1,
                steps,
                error: None,
                method: "exact".to_string(),
            })
        }
        Err(message) => Ok(failure("exact", unknowns, problem_latex, &message)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn equations(source: &[&str]) -> Vec<String> {
        source.iter().map(|entry| entry.to_string()).collect()
    }

    fn solve(source: &[&str]) -> SystemOutcome {
        solve_system(&equations(source), None, &[], SystemMethod::Auto, &[], 0)
            .expect("方程应当可解析")
    }

    fn reasons(outcome: &SystemOutcome) -> Vec<&str> {
        outcome
            .steps
            .iter()
            .map(|entry| entry.reason.as_str())
            .collect()
    }

    #[test]
    fn solves_two_by_two_unique_system_with_steps() {
        let outcome = solve(&["x + y = 3", "x - y = 1"]);

        assert_eq!(outcome.variables, vec!["x", "y"]);
        assert_eq!(outcome.method, "exact");
        assert_eq!(outcome.solution_count, 1);
        let solution = outcome.solution_latex.as_deref().expect("应当有解");
        assert!(solution.contains("x = 2"), "{solution}");
        assert!(solution.contains("y = 1"), "{solution}");
        assert_eq!(
            reasons(&outcome),
            vec!["原式", "移项,合并同类项", "加减消元", "回代求解"]
        );
        assert!(outcome.error.is_none());
        // 题目排成 cases,原样保留用户写法.
        assert!(outcome.problem_latex.contains("\\begin{cases}"));
    }

    #[test]
    fn rational_solution_keeps_fractions() {
        let outcome = solve(&["x + y = 1", "x - y = 0"]);

        let solution = outcome.solution_latex.as_deref().expect("应当有解");
        assert!(solution.contains("\\frac{1}{2}"), "{solution}");
        assert!(!solution.contains("0.5"), "{solution}");
    }

    #[test]
    fn parameters_are_substituted_like_single_equation() {
        let outcome = solve_system(
            &equations(&["a*x + y = 1", "x - y = 0"]),
            None,
            &[("a".to_string(), 1.0)],
            SystemMethod::Auto,
            &[],
            0,
        )
        .expect("应当可解");

        // a 是已声明参数,不会被当成第三个未知量.
        assert_eq!(outcome.variables, vec!["x", "y"]);
        assert!(reasons(&outcome).contains(&"参数取值"));
        let solution = outcome.solution_latex.as_deref().expect("应当有解");
        assert!(solution.contains("\\frac{1}{2}"), "{solution}");
    }

    #[test]
    fn explicit_variables_reject_undeclared_symbols() {
        let outcome = solve_system(
            &equations(&["a*x + y = 1", "x - y = 0"]),
            Some(&["x".to_string(), "y".to_string()]),
            &[],
            SystemMethod::Auto,
            &[],
            0,
        )
        .expect("能力边界不抛错");

        let message = outcome.error.expect("未声明参数应当给理由");
        assert!(message.contains("未声明参数 a"), "{message}");
    }

    #[test]
    fn overdetermined_and_underdetermined_are_capability_boundaries() {
        let over = solve(&["x + y = 1", "x - y = 0", "x = 1"]);
        assert!(
            over.error.as_deref().unwrap_or("").contains("多于未知量数"),
            "{:?}",
            over.error
        );

        // 线性系统走的是精确路径:能力边界也要如实说明这一点.
        assert_eq!(over.method, "exact");
        assert_eq!(over.solution_count, 0);

        let under = solve(&["x + y = 1"]);
        assert!(
            under.error.as_deref().unwrap_or("").contains("解不唯一"),
            "{:?}",
            under.error
        );
        assert_eq!(under.method, "exact");
    }

    #[test]
    fn singular_matrix_is_reported_not_faked() {
        let outcome = solve(&["x + y = 1", "2*x + 2*y = 2"]);

        let message = outcome.error.expect("奇异矩阵应当给理由");
        assert!(message.contains("系数矩阵奇异"), "{message}");
        assert!(outcome.solution_latex.is_none());
    }

    #[test]
    fn nonlinear_system_falls_back_to_numeric_in_auto() {
        let outcome = solve_system(
            &equations(&["x^2 + y^2 = 1", "x - y = 0"]),
            None,
            &[],
            SystemMethod::Auto,
            &[[-2.0, 2.0], [-2.0, 2.0]],
            16,
        )
        .expect("应当可算");

        assert_eq!(outcome.method, "numeric");
        assert_eq!(outcome.solution_count, 2);
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        let step_reasons = reasons(&outcome);
        assert!(step_reasons.contains(&"数值搜索区间"), "{step_reasons:?}");
        assert!(step_reasons.contains(&"数值解"), "{step_reasons:?}");
        let solution = outcome.solution_latex.as_deref().expect("应当有解");
        assert!(solution.contains("\\approx"), "{solution}");
    }

    #[test]
    fn nonlinear_system_in_exact_mode_is_a_capability_boundary() {
        let outcome = solve_system(
            &equations(&["x^2 + y^2 = 1", "x - y = 0"]),
            None,
            &[],
            SystemMethod::Exact,
            &[],
            0,
        )
        .expect("能力边界不抛错");

        let message = outcome.error.expect("应当给理由");
        assert!(message.contains("只解线性方程组"), "{message}");
    }

    #[test]
    fn numeric_reports_when_nothing_is_found_in_the_box() {
        // `x^2 + y^2 = 1` 与 `x - y = 3` 在 [-1,1]^2 内无解.
        let outcome = solve_system(
            &equations(&["x^2 + y^2 = 1", "x - y = 3"]),
            None,
            &[],
            SystemMethod::Auto,
            &[[-1.0, 1.0], [-1.0, 1.0]],
            12,
        )
        .expect("能力边界不抛错");

        assert_eq!(outcome.method, "numeric");
        assert!(outcome.solution_latex.is_none());
        let message = outcome.error.expect("应当给理由");
        assert!(message.contains("没有找到数值解"), "{message}");
    }

    /// 非有限系数不得变成"解":`(-1)^0.5` 无实值,`0^-1` 为 inf.
    ///
    /// 这两条都曾经一路算到板书里,输出 `x = NaN` / `x = -inf` 且 `error`
    /// 为 `None` -- 比"解不出来"坏得多.
    #[test]
    fn non_finite_coefficients_are_a_capability_boundary_not_a_solution() {
        for source in ["x + (-1)^0.5 = 0", "x + 0^(-1) = 0", "x + (-1)^(1/2) = 0"] {
            let outcome = solve(&[source, "y = 1"]);
            let message = outcome.error.unwrap_or_default();
            assert!(
                message.contains("不是有限实数"),
                "{source} 应当给能力边界理由: {message:?}"
            );
            assert!(outcome.solution_latex.is_none(), "{source}");
            assert!(outcome.steps.is_empty(), "{source} 失败时不得留下板书步骤");
        }
    }

    /// 参数把底数拖成负数 + 分数次幂:同一类非有限系数的真实触发路径.
    #[test]
    fn negative_parameter_with_fractional_power_is_reported() {
        let outcome = solve_system(
            &equations(&["a^0.5 + x = 0", "y = 1"]),
            None,
            &[("a".to_string(), -1.0)],
            SystemMethod::Auto,
            &[],
            0,
        )
        .expect("可解析");

        assert!(
            outcome
                .error
                .as_deref()
                .unwrap_or("")
                .contains("不是有限实数"),
            "{:?}",
            outcome.error
        );
        assert!(outcome.solution_latex.is_none());
    }

    /// 常量底数的**有限**分数次幂仍然照常折成系数,不能一并误杀.
    #[test]
    fn finite_fractional_powers_still_fold_into_coefficients() {
        let outcome = solve(&["x + (-8)^(1/3) = 0", "y = 1"]);

        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        let solution = outcome.solution_latex.as_deref().expect("应当有解");
        assert!(solution.contains("x = 2"), "{solution}");
    }

    /// 显式 `variables` 漏掉方程里的自由符号:非线性路径必须与线性路径
    /// 给同一个理由,而不是报"区间内没有找到数值解".
    #[test]
    fn nonlinear_undeclared_symbol_is_reported_like_the_linear_path() {
        let unknowns = vec!["x".to_string(), "y".to_string()];
        // 线性对照:理由是"未声明参数 z".
        let linear = solve_system(
            &equations(&["x + y = 1", "x - y = z"]),
            Some(&unknowns),
            &[],
            SystemMethod::Auto,
            &[],
            0,
        )
        .expect("可解析");
        let linear_reason = linear.error.clone().unwrap_or_default();
        assert!(linear_reason.contains("未声明参数 z"), "{linear_reason}");

        // 非线性:同一句话,不能退化成"没有找到数值解".
        let nonlinear = solve_system(
            &equations(&["x^2 + y^2 = 1", "x - y = z"]),
            Some(&unknowns),
            &[],
            SystemMethod::Auto,
            &[[-2.0, 2.0], [-2.0, 2.0]],
            16,
        )
        .expect("可解析");
        let reason = nonlinear.error.unwrap_or_default();
        assert!(reason.contains("未声明参数 z"), "{reason}");
        assert!(!reason.contains("没有找到数值解"), "{reason}");
        assert_eq!(nonlinear.method, "numeric", "仍要如实标注走的是数值路径");
    }

    /// 网格规模守卫:节点数在**求值之前**就要判掉.
    #[test]
    fn oversized_numeric_grid_is_a_capability_boundary() {
        let unknowns = vec!["x".to_string(), "y".to_string(), "z".to_string()];
        let outcome = solve_system(
            &equations(&["x^2 + y^2 + z^2 = 1", "x - y = 0", "y - z = 0"]),
            Some(&unknowns),
            &[],
            SystemMethod::Auto,
            &[[-2.0, 2.0], [-2.0, 2.0], [-2.0, 2.0]],
            64,
        )
        .expect("可解析");

        let message = outcome.error.unwrap_or_default();
        assert!(message.contains("超过上限"), "{message}");
        assert!(outcome.solution_latex.is_none());
        assert!(outcome.steps.is_empty());

        // 同一道题把 segments 降下来照样能解(守卫只拦真的会爆的输入).
        let ok = solve_system(
            &equations(&["x^2 + y^2 + z^2 = 1", "x - y = 0", "y - z = 0"]),
            Some(&unknowns),
            &[],
            SystemMethod::Auto,
            &[[-2.0, 2.0], [-2.0, 2.0], [-2.0, 2.0]],
            24,
        )
        .expect("可解析");
        assert!(ok.error.is_none(), "{:?}", ok.error);
        assert_eq!(ok.method, "numeric");
    }

    /// 能力边界不得回填步骤:IR 契约写明 `error !== null` 时步骤为空,
    /// UI 的"过程"入口正是按此置灰.
    #[test]
    fn capability_boundaries_carry_no_steps() {
        for outcome in [
            solve(&["x + y = 1", "x - y = 0", "x = 1"]),
            solve(&["x + y = 1"]),
            solve(&["x + y = 1", "2*x + 2*y = 2"]),
            solve_system(
                &equations(&["x^2 + y^2 = 1", "x - y = 0"]),
                None,
                &[],
                SystemMethod::Exact,
                &[],
                0,
            )
            .expect("可解析"),
        ] {
            assert!(outcome.error.is_some());
            assert!(outcome.steps.is_empty(), "{:?}", outcome.steps);
        }
    }

    #[test]
    fn unreadable_equation_stays_an_err() {
        let message = solve_system(
            &equations(&["x + 1"]),
            None,
            &[],
            SystemMethod::Auto,
            &[],
            0,
        )
        .unwrap_err();
        assert!(message.contains("缺少等号"), "{message}");
    }
}
