//! 变量声明与场景语句的 AST 组装(tensor,animation,object).
//!
//! 这一族的形状统一为"kind? + 名称 + 表达式 + 选项":三条语句的差别只在
//! 有没有 `kind`(`tensor_kind` / `object_kind`)与选项块,所以转换器几乎是
//! 声明式的--字段直接取自 [`child_text`] / [`pair_ident`] / [`stmt_expr`] /
//! [`stmt_options`].
//!
//! 语义边界:表达式一律原文透出,几何装配与求值由 TS 侧按 kind 分派;
//! `implicit` 的维度也由 TS 侧按表达式里的坐标变量推断,这里不做数学判断.

use pest::iterators::Pair;
use serde_json::{json, Value};

use super::{child_text, pair_ident, span_of, stmt_expr, stmt_options, Rule};

/// 将张量语句(tensor_stmt)转换为 JSON AST 节点.
/// 包含 kind(如 buffer, texture 等),名称,表达式(expr)和位置.
pub(super) fn tensor_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    json!({
        "type": "tensor",
        "kind": child_text(pair, Rule::tensor_kind),
        "name": pair_ident(pair),
        "expr": stmt_expr(pair),
        "span": span_of(pair),
    })
}

/// 将动画语句(animation_stmt)转换为 JSON AST 节点.
/// 包含名称,表达式,选项列表和位置.
pub(super) fn animation_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    json!({
        "type": "animation",
        "name": pair_ident(pair),
        "expr": stmt_expr(pair),
        "options": stmt_options(pair),
        "span": span_of(pair),
    })
}

/// 将对象语句(object_stmt)转换为 JSON AST 节点.
/// 包含 kind(如 mesh, light 等),名称,表达式,选项列表和位置.
pub(super) fn object_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    json!({
        "type": "object",
        "kind": child_text(pair, Rule::object_kind),
        "name": pair_ident(pair),
        "expr": stmt_expr(pair),
        "options": stmt_options(pair),
        "span": span_of(pair),
    })
}

#[cfg(test)]
mod tests {
    use crate::parser_wasm::parse_to_json;
    use serde_json::Value;

    #[test]
    fn parses_implicit_field_statements() {
        // 隐式对象与 curve/surface 一样走 object_stmt,只是 kind 为 implicit;
        // 维度由编译器按表达式里的坐标变量推断,Rust 侧不做数学判断.
        let src = r##"
implicit C = x^2 + y^2 - 1 {
    color = "#6dd5ff";
}
implicit S = x^2 + y^2 + z^2 - 4 {
    level = 0;
}
derivative dS = derivative(S);
gradient g = grad(S) at [j, k, l] {
    show = [point, normal, tangent_plane];
}
"##;
        let value: Value = serde_json::from_str(&parse_to_json(src).unwrap()).unwrap();
        let statements = value["statements"].as_array().unwrap();
        let implicits: Vec<&Value> = statements
            .iter()
            .filter(|stmt| stmt["type"] == "object" && stmt["kind"] == "implicit")
            .collect();
        assert_eq!(implicits.len(), 2);
        assert_eq!(implicits[0]["name"], "C");
        assert_eq!(implicits[0]["expr"], "x^2 + y^2 - 1");
        assert_eq!(implicits[1]["name"], "S");
        assert_eq!(implicits[1]["options"][0]["name"], "level");

        let derivative = statements
            .iter()
            .find(|stmt| stmt["type"] == "derivative")
            .unwrap();
        assert_eq!(derivative["source"], "S");
        let gradient = statements
            .iter()
            .find(|stmt| stmt["type"] == "analysis")
            .unwrap();
        assert_eq!(gradient["at"].as_array().unwrap().len(), 3);
    }
}
