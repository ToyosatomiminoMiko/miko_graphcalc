use pest::iterators::Pair;
use pest::Parser;
use pest_derive::Parser;
use serde_json::{json, Value};
// 本解析器将 `.miko` DSL 源码解析为抽象语法树(AST)

#[derive(Parser)]
#[grammar = "miko.pest"]
pub struct MikoParser;

// AST 的 TypeScript 形状以 `compiler/ast/types.ts` 为唯一 schema;
// 这里不再维护一套 Rust 镜像类型,而是直接构造 JSON,避免改 DSL 时
// 需要在 Rust enum 和 TS interface 两处同步.

/// 获取语法树节点的源码位置(起始和结束偏移),返回 JSON 对象
fn span_of(pair: &Pair<'_, Rule>) -> Value {
    let span = pair.as_span();
    json!({
        "start": span.start(),
        "end": span.end(),
    })
}

/// 从节点中提取标识符(ident)的内容.
/// 先获取该节点的内部子节点,然后查找规则为 `ident` 的子节点,
/// 取其字符串值,若不存在则返回空字符串.
fn pair_ident(pair: &Pair<'_, Rule>) -> String {
    pair.clone()
        .into_inner()
        .find(|child| child.as_rule() == Rule::ident)
        .map(|child| child.as_str().to_string())
        .unwrap_or_default()
}

/// 从 `option` 规则节点中提取所有选项(option)的 name-value 对.
/// 每个 option 由 ident 和 value 组成,返回 JSON 数组.
fn option_pairs(pair: &Pair<'_, Rule>) -> Vec<Value> {
    pair.clone()
        .into_inner()
        .filter(|child| child.as_rule() == Rule::option)
        .map(|child| {
            let mut name = String::new();
            let mut value = String::new();
            for inner in child.into_inner() {
                match inner.as_rule() {
                    Rule::ident => name = inner.as_str().to_string(),
                    Rule::value => value = inner.as_str().trim().to_string(),
                    _ => {}
                }
            }
            json!({
                "name": name,
                "value": value,
            })
        })
        .collect()
}

/// 从 `*_end` 子节点中提取统一的 `{ option = value; ... }` 列表.
/// 调用 `option_pairs` 将其转换为 JSON 数组.
/// 若没有 options,返回空数组.
fn options_from_end(end: &Pair<'_, Rule>) -> Vec<Value> {
    end.clone()
        .into_inner()
        .find(|child| child.as_rule() == Rule::options)
        .map(|options| option_pairs(&options))
        .unwrap_or_default()
}

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
fn param_to_stmt(pair: &Pair<'_, Rule>) -> Value {
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

/// 将张量语句(tensor_stmt)转换为 JSON AST 节点.
/// 包含 kind(如 buffer, texture 等),名称,表达式(expr)和位置.
fn tensor_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    let mut kind = String::new();
    let mut name = String::new();
    let mut expr = String::new();

    for child in pair.clone().into_inner() {
        match child.as_rule() {
            Rule::tensor_kind => kind = child.as_str().to_string(),
            Rule::ident => name = child.as_str().to_string(),
            Rule::expr => expr = child.as_str().trim().to_string(),
            _ => {}
        }
    }

    json!({
        "type": "tensor",
        "kind": kind,
        "name": name,
        "expr": expr,
        "span": span_of(pair),
    })
}

/// 将动画语句(animation_stmt)转换为 JSON AST 节点.
/// 包含名称,表达式,选项列表和位置.
fn animation_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    let mut name = String::new();
    let mut expr = String::new();
    let mut options: Vec<Value> = Vec::new();

    for child in pair.clone().into_inner() {
        match child.as_rule() {
            Rule::ident => name = child.as_str().to_string(),
            Rule::expr => expr = child.as_str().trim().to_string(),
            Rule::stmt_end => options = options_from_end(&child),
            _ => {}
        }
    }

    json!({
        "type": "animation",
        "name": name,
        "expr": expr,
        "options": options,
        "span": span_of(pair),
    })
}

/// 将对象语句(object_stmt)转换为 JSON AST 节点.
/// 包含 kind(如 mesh, light 等),名称,表达式,选项列表和位置.
fn object_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    let mut kind = String::new();
    let mut name = String::new();
    let mut expr = String::new();
    let mut options: Vec<Value> = Vec::new();

    for child in pair.clone().into_inner() {
        match child.as_rule() {
            Rule::object_kind => kind = child.as_str().to_string(),
            Rule::ident => name = child.as_str().to_string(),
            Rule::expr => expr = child.as_str().trim().to_string(),
            Rule::stmt_end => options = options_from_end(&child),
            _ => {}
        }
    }

    json!({
        "type": "object",
        "kind": kind,
        "name": name,
        "expr": expr,
        "options": options,
        "span": span_of(pair),
    })
}

/// 将分析语句(analysis_stmt)转换为 JSON AST 节点.
/// 包含操作符(op),名称,调用(call),源(source),
/// 可选的 at 参数及其形式(atForm,球坐标时显式给出),选项列表和位置.
fn analysis_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    let mut op = String::new();
    let mut name = String::new();
    let mut call = String::new();
    let mut source = String::new();
    let mut at: Option<Vec<String>> = None;
    // `at spherical(...)` 才写 atForm;笛卡尔形式省略,TS 侧按缺省处理.
    let mut at_form: Option<String> = None;
    let mut options: Vec<Value> = Vec::new();

    for child in pair.clone().into_inner() {
        match child.as_rule() {
            Rule::analysis_op => op = child.as_str().to_string(),
            Rule::ident => name = child.as_str().to_string(),
            Rule::op_call => {
                for inner in child.into_inner() {
                    match inner.as_rule() {
                        Rule::ident => call = inner.as_str().to_string(),
                        Rule::op_arg => source = inner.as_str().trim().to_string(),
                        Rule::at => {
                            // at 的两种形式各带一个子规则:spherical_at / cartesian_at,
                            // 参数规则也随形式不同(at_expr 支持嵌套括号,at_arg 不支持).
                            for form in inner.into_inner() {
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
                        _ => {}
                    }
                }
            }
            Rule::stmt_end => options = options_from_end(&child),
            _ => {}
        }
    }

    let mut statement = json!({
        "type": "analysis",
        "op": op,
        "name": name,
        "call": call,
        "source": source,
        "options": options,
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
fn integral_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    let mut name = String::new();
    let mut source = String::new();
    let mut options: Vec<Value> = Vec::new();

    for child in pair.clone().into_inner() {
        match child.as_rule() {
            Rule::ident => name = child.as_str().to_string(),
            Rule::integral_call => {
                if let Some(source_ident) = child
                    .into_inner()
                    .find(|inner| inner.as_rule() == Rule::ident)
                {
                    source = source_ident.as_str().to_string();
                }
            }
            Rule::stmt_end => options = options_from_end(&child),
            _ => {}
        }
    }

    json!({
        "type": "integral",
        "name": name,
        "source": source,
        "options": options,
        "span": span_of(pair),
    })
}

/// 将求导语句(derivative_stmt)转换为 JSON AST 节点.
/// 包含名称,源对象(source),可选求导变量(variable),选项列表和位置.
/// 函数名遵循项目全名习惯(derivative),见 miko.pest 的 derivative_stmt.
fn derivative_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    let mut name = String::new();
    let mut source = String::new();
    let mut variable: Option<String> = None;
    let mut options: Vec<Value> = Vec::new();

    for child in pair.clone().into_inner() {
        match child.as_rule() {
            Rule::ident => name = child.as_str().to_string(),
            Rule::derivative_call => {
                let mut idents = child
                    .into_inner()
                    .filter(|inner| inner.as_rule() == Rule::ident);
                if let Some(first) = idents.next() {
                    source = first.as_str().to_string();
                }
                if let Some(second) = idents.next() {
                    variable = Some(second.as_str().to_string());
                }
            }
            Rule::stmt_end => options = options_from_end(&child),
            _ => {}
        }
    }

    let mut statement = json!({
        "type": "derivative",
        "name": name,
        "source": source,
        "options": options,
        "span": span_of(pair),
    });
    if let Some(variable) = variable {
        statement["variable"] = json!(variable);
    }
    statement
}

/// 将交集语句(intersection_stmt)转换为 JSON AST 节点.
/// 包含名称,两个操作数 a 和 b,选项列表和位置.
fn intersection_to_stmt(pair: &Pair<'_, Rule>) -> Value {
    let mut name = String::new();
    let mut a = String::new();
    let mut b = String::new();
    let mut options: Vec<Value> = Vec::new();

    for child in pair.clone().into_inner() {
        match child.as_rule() {
            Rule::ident => name = child.as_str().to_string(),
            Rule::intersection_call => {
                let mut args = child
                    .into_inner()
                    .filter(|inner| inner.as_rule() == Rule::ident);
                if let Some(first) = args.next() {
                    a = first.as_str().to_string();
                }
                if let Some(second) = args.next() {
                    b = second.as_str().to_string();
                }
            }
            Rule::stmt_end => options = options_from_end(&child),
            _ => {}
        }
    }

    json!({
        "type": "intersection",
        "name": name,
        "a": a,
        "b": b,
        "options": options,
        "span": span_of(pair),
    })
}

/// 根据语法规则将单个语句节点(Pair)转换为对应的 AST JSON 节点.
/// 若规则未知,则返回错误信息.
fn statement_to_ast(pair: Pair<'_, Rule>) -> Result<Value, String> {
    match pair.as_rule() {
        Rule::param_stmt => Ok(param_to_stmt(&pair)),
        Rule::tensor_stmt => Ok(tensor_to_stmt(&pair)),
        Rule::animation_stmt => Ok(animation_to_stmt(&pair)),
        Rule::object_stmt => Ok(object_to_stmt(&pair)),
        Rule::analysis_stmt => Ok(analysis_to_stmt(&pair)),
        Rule::integral_stmt => Ok(integral_to_stmt(&pair)),
        Rule::intersection_stmt => Ok(intersection_to_stmt(&pair)),
        Rule::derivative_stmt => Ok(derivative_to_stmt(&pair)),
        _ => Err(format!("未知语句规则: {:?}", pair.as_rule())),
    }
}

/// -------------
/// 总入口
/// -------------
/// 接收 `.miko` 源码字符串,返回 JSON 格式的 AST 字符串
/// 内部先调用 pest 解析器得到程序根节点,再遍历子节点(语句)逐一转换,
/// 最后将所有语句打包成 `{ "statements": [...] }` 并序列化为 JSON.
pub fn parse_to_json(source: &str) -> Result<String, String> {
    let mut pairs: pest::iterators::Pairs<'_, Rule> =
        MikoParser::parse(Rule::program, source).map_err(|err| err.to_string())?;
    // 取出唯一一个程序节点
    let program: Pair<'_, Rule> = pairs.next().ok_or_else(|| "空的解析结果".to_string())?;
    // 遍历程序节点的内部子节点,过滤掉 EOI(结束符),对每个语句节点调用 statement_to_ast
    let statements: Vec<Value> = program
        .into_inner()
        .filter(|child| child.as_rule() != Rule::EOI)
        .map(statement_to_ast)
        .collect::<Result<Vec<_>, _>>()?;
    // 构建最终 JSON 并序列化
    serde_json::to_string(&json!({ "statements": statements })).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_param_tensor_object_analysis_and_integral() {
        let src = r##"
// 这是单行注释
param a = 2 in [-5, 5, 0.1];
scalar k = 2.5;
vector v = [1, 2, 3];
matrix M = [[1, 0], [0, 1]];
transform T = translate([1, 2, 3]) * rotate([0, 0, pi / 4]);
animation spin = rotate([0, 0, pi / 4]) {
    duration = 2;
};
curve c1 = sin(x * a) {
    color = "#6dd5ff";
    range = [-8, 8];
    segments = 256;
    animation = [spin];
}
region R = region(c1, c1_2) {
    color = "#6bffb8";
    opacity = 0.35;
    range = [-4, 4];
    segments = 256;
}
curve c1_2 = x * a {
    range = [-8, 8];
}
surface s1 = sin(x) * cos(y) {
    transform = T;
    range = [-6, 6, -6, 6];
    segments = 96;
}
vector_field F = [y, -x, 0] {
    range = [-4, 4, -4, 4, -4, 4];
    grid = [8, 8, 8];
    scale = 1.2;
}
point P = [1, 2, 3] {
    color = "#6dd5ff";
}
vector V = [[0, 0, 0], [1, 0, 0]] {
    color = "#ff6b8a";
}
sphere S = [0, 1, 0] {
    radius = 2;
    opacity = 0.6;
}
box B = [1, 2, 3] {
    size = [2, 1, 1];
}
cylinder C = [0, 0, 0] {
    base = 1;
    height = 2;
}
cone K = [0, 0, 1] {
    base = 2;
    height = 3;
}
frustum F = [0, 0, -1] {
    base = 2;
    height = 3;
    top = 1;
}
gradient g = grad(s1) at [a, b + 1] {
    show = [point, normal, tangent_plane];
}
curl c = curl(F) at [1, 2, 3];
integral I1 = integral(c1) {
    method = riemann;
    range = [-8, 8];
    segments = 32;
};
integral I2 = integral(s1) {
    method = lebesgue;
    range = [-6, 6, -6, 6];
    segments = 32;
    layers = 16;
};
integral I3 = integral(c1) {
    method = riemann:right;
    range = [-8, 8];
    segments = 32;
};
intersection X = intersection(c1, s1) {
    color = "#ffffff";
    segments = 96;
};
intersect Y = intersect(s1, S);
"##;
        let json = parse_to_json(src).unwrap();
        assert!(json.contains("\"type\":\"param\""));
        assert!(json.contains("\"type\":\"tensor\""));
        assert!(json.contains("\"type\":\"animation\""));
        assert!(json.contains("\"type\":\"object\""));
        assert!(json.contains("\"kind\":\"point\""));
        assert!(json.contains("\"kind\":\"vector\""));
        assert!(json.contains("\"kind\":\"sphere\""));
        assert!(json.contains("\"kind\":\"box\""));
        assert!(json.contains("\"kind\":\"cylinder\""));
        assert!(json.contains("\"kind\":\"cone\""));
        assert!(json.contains("\"kind\":\"frustum\""));
        assert!(json.contains("\"kind\":\"region\""));
        assert!(json.contains("region(c1, c1_2)"));
        assert!(json.contains("\"type\":\"analysis\""));
        assert!(json.contains("\"type\":\"integral\""));
        assert!(json.contains("riemann:right"));
        assert!(json.contains("\"type\":\"intersection\""));
        assert!(json.contains("\"a\":\"c1\""));
        assert!(json.contains("\"b\":\"s1\""));
        assert!(json.contains("\"type\":\"intersection\""));
        assert!(json.contains("\"name\":\"Y\""));
        assert!(json.contains("\"a\":\"s1\""));
        assert!(json.contains("\"b\":\"S\""));
    }

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

    #[test]
    fn rejects_unknown_statement_rules_instead_of_dropping_them() {
        let pair = MikoParser::parse(Rule::number, "1")
            .unwrap()
            .next()
            .unwrap();

        let result = statement_to_ast(pair);
        assert!(result.is_err());
        let error = result.err().unwrap();
        assert!(error.contains("未知语句规则"));
    }
}
