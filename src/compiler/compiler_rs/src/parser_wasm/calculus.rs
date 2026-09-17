//! 分析与微积分,求交语句的 AST 组装(analysis,integral,derivative,
//! antiderivative,intersection).
//!
//! 这一族的共同形状是"名称 + `*_call` 实参 + 选项":调用实参在语法上全是
//! ident(源对象或操作数),统一用 [`call_idents`] 取,一元调用取第 1 个,
//! 二元调用(`intersection`)取前 2 个.两处例外:
//! - `analysis` 的算子在 `op_call` 里,并且 `op_call` 还挂着可选的 `at`,
//!   两种形式(球坐标/笛卡尔)在 [`AnalysisCall`] / [`at_from_op_call`] 里收口;
//! - `derivative` 与 `antiderivative` 的 JSON 形状完全一致,共用
//!   [`unary_call_to_stmt`],只差调用规则与 `type` 名.
//!
//! `analysis` 的 `atForm` 只在球坐标时落字段(笛卡尔是缺省),下游据此选
//! 坐标口径;求交的操作数保持源码顺序(`a` 在前),不在 AST 层排序.

use pest::iterators::Pair;
use serde_json::{json, Value};

use super::{call_idents, child_text, pair_ident, span_of, stmt_options, Rule};

/// `analysis` 的调用取样结果:算子名(`op_call` 的 ident),源对象(`op_arg`
/// 原文)与可选的 `at`.
struct AnalysisCall {
    call: String,
    source: String,
    at: Option<Vec<String>>,
    at_form: Option<String>,
}

/// 从 `op_call` 子节点里取出 `at` 的两种形式.
///
/// - `at spherical(...)` 才写 `atForm = "spherical"`,参数来自 `spherical_at`
///   的 `at_expr`(支持嵌套括号,如 `asin(0.5)`);
/// - `at [...]`(笛卡尔)参数来自 `cartesian_at` 的 `at_arg`,不写 `atForm`,
///   TS 侧按缺省处理.
///
/// 返回 `(参数列表, 形式)`;没有 `at` 时是 `(None, None)`.注意笛卡尔分支
/// **不清空** `at_form`:语法上 `at` 只有一个,这里只是保持"谁写的谁负责".
fn at_from_op_call(op_call: &Pair<'_, Rule>) -> (Option<Vec<String>>, Option<String>) {
    let mut at: Option<Vec<String>> = None;
    let mut at_form: Option<String> = None;

    for node in op_call.clone().into_inner() {
        if node.as_rule() != Rule::at {
            continue;
        }
        for form in node.into_inner() {
            match form.as_rule() {
                Rule::spherical_at => {
                    at_form = Some("spherical".to_string());
                    at = Some(
                        form.into_inner()
                            .filter(|n| n.as_rule() == Rule::at_expr)
                            .map(|n| n.as_str().trim().to_string())
                            .collect(),
                    );
                }
                Rule::cartesian_at => {
                    at = Some(
                        form.into_inner()
                            .filter(|n| n.as_rule() == Rule::at_arg)
                            .map(|n| n.as_str().trim().to_string())
                            .collect(),
                    );
                }
                _ => {}
            }
        }
    }

    (at, at_form)
}

/// 取 `analysis_stmt` 里的 `op_call`(算子名 / 源对象 / `at`).
/// 语法保证只有一条 `op_call`,没有时各字段取空.
fn analysis_call(pair: &Pair<'_, Rule>) -> AnalysisCall {
    let mut call = String::new();
    let mut source = String::new();
    let mut at: Option<Vec<String>> = None;
    let mut at_form: Option<String> = None;

    if let Some(op_call) = pair
        .clone()
        .into_inner()
        .find(|child| child.as_rule() == Rule::op_call)
    {
        for inner in op_call.clone().into_inner() {
            match inner.as_rule() {
                Rule::ident => call = inner.as_str().to_string(),
                Rule::op_arg => source = inner.as_str().trim().to_string(),
                _ => {}
            }
        }
        (at, at_form) = at_from_op_call(&op_call);
    }

    AnalysisCall {
        call,
        source,
        at,
        at_form,
    }
}

/// 将分析语句(analysis_stmt)转换为 JSON AST 节点.
/// 包含操作符(op),名称,调用(call),源(source),
/// 可选的 at 参数及其形式(atForm,球坐标时显式给出),选项列表和位置.
pub(super) fn analysis_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    let AnalysisCall {
        call,
        source,
        at,
        at_form,
    } = analysis_call(pair);

    let mut statement = json!({
        "type": "analysis",
        "op": child_text(pair, Rule::analysis_op),
        "name": pair_ident(pair),
        "call": call,
        "source": source,
        "options": stmt_options(pair),
        "span": span_of(pair),
    });
    if let Some(at) = at {
        statement["at"] = json!(at);
    }
    if let Some(form) = at_form {
        statement["atForm"] = json!(form);
    }
    statement
}

/// 将积分语句(integral_stmt)转换为 JSON AST 节点.
/// 包含名称,源(source),选项列表和位置.
pub(super) fn integral_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    json!({
        "type": "integral",
        "name": pair_ident(pair),
        "source": call_idents(pair, Rule::integral_call)
            .into_iter()
            .next()
            .unwrap_or_default(),
        "options": stmt_options(pair),
        "span": span_of(pair),
    })
}

/// 一元调用语句(derivative / antiderivative)的公共实现.
///
/// 两者字段与顺序完全一致:`type` / `name` / `source` / 可选 `variable` /
/// `options` / `span`.变量缺省时**不落字段**,由下游内核从源对象推断.
fn unary_call_to_stmt(pair: &Pair<'_, Rule>, ty: &str, call: Rule) -> Value {
    let mut idents = call_idents(pair, call).into_iter();
    let source = idents.next().unwrap_or_default();
    let variable = idents.next();

    let mut statement = json!({
        "type": ty,
        "name": pair_ident(pair),
        "source": source,
        "options": stmt_options(pair),
        "span": span_of(pair),
    });
    if let Some(variable) = variable {
        statement["variable"] = json!(variable);
    }
    statement
}

/// 将求导语句(derivative_stmt)转换为 JSON AST 节点.
/// 包含名称,源对象(source),可选求导变量(variable),选项列表和位置.
/// 函数名遵循项目全名习惯(derivative),见 miko.pest 的 derivative_stmt.
pub(super) fn derivative_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    unary_call_to_stmt(pair, "derivative", Rule::derivative_call)
}

/// 将不定积分语句(antiderivative_stmt)转换为 JSON AST 节点.
/// 与 `derivative_to_stmt` 同形:名称,源对象,可选积分变量,选项与位置.
/// 函数名用全名 `antiderivative`(见 miko.pest 的 antiderivative_stmt).
pub(super) fn antiderivative_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    unary_call_to_stmt(pair, "antiderivative", Rule::antiderivative_call)
}

/// 将交集语句(intersection_stmt)转换为 JSON AST 节点.
/// 包含名称,两个操作数 a 和 b,选项列表和位置.
pub(super) fn intersection_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    let mut operands = call_idents(pair, Rule::intersection_call).into_iter();
    let a = operands.next().unwrap_or_default();
    let b = operands.next().unwrap_or_default();

    json!({
        "type": "intersection",
        "name": pair_ident(pair),
        "a": a,
        "b": b,
        "options": stmt_options(pair),
        "span": span_of(pair),
    })
}

#[cfg(test)]
mod tests {
    use crate::parser_wasm::parse_to_json;
    use serde_json::Value;

    #[test]
    fn parses_derivative_statements_with_and_without_variable() {
        let src = r##"
curve c = sin(x * a) {
    range = [-8, 8];
    segments = 256;
}
derivative dc = derivative(c);
surface s = sin(x) * cos(y);
derivative dsx = derivative(s, x);
derivative dsy = derivative(s, y);
"##;
        let value: Value = serde_json::from_str(&parse_to_json(src).unwrap()).unwrap();
        let statements = value["statements"].as_array().unwrap();
        let derivatives: Vec<&Value> = statements
            .iter()
            .filter(|stmt| stmt["type"] == "derivative")
            .collect();
        assert_eq!(derivatives.len(), 3);

        assert_eq!(derivatives[0]["name"], "dc");
        assert_eq!(derivatives[0]["source"], "c");
        assert!(derivatives[0].get("variable").is_none());

        assert_eq!(derivatives[1]["name"], "dsx");
        assert_eq!(derivatives[1]["source"], "s");
        assert_eq!(derivatives[1]["variable"], "x");

        assert_eq!(derivatives[2]["name"], "dsy");
        assert_eq!(derivatives[2]["source"], "s");
        assert_eq!(derivatives[2]["variable"], "y");
    }

    #[test]
    fn parses_spherical_at_with_nested_parentheses() {
        // `at spherical(...)` 是显式球坐标形式;参数里的括号必须能嵌套
        // (asin(0.5)),而笛卡尔 `at [...]` 仍不写 atForm.
        let src = r##"
sphere s = [0, 0, 0] { radius = 2; }
gradient g = grad(s) at spherical(2, pi / 2, 0);
gradient h = grad(s) at spherical(asin(0.5), pi / 4);
gradient c = grad(s) at [1, 2, 3];
"##;
        let value: Value = serde_json::from_str(&parse_to_json(src).unwrap()).unwrap();
        let statements = value["statements"].as_array().unwrap();
        let analyses: Vec<&Value> = statements
            .iter()
            .filter(|stmt| stmt["type"] == "analysis")
            .collect();
        assert_eq!(analyses.len(), 3);

        assert_eq!(analyses[0]["atForm"], "spherical");
        assert_eq!(analyses[0]["at"], serde_json::json!(["2", "pi / 2", "0"]));
        assert_eq!(analyses[1]["atForm"], "spherical");
        assert_eq!(
            analyses[1]["at"],
            serde_json::json!(["asin(0.5)", "pi / 4"])
        );

        assert!(analyses[2].get("atForm").is_none());
        assert_eq!(analyses[2]["at"], serde_json::json!(["1", "2", "3"]));
    }
}
