//! 参数语句(param)的 AST 组装.
//!
//! `param` 是唯一带 UI 约束的语句,也是最需要文本兜底的一条:
//! - `param_ui`(`in [min, max, step]` 与显式 `cyclic`)走语法层;
//! - 缺省与边界写法(`a in[..]` / `1in[0,1,1]` / `2sin(x)`)由
//!   [`split_cyclic_param_value`] 在值原文上兜底,不改 pest 规则(理由见该函数).
//!
//! 字段形状见 `compiler/ast/types.ts`:不写 `cyclic` 的参数 JSON 里**没有**
//! `cyclic` 键,下游据此区分普通参数与循环类系数.

use pest::iterators::Pair;
use serde_json::{json, Value};

use super::{pair_ident, span_of, Rule};

/// 提取参数语句的可选 UI 约束(param_ui).
/// 如果存在,则提取三个数字(min, max, step)并返回 JSON 对象.
fn param_ui(pair: &Pair<'_, Rule>) -> Option<Value> {
    pair.clone()
        .into_inner()
        .find(|child| child.as_rule() == Rule::param_ui)
        .map(|ui| {
            let nums: Vec<String> = ui
                .into_inner()
                .filter(|child| child.as_rule() == Rule::number)
                .map(|child| child.as_str().to_string())
                .collect();
            json!({
                "min": nums.first().cloned().unwrap_or_default(),
                "max": nums.get(1).cloned().unwrap_or_default(),
                "step": nums.get(2).cloned().unwrap_or_default(),
            })
        })
}

/// param_ui 里是否显式写了 `cyclic`.
///
/// 循环类系数只有在显式写 `in cyclic [...]` 时才成立;缺省(只有 `in [...]`)
/// 一律按普通参数处理,TS 侧也从缺省 false 出发,不靠"猜周期".
fn param_ui_is_cyclic(pair: &Pair<'_, Rule>) -> bool {
    pair.clone()
        .into_inner()
        .find(|child| child.as_rule() == Rule::param_ui)
        .map(|ui| ui.into_inner().any(|child| child.as_rule() == Rule::cyclic))
        .unwrap_or(false)
}

/// 从 param_value 原文里切出 `in cyclic [min, max, step]`(循环类系数).
///
/// 为什么在 Rust 侧切而不是写进 pest:
/// `param_value` 的边界规则(`" in" ~ 空白* ~ "["`,见 miko.pest)已经处理了
/// `a in[..]` / `1in[0,1,1]` / `2sin(x)` 这些既有写法,给 `in cyclic` 再加一套
/// 前瞻会把 pest 的隐式空白/前瞻回退搅在一起(实测 `in` 会被整段吞掉).
/// 这里改成"语法照旧吃到 `in [...]` 之前,文本上显式识别 cyclic 子串":
/// - 只在 `in` 前有空白,`in` 后是 `cyclic` 关键字,再往后是 `[...]` 时成立;
/// - `ln(x) in cyclic [...]` 这类值不受影响(前缀照旧是表达式);
/// - 缺省返回 None,`param_value` 原样返回,普通参数一个字节都不动.
fn split_cyclic_param_value(raw: &str) -> Option<(String, Value)> {
    let trimmed = raw.trim();
    let mut search_from = 0usize;
    while let Some(offset) = trimmed[search_from..].find("in") {
        let index = search_from + offset;
        search_from = index + 2;

        // `in` 必须是独立关键字:前一位是空白(或串首),后一位不是标识符字符,
        // 否则 `sin(x)` 里的 "in" 会被误认.
        let before_ok = index == 0
            || trimmed[..index]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);
        let after = &trimmed[index + 2..];
        let after_ok = after
            .chars()
            .next()
            .is_some_and(|c| !(c.is_ascii_alphanumeric() || c == '_'));
        if !before_ok || !after_ok {
            continue;
        }

        let after_trimmed = after.trim_start();
        let Some(rest) = after_trimmed.strip_prefix("cyclic") else {
            continue;
        };
        // `cyclic` 也必须是独立关键字(后面只能是空白或 `[`).
        let rest_ok = rest
            .chars()
            .next()
            .is_none_or(|c| c.is_whitespace() || c == '[');
        if !rest_ok {
            continue;
        }

        let rest = rest.trim_start();
        let Some(inner) = rest.strip_prefix('[') else {
            continue;
        };
        let Some(close) = inner.find(']') else {
            continue;
        };
        let nums: Vec<&str> = inner[..close]
            .split(',')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect();
        if nums.len() != 3 {
            continue;
        }

        let value = trimmed[..index].trim().to_string();
        let ui = json!({
            "min": nums[0],
            "max": nums[1],
            "step": nums[2],
        });
        return Some((value, ui));
    }
    None
}

/// 将参数语句(param_stmt)转换为 JSON AST 节点.
/// 包含类型,名称,值,位置,以及可选的 UI 约束与 cyclic 标记.
pub(super) fn param_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    let name = pair_ident(pair);
    let raw = pair
        .clone()
        .into_inner()
        .find(|child| child.as_rule() == Rule::param_value)
        .map(|child| child.as_str().trim().to_string())
        .unwrap_or_default();
    // 显式 `in cyclic [...]` 从值文本里切出;切不出来就按普通参数处理.
    let cyclic_ui = split_cyclic_param_value(&raw);

    let mut statement = json!({
        "type": "param",
        "name": name,
        "value": cyclic_ui
            .as_ref()
            .map(|(value, _)| value.clone())
            .unwrap_or(raw),
        "span": span_of(pair),
    });
    if let Some(ui) = param_ui(pair) {
        statement["ui"] = ui;
    }
    // 只在显式声明时落字段:TS 侧 `statement.cyclic` 缺省即普通参数.
    // 两种写法(语法层 param_ui 与值文本里的 cyclic)都认,取更宽松的并集:
    // 前者已被 miko.pest 收在 `in` 里,后者由上面的切分兜住.
    if param_ui_is_cyclic(pair) {
        statement["cyclic"] = json!(true);
    }
    if let Some((_, ui)) = cyclic_ui {
        statement["cyclic"] = json!(true);
        if statement.get("ui").is_none() {
            statement["ui"] = ui;
        }
    }
    statement
}

#[cfg(test)]
mod tests {
    use crate::parser_wasm::parse_to_json;
    use serde_json::Value;

    #[test]
    fn param_value_boundary_rules_stay_intact() {
        // 循环类系数给 param_value 加了一条 `in cyclic` 前瞻,这里用既有写法
        // 回归边界:无空格区间,隐式乘法,圆括号都不能被误截断/误当区间头.
        let src = r##"
param a = 1 in[-2, 2, 0.1];
param b = 2sin(x);
param c = 1in[0, 1, 1];
param d = sin(a) in [0, 3, 0.1];
"##;
        let value: Value = serde_json::from_str(&parse_to_json(src).unwrap()).unwrap();
        let statements = value["statements"].as_array().unwrap();
        assert_eq!(statements.len(), 4);
        assert_eq!(statements[0]["value"], "1");
        assert_eq!(statements[0]["ui"]["min"], "-2");
        assert_eq!(statements[1]["value"], "2sin(x)");
        assert!(statements[1].get("ui").is_none());
        assert_eq!(statements[2]["value"], "1in[0, 1, 1]");
        assert!(statements[2].get("ui").is_none());
        assert_eq!(statements[3]["value"], "sin(a)");
        assert_eq!(statements[3]["ui"]["min"], "0");
    }

    #[test]
    fn parses_cyclic_param_only_when_explicitly_declared() {
        // `in cyclic [...]` 是循环类系数的唯一显式标记;不写 cyclic 的参数
        // 必须保持完全一样的 JSON 形状(不带 "cyclic" 字段),避免下游把
        // 普通参数误当周期量处理.
        let src = r##"
param phi = 0 in cyclic [-3.14159, 3.14159, 0.01];
param a = 1 in [-2, 2, 0.1];
param b = 3;
sphere s = [0, 0, 0] { radius = 2; }
gradient g = grad(s) at spherical(phi, phi);
"##;
        let value: Value = serde_json::from_str(&parse_to_json(src).unwrap()).unwrap();
        let statements = value["statements"].as_array().unwrap();
        let params: Vec<&Value> = statements
            .iter()
            .filter(|stmt| stmt["type"] == "param")
            .collect();
        assert_eq!(params.len(), 3);

        assert_eq!(params[0]["name"], "phi");
        assert_eq!(params[0]["value"], "0");
        assert_eq!(params[0]["cyclic"], true);
        assert_eq!(
            params[0]["ui"],
            serde_json::json!({
                "min": "-3.14159",
                "max": "3.14159",
                "step": "0.01",
            })
        );

        assert!(params[1].get("cyclic").is_none());
        assert_eq!(params[1]["ui"]["min"], "-2");
        assert!(params[2].get("ui").is_none());
        assert!(params[2].get("cyclic").is_none());
    }

    #[test]
    fn rejects_cyclic_without_range() {
        // 循环需要区间才有意义:cyclic 只能写在 `in [...]` 里面.
        let result = parse_to_json("param phi = 0 in cyclic;\n");
        assert!(result.is_err());
    }
}
