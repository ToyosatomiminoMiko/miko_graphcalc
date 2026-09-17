//! `.miko` DSL 源码 -> AST JSON 的解析门面(compiler_rs 的语法层).
//!
//! 职责与约定:
//! - 只做"语法 -> AST JSON"的忠实转写:表达式一律保留原文,数学语义(常量
//!   折叠,类型/维度判断,参数求值)全留给 TS 侧编译层,这里不猜;
//! - AST 的 TypeScript 形状以 `compiler/ast/types.ts` 为唯一 schema:这里直接
//!   构造 JSON,不维护 Rust 镜像类型,改 DSL 时不必在 Rust enum 与 TS
//!   interface 两处同步;
//! - 每个节点带 `span`(pest 字节偏移),供编辑器与错误定位;
//! - 未知语句规则必须报错而不是静默丢弃,见 [`statement_to_ast`];
//! - 本模块不依赖 wasm-bindgen,`cargo test` 可纯 Rust 验证;wasm 皮在
//!   `lib.rs::parse_miko`.
//!
//! 结构整理(202609,原单文件 1011 行):
//! 入口只认两个名字--[`parse_to_json`](被 lib.rs 调用)与 [`MikoParser`](语法);
//! [`statement_to_ast`] 是全模块**唯一扇出点**,其余函数只被语句转换调用,
//! 彼此不互相调用,所以按语句族切子模块不动公开面:
//! - `param`:参数语句(param,含 UI 约束与 `in cyclic` 文本切分);
//! - `scene`:变量声明与场景语句(tensor,animation,object);
//! - `calculus`:分析与微积分,求交(analysis,integral,derivative,
//!   antiderivative,intersection);
//! - `solve`:方程与微分方程(solve,ode);
//! - 本文件留语法声明,语句取样原语,扇出点,总入口与分派/冒烟测试.
//!
//! 语句族分组只为可读,不产生依赖:子模块之间没有调用关系,新增语句按形状
//! 就近落位,并在 [`statement_to_ast`] 与 `miko.pest` 的 `statement` 里各登记
//! 一处.
//!
//! 取样原语(子模块的公共词汇):
//! pest 的语句节点共用一副骨架--"标识符 + 可选 kind/op + 表达式或调用 + 可选
//! stmt_end",差别只在规则名.[`pair_ident`] / [`child_text`] / [`stmt_expr`] /
//! [`call_idents`] / [`stmt_options`] 把这层子节点遍历收在一处,子模块只把取到
//! 的值组装成 JSON 形状;新增语句优先复用它们,不再手写一遍 match 遍历.
//! 两个例外留在子模块:`param` 的 `param_value`(要按文本切 `in cyclic`)与
//! `calculus` 的 `op_call` / `at`(球坐标与笛卡尔两种形式).

use pest::iterators::Pair;
use pest::Parser;
use pest_derive::Parser;
use serde_json::{json, Value};

#[derive(Parser)]
#[grammar = "miko.pest"]
pub struct MikoParser;

mod calculus;
mod param;
mod scene;
mod solve;

// ================================================================
// 语句取样原语:子模块共用,见文件头"取样原语"
// ================================================================

/// 获取语法树节点的源码位置(起始和结束偏移),返回 JSON 对象
fn span_of(pair: &Pair<'_, Rule>) -> Value {
    let span = pair.as_span();
    json!({
        "start": span.start(),
        "end": span.end(),
    })
}

/// 取语句里 `kind` / `op` 这类单 token 子规则的原文(tensor_kind,object_kind,
/// analysis_op);语句没有该子节点时返回空串.
fn child_text(pair: &Pair<'_, Rule>, rule: Rule) -> String {
    pair.clone()
        .into_inner()
        .find(|child| child.as_rule() == rule)
        .map(|child| child.as_str().to_string())
        .unwrap_or_default()
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

/// 取语句的表达式原文(首尾空白 trim);语句没有 `expr` 子节点时返回空串.
fn stmt_expr(pair: &Pair<'_, Rule>) -> String {
    pair.clone()
        .into_inner()
        .find(|child| child.as_rule() == Rule::expr)
        .map(|child| child.as_str().trim().to_string())
        .unwrap_or_default()
}

/// 从 `*_call` 子节点里按出现顺序取 ident 列表.
///
/// 各类调用的实参在语法上全是 ident(见 miko.pest 的 integral_call /
/// intersection_call / derivative_call / antiderivative_call / op_call):
/// 一元调用取第 1 个,二元调用取前 2 个,`op_call` 的第 1 个则是算子名.
fn call_idents(pair: &Pair<'_, Rule>, call: Rule) -> Vec<String> {
    pair.clone()
        .into_inner()
        .find(|child| child.as_rule() == call)
        .map(|node| {
            node.into_inner()
                .filter(|inner| inner.as_rule() == Rule::ident)
                .map(|inner| inner.as_str().to_string())
                .collect()
        })
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

/// 取语句的选项列表(即 `stmt_end` 里的 `options`).
/// 语句用裸 `;` 收尾(param / tensor)或选项块为空时都返回空数组.
fn stmt_options(pair: &Pair<'_, Rule>) -> Vec<Value> {
    pair.clone()
        .into_inner()
        .find(|child| child.as_rule() == Rule::stmt_end)
        .map(|end| options_from_end(&end))
        .unwrap_or_default()
}

// ================================================================
// 扇出点:语句规则 -> 子模块转换器
// ================================================================

/// 根据语法规则将单个语句节点(Pair)转换为对应的 AST JSON 节点.
/// 若规则未知,则返回错误信息.
///
/// 这是全模块唯一的扇出点:总入口只调这里;新增语句规则要在
/// `miko.pest` 的 `statement`,这里,以及 TS 的 AST 联合类型各登记一处.
fn statement_to_ast(pair: Pair<'_, Rule>) -> Result<Value, String> {
    match pair.as_rule() {
        Rule::param_stmt => Ok(param::param_to_stmt(&pair)),
        Rule::tensor_stmt => Ok(scene::tensor_to_stmt(&pair)),
        Rule::animation_stmt => Ok(scene::animation_to_stmt(&pair)),
        Rule::object_stmt => Ok(scene::object_to_stmt(&pair)),
        Rule::analysis_stmt => Ok(calculus::analysis_to_stmt(&pair)),
        Rule::integral_stmt => Ok(calculus::integral_to_stmt(&pair)),
        Rule::intersection_stmt => Ok(calculus::intersection_to_stmt(&pair)),
        Rule::derivative_stmt => Ok(calculus::derivative_to_stmt(&pair)),
        Rule::solve_stmt => Ok(solve::solve_to_stmt(&pair)),
        Rule::antiderivative_stmt => Ok(calculus::antiderivative_to_stmt(&pair)),
        Rule::ode_stmt => Ok(solve::ode_to_stmt(&pair)),
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

// ================================================================
// 门面测试:扇出点语义 + 跨语句族冒烟
//
// 各族字段细节在各子模块的测试里;这里只放"只能在门面验证"的两条:整份源码
// 跑通(冒烟),以及未知规则必须报错(扇出点的契约).
// ================================================================
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
intersection Y = intersection(s1, S);
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
