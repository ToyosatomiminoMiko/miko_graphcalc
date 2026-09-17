//! 方程与微分方程语句的 AST 组装(solve,ode).
//!
//! 这一族的共同点是"方程原文"必须**如实透出**:AST 只做切分,不做解析.
//! - `solve` 单方程取一条 `expr`,联立取 `solve_system_set` 里每条
//!   `solve_system_entry` 的 `expr`,两条来源在 [`collect_equations`] 里按源码
//!   顺序合并成一个 `equations` 数组(不再另给"首条方程"兼容字段:TS 侧没有
//!   消费方,还会与 IR 的 `equation`(连接串)同名不同义);
//! - `ode` 的方程与初值混在同一个 `expr` 里(语法的停止集不含逗号),由
//!   [`split_ode_conditions`] 按首个**顶层**逗号切开,初值原文交给内核解析.
//!
//! 变量缺省一律不落字段,由求解内核从方程推断;也可用选项显式给出.

use pest::iterators::Pair;
use serde_json::{json, Value};

use super::{pair_ident, span_of, stmt_expr, stmt_options, Rule};

/// 收集 `solve` 的方程原文(保持源码顺序).
///
/// 两种形态共用一条字段:
/// - 单方程 `solve S = 左 = 右 [选项];` -> 一个 `expr` 直接子节点;
/// - 联立 `solve S = { 方程; 方程; } [选项];` -> `solve_system_set` 下每条
///   `solve_system_entry` 各带一个 `expr`.
fn collect_equations(pair: &Pair<'_, Rule>) -> Vec<String> {
    let mut equations: Vec<String> = Vec::new();

    for child in pair.clone().into_inner() {
        match child.as_rule() {
            Rule::expr => equations.push(child.as_str().trim().to_string()),
            Rule::solve_system_set => {
                for entry in child.into_inner() {
                    for inner in entry.into_inner() {
                        if inner.as_rule() == Rule::expr {
                            equations.push(inner.as_str().trim().to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }

    equations
}

/// 将方程求解语句(solve_stmt)转换为 JSON AST 节点.
///
/// 只给 `equations`:曾经另有一个"首条方程"的 `equation` 兼容字段,TS 侧没有
/// 任何消费方,却与 IR 的 `equation`(连接串)同名不同义.变量缺省由求解内核
/// 从方程推断,也可用 `variable` / `variables` 选项显式给出.
pub(super) fn solve_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    json!({
        "type": "solve",
        "name": pair_ident(pair),
        "equations": collect_equations(pair),
        "options": stmt_options(pair),
        "span": span_of(pair),
    })
}

/// 把 `ode` 语句捕获的整段文本按**首个顶层逗号**切成"方程 + 各条初值".
///
/// 语法层 `expr` 的停止集是 `;`/`{`/`}`,不含逗号,所以
/// `y' + p*y = q, y(0) = 1` 会整段落在 `expr` 里;这里按括号深度切出方程
/// (第一段)与初值原文(其余各段).括号内的逗号(函数实参)不会误切.
fn split_ode_conditions(text: &str) -> (String, Vec<String>) {
    let mut depth = 0i32;
    let mut parts: Vec<String> = Vec::new();
    let mut start = 0usize;
    for (index, ch) in text.char_indices() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(text[start..index].trim().to_string());
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(text[start..].trim().to_string());
    let mut iter = parts.into_iter();
    let equation = iter.next().unwrap_or_default();
    let conditions: Vec<String> = iter.filter(|part| !part.is_empty()).collect();
    (equation, conditions)
}

/// 将微分方程语句(ode_stmt)转换为 JSON AST 节点.
///
/// 形状:`{ type, name, equation, initialConditions, options, span }`.
/// `equation` 是首个顶层逗号之前的原文(含顶层 `=`),`initialConditions` 是
/// 其余各段原文(如 `y(0) = 1` / `y'(0) = 1`)--内核负责解析与校验,
/// AST 只负责如实切分(见 compiler/ast/types.ts 的 OdeStatement).
pub(super) fn ode_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    let (equation, initial_conditions) = split_ode_conditions(&stmt_expr(pair));

    json!({
        "type": "ode",
        "name": pair_ident(pair),
        "equation": equation,
        "initialConditions": initial_conditions,
        "options": stmt_options(pair),
        "span": span_of(pair),
    })
}

#[cfg(test)]
mod tests {
    use super::split_ode_conditions;
    use crate::parser_wasm::parse_to_json;
    use serde_json::Value;

    #[test]
    fn parses_ode_with_initial_conditions_and_options() {
        let src = r##"
ode O1 = y' = x*y;
ode O2 = y' + p*y = q, y(0) = 1;
ode O3 = y'' - 3*y' + 2*y = 0, y(0) = 0, y'(0) = 1;
ode O6 = y' = x*y {
    curves = 3;
    range = [-2, 2, -2, 2];
};
"##;
        let json = parse_to_json(src).unwrap();
        let ast: Value = serde_json::from_str(&json).unwrap();
        let statements = ast["statements"].as_array().unwrap();
        assert_eq!(statements.len(), 4);

        assert_eq!(statements[0]["type"], "ode");
        assert_eq!(statements[0]["equation"], "y' = x*y");
        assert_eq!(
            statements[0]["initialConditions"].as_array().unwrap().len(),
            0
        );

        // 首个顶层逗号是方程与初值的分界;初值里的括号/逗号不影响切分.
        assert_eq!(statements[1]["equation"], "y' + p*y = q");
        assert_eq!(statements[1]["initialConditions"][0], "y(0) = 1");

        assert_eq!(statements[2]["equation"], "y'' - 3*y' + 2*y = 0");
        assert_eq!(statements[2]["initialConditions"][0], "y(0) = 0");
        assert_eq!(statements[2]["initialConditions"][1], "y'(0) = 1");

        let options = statements[3]["options"].as_array().unwrap();
        assert_eq!(options.len(), 2);
        assert_eq!(options[0]["name"], "curves");
        assert_eq!(options[1]["value"], "[-2, 2, -2, 2]");
    }

    #[test]
    fn splits_ode_conditions_on_top_level_commas_only() {
        // 括号内的逗号(函数实参)不是分界.
        let (equation, conditions) = split_ode_conditions("y' = f(x, y), y(0) = 1");
        assert_eq!(equation, "y' = f(x, y)");
        assert_eq!(conditions, vec!["y(0) = 1".to_string()]);
    }
}
