//! 轻量符号表达式引擎(模块根).
//!
//! 目标不是复刻完整的外部数学库,而是把项目中实际依赖的符号能力
//! (解析/别名归一化/符号求导/自由变量提取/数组解析/常量矩阵求值)
//! 迁到 Rust/WASM,使 TS 编译层和数值层不再依赖外部 JS 数学库.
//!
//! 按阶段拆成子模块,避免单一超长文件:
//! - `parser`    - 词法/Pratt 语法分析,别名归一化,函数支持与元数校验;
//! - `eval`      - 已编译表达式的数值解释器与实数幂语义(`real_pow`);
//! - `printing`  - 文本打印(归一化字符串 / `Display`,数字 round-trip);
//! - `latex`     - UI 公式的 LaTeX 排版(仅展示用,不参与数值路径);
//! - `simplify`  - 常量求值(matrix 条目)与代数化简;
//! - `derivative`- 符号求导(链式法则 + simplify).
//!
//! 行为契约(WASM 边界):
//! - 所有入口**不 panic**:错误一律以 `Err(String)` 返回(编码规范第 5 条),
//!   wasm 上 panic 会走 abort,异常不会滚回影子栈指针;
//! - `normalize_expression` 的产物是**可执行字符串**(数字必须 round-trip,
//!   见 `printing.rs` 头契约),它会被 TS 侧 `evaluate_scalar` 重新解析;
//! - 元数/未知函数在 `parser::validate_supported` 一处校验,四个入口
//!   (normalize/derivative/latex/eval)结论一致(202609 审查 SYM-P2.1);
//! - `matrix4_from_expr` 是**结构参数**入口,非有限条目直接报错(SYM-P2.2),
//!   不套用采样层的"非有限=掩码"语义.
//!
//! 202609 审查修复锚点在本仓库内统一写成 `SYM-x.y`;旧注释里的裸 `P1.x`/
//! `P2.x`/`P3` 与本次报告编号语义不同,迁移对照见
//! `prompt/review_report.md` 的"历史锚点对照"一节.

mod derivative;
mod eval;
mod latex;
mod parser;
mod printing;
mod simplify;

pub(crate) use eval::{compile_runtime_expr, evaluate_runtime_expr};
pub use latex::latex_expression;

use std::collections::HashSet;

use crate::builtins;

use derivative::derivative;
use parser::{parse_expr, rewrite_aliases, validate_supported};
use simplify::evaluate_constant;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Expr {
    Num(f64),
    Sym(String),
    Unary(UnaryOp, Box<Expr>),
    Binary(BinOp, Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
    List(Vec<Expr>),
}

/// 供数值求值使用的已编译表达式.
///
/// 类型保持 crate 内部可见:外部仍通过表达式字符串与 WASM 入口交互.
pub(crate) type RuntimeExpr = Expr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnaryOp {
    Neg,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Pow,
}

impl BinOp {
    fn prec(self) -> u8 {
        match self {
            Self::Add | Self::Sub => 20,
            Self::Mul | Self::Div => 40,
            Self::Pow => 70,
        }
    }

    fn text(self) -> &'static str {
        match self {
            Self::Add => "+",
            Self::Sub => "-",
            Self::Mul => "*",
            Self::Div => "/",
            Self::Pow => "^",
        }
    }
}

/// 自由变量提取时应当跳过的名字.
///
/// 契约(202609 审查 SYM-P3.2):**被常量表吸收的名字**才排除(`pi`/`PI`/`e`/
/// `E`/`Infinity`/`NaN` 有值,`i`/`true`/`false`/`null` 是保留字);函数名/
/// 别名名(`sin`/`deg`/...)算自由符号报出--否则 `symbolic_variables("sin")`
/// 返回空表,调用方以为"没有自由变量",求值却报"变量 'sin' 未定义",
/// 前后矛盾.提取结果只服务于"有哪些自由符号需要声明",不作数值保证.
fn builtin_symbol(name: &str) -> bool {
    builtins::constant_value(name).is_some() || builtins::is_reserved_word(name)
}

fn collect_symbols(expr: &Expr, out: &mut Vec<String>) {
    match expr {
        Expr::Sym(name) => {
            if !builtin_symbol(name) {
                out.push(name.clone());
            }
        }
        Expr::Unary(_, operand) => collect_symbols(operand, out),
        Expr::Binary(_, left, right) => {
            collect_symbols(left, out);
            collect_symbols(right, out);
        }
        Expr::Call(_, args) => {
            for arg in args {
                collect_symbols(arg, out);
            }
        }
        Expr::List(items) => {
            for item in items {
                collect_symbols(item, out);
            }
        }
        Expr::Num(_) => {}
    }
}

fn json_escape(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch => out.push(ch),
        }
    }
    out
}

fn expr_list_json(expr: &Expr) -> Result<String, String> {
    match expr {
        Expr::List(items) => {
            let body = items
                .iter()
                .map(expr_list_json)
                .collect::<Result<Vec<_>, _>>()?
                .join(", ");
            Ok(format!("[{body}]"))
        }
        other => Ok(format!("\"{}\"", json_escape(&other.to_string()))),
    }
}

// ============================================================
// WASM 入口
// ============================================================

/// 归一化为**可执行字符串**:解析 -> 别名重写 -> 元数/函数校验 -> 打印.
///
/// 输出契约:数字 round-trip 精确(见 `printing.rs` 文件头),
/// TS 侧 `evaluate_scalar` 会把它重新解析成数值路径的输入.
pub fn normalize_expression(expr: &str) -> Result<String, String> {
    let parsed = parse_expr(expr)?;
    let rewritten = rewrite_aliases(&parsed)?;
    validate_supported(&rewritten)?;
    Ok(rewritten.to_string())
}

/// 对 `expr` 求 `d/d(variable)`,返回归一化后的文本表达式.
///
/// 别名先展开,再走元数校验;结果是实数语义下的符号导数(`|x|` 用
/// `sign(x)` 表达,见 `builtins.rs`),不做多项式正规化(见 `simplify.rs`).
pub fn symbolic_derivative(expr: &str, variable: &str) -> Result<String, String> {
    if variable.trim().is_empty() {
        return Err("求导变量不能为空".to_string());
    }
    let parsed = parse_expr(expr)?;
    let result = derivative(&parsed, variable.trim())?;
    Ok(result.to_string())
}

/// 列出表达式里的自由符号(排序去重),供调用方做"参数是否已声明"的校验.
///
/// 行为契约(202609 审查 SYM-P3.2):
/// - 已折叠/登记的常量不算自由符号(`pi`/`PI`/`e`/`E`/`Infinity`/`NaN`,
///   以及保留字 `i`/`true`/`false`/`null`);
/// - **函数名与别名名算自由符号**:`sin`(不带括号)求值时是"未定义变量",
///   这里必须报出来,不能让调用方以为"没有自由变量";
/// - `exclude` 里的名字额外剔除;结果只回答"有哪些自由符号",不保证可求值.
pub fn symbolic_variables(expr: &str, exclude: &[String]) -> Result<Vec<String>, String> {
    let parsed = parse_expr(expr)?;
    let rewritten = rewrite_aliases(&parsed)?;
    let excluded: HashSet<&str> = exclude.iter().map(String::as_str).collect();
    let mut names = Vec::new();
    collect_symbols(&rewritten, &mut names);

    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for name in names {
        if excluded.contains(name.as_str()) || !seen.insert(name.clone()) {
            continue;
        }
        result.push(name);
    }
    result.sort();
    Ok(result)
}

/// 把数组字面量转成 JSON 字符串(嵌套数组保留结构,叶子是表达式文本).
///
/// 元素只做别名重写与打印,不求值:变量名原样保留,供上层按名绑定.
///
/// 刻意**不做**元数/函数校验(与 `normalize_expression` 的分工不同):
/// 本入口服务于 point/vector 这类结构字面量,其中未知符号是合法坐标参数;
/// 需要数值求值的分量在进入这里之前已经各自走过 `normalize_expression`.
pub fn parse_array_strings(expr: &str) -> Result<String, String> {
    let parsed = parse_expr(expr)?;
    let rewritten = rewrite_aliases(&parsed)?;
    expr_list_json(&rewritten)
}

/// 从 `[[...]]` 或 `matrix([[...]])` 字面量取出 4x4 矩阵的 16 个数值条目
/// (行主序).
///
/// 行为契约(202609 审查 SYM-P2.2):矩阵是**结构参数**,不是采样值,不存在
/// "非有限 = 掩码"的语义;条目必须是常量表达式且结果有限,`1/0` / `0/0`
/// 一律报错并带上行列下标,绝不放 inf/NaN 进渲染/积分链.
pub fn matrix4_from_expr(expr: &str) -> Result<Vec<f64>, String> {
    let parsed = parse_expr(expr)?;
    let rewritten = rewrite_aliases(&parsed)?;
    let rows = match rewritten {
        Expr::Call(name, args) if name == "matrix" && args.len() == 1 => match &args[0] {
            Expr::List(rows) => rows.clone(),
            _ => return Err("matrix() 参数必须是二维数组".to_string()),
        },
        Expr::List(rows) => rows,
        _ => return Err("矩阵必须是 [[...]] 或 matrix([[...]]) 形式".to_string()),
    };

    if rows.len() != 4 {
        return Err("矩阵必须为 4 行".to_string());
    }

    let mut out = Vec::with_capacity(16);
    for (row_index, row) in rows.iter().enumerate() {
        match row {
            Expr::List(items) if items.len() == 4 => {
                for (column_index, item) in items.iter().enumerate() {
                    let value = evaluate_constant(item)?;
                    // 202609 审查 SYM-P2.2:矩阵是**结构参数**,不是采样值,没有
                    // "非有限 = 掩码"的语义.`1/0` / `0/0` 这类条目过去会静默
                    // 产出 inf/NaN 并污染整条变换链,这里按编码规范
                    // "非有限输入要有明确语义"直接报错并带上行列下标.
                    if !value.is_finite() {
                        return Err(format!(
                            "矩阵第 {} 行第 {} 列不是有限数值: {item}",
                            row_index + 1,
                            column_index + 1
                        ));
                    }
                    out.push(value);
                }
            }
            _ => return Err("矩阵每一行必须为 4 个元素".to_string()),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_implicit_multiplication() {
        assert_eq!(normalize_expression("sin(2x)").unwrap(), "sin(2 * x)");
        assert_eq!(normalize_expression("2 x").unwrap(), "2 * x");
        assert_eq!(normalize_expression("x y").unwrap(), "x * y");
    }

    #[test]
    fn rewrites_common_aliases() {
        assert_eq!(normalize_expression("log(x)").unwrap(), "ln(x)");
        assert_eq!(normalize_expression("pow(x, 2)").unwrap(), "x ^ 2");
        assert_eq!(normalize_expression("sec(x)").unwrap(), "1 / cos(x)");
        assert_eq!(normalize_expression("cot(x)").unwrap(), "cos(x) / sin(x)");
        assert_eq!(normalize_expression("pi").unwrap(), "3.141592653589793");
        // deg(180) 的系数是 f64(PI/180),归一化串必须原样回读:
        // 打印成 0.017453292519943(少 3 位)会让 180*该值 != PI(见
        // `normalize_evaluate_round_trip_preserves_semantics`).
        assert_eq!(
            normalize_expression("deg(180)").unwrap(),
            "180 * 0.017453292519943295"
        );
    }

    /// 归一化串 -> 求值 的往返等价(202609 审查 SYM-P1.1).
    ///
    /// 这是 SYM-P1.1 真正该守的断言:只测 `real_pow` 会被"归一化把指数吃成 0"
    /// 这条上游路径绕开.断言的是**语义等价**(归一化后求值 == 直接求值),
    /// 因此不锁死打印形态,只锁死精度.
    #[test]
    fn normalize_evaluate_round_trip_preserves_semantics() {
        fn evaluate(source: &str, scope: &[(&str, f64)]) -> Result<Option<f64>, String> {
            let node = compile_runtime_expr(source)?;
            let variables: std::collections::HashMap<String, f64> = scope
                .iter()
                .map(|(name, value)| (name.to_string(), *value))
                .collect();
            evaluate_runtime_expr(&node, &variables)
        }

        fn assert_same(raw: &str, scope: &[(&str, f64)]) {
            let direct = evaluate(raw, scope);
            let normalized = normalize_expression(raw).unwrap();
            let round_trip = evaluate(&normalized, scope);
            match (direct, round_trip) {
                (Ok(Some(expected)), Ok(Some(actual))) => {
                    if expected.is_nan() {
                        assert!(actual.is_nan(), "{raw}: {normalized} 应为 NaN");
                    } else {
                        assert_eq!(
                            expected, actual,
                            "{raw} 归一化成 {normalized} 后求值精度不一致"
                        );
                    }
                }
                (Ok(None), Ok(None)) => {}
                (Err(_), Err(_)) => {}
                _ => panic!("{raw} 归一化成 {normalized} 后求值形态不一致"),
            }
        }

        // 微小量级不得被打印成 0.
        assert_same("1e-20", &[]);
        assert_same("1e-16", &[]);
        assert_same("4.9e-16", &[]);
        assert_same("x + 1e-20", &[("x", 1.0)]);
        assert_same("1e-20 * x", &[("x", 2.0)]);
        assert_same("1e300", &[]);
        assert_same("1e15", &[]);
        assert_same("1e16", &[]);
        // (-8)^(1e-16) 在归一化后必须仍是"微小非零指数",判无实值(NaN).
        assert_same("(-8)^(1e-16)", &[]);
        // deg(180) 的系数必须原样回读,不能被截断.
        assert_same("deg(180)", &[]);
        assert!(normalize_expression("(-8)^(1e-16)")
            .unwrap()
            .contains("1e-16"));
    }

    /// 打印器本身的 round-trip 契约:每个字面量归一化后回读必须按位相等.
    ///
    /// 这是 SYM-P1.1 的最小复现集:`{:.15}` 会把 4.9e-16 打成 `0`,把 5e-16 打成
    /// `1e-15`(相对误差约 2 倍),所以 `1e-20` 这类量级必须走 `{:e}`.
    #[test]
    fn text_printer_round_trips_extreme_literals() {
        fn evaluate(source: &str) -> Option<f64> {
            let node = compile_runtime_expr(source).unwrap();
            evaluate_runtime_expr(&node, &std::collections::HashMap::new()).unwrap()
        }
        for literal in [
            "1e-20",
            "1e-16",
            "4.9e-16",
            "5e-16",
            "9.9e-16",
            "1e-17",
            "0.1",
            "0.017453292519943295",
            "1e15",
            "1e16",
            "1e300",
            "-0.5",
            "12345678901234567890",
        ] {
            let expected: f64 = literal.parse().unwrap();
            let normalized = normalize_expression(literal).unwrap();
            assert!(normalized != "0" || expected == 0.0, "{literal} 被打印成 0");
            assert_eq!(
                evaluate(&normalized),
                Some(expected),
                "{literal} 归一化成 {normalized} 后回读不一致"
            );
        }
    }

    /// 每个基础函数的元数在四个入口上结论一致(202609 审查 SYM-P1.2/SYM-P2.1).
    #[test]
    fn function_arity_is_enforced_consistently_across_entry_points() {
        for source in ["sin(x, y)", "sqrt(x, y)", "sqrt()", "exp()", "abs()"] {
            assert!(
                normalize_expression(source).is_err(),
                "{source} 应在归一化阶段报元数错误"
            );
            assert!(
                symbolic_derivative(source, "x").is_err(),
                "{source} 应在求导阶段报元数错误"
            );
            assert!(
                latex_expression(source).is_err(),
                "{source} 应在 LaTeX 阶段报元数错误"
            );
            assert!(
                compile_runtime_expr(source).is_err(),
                "{source} 应在编译阶段报元数错误"
            );
        }
        // 正常一元调用不受影响.
        assert_eq!(normalize_expression("sin(x)").unwrap(), "sin(x)");
        assert_eq!(latex_expression("sin(x)").unwrap(), "\\sin\\left(x\\right)");
    }

    /// 空参/多参调用只允许返回 Err,绝不允许 panic(编码规范第 5 条).
    #[test]
    fn latex_never_panics_on_wrong_arity() {
        for name in [
            "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh", "exp", "ln",
            "log10", "log2", "sqrt", "cbrt", "abs", "sign",
        ] {
            for call in [format!("{name}()"), format!("{name}(x, y)")] {
                if let Ok(text) = latex_expression(&call) {
                    assert!(!text.is_empty(), "{call} 不应产生空 LaTeX");
                }
            }
        }
        // 别名函数的元数错误本来就在展开阶段报错.
        assert!(latex_expression("deg(x, y)").is_err());
        assert!(normalize_expression("pow(x)").is_err());
    }

    /// LaTeX 双负号必须加括号(202609 审查 SYM-P3.7).
    #[test]
    fn latex_parenthesizes_nested_negation() {
        assert_eq!(latex_expression("--x").unwrap(), "-(-x)");
        assert_eq!(latex_expression("-(-x)").unwrap(), "-(-x)");
        assert_eq!(latex_expression("-(a + b)").unwrap(), "-(a + b)");
        assert_eq!(latex_expression("-x").unwrap(), "-x");
        assert_eq!(latex_expression("-2x").unwrap(), "-2\\,x");
    }

    /// 表达式树深预算:左结合长链报错而不是栈溢出(202609 审查 SYM-P1.3).
    #[test]
    fn deep_left_associated_chain_is_rejected_not_stack_overflow() {
        let chain = std::iter::repeat_n("x", 4000)
            .collect::<Vec<_>>()
            .join(" + ");
        let error = normalize_expression(&chain).unwrap_err();
        assert!(error.contains("过深"), "预算报错应可读: {error}");
        assert!(symbolic_derivative(&chain, "x").is_err());
        assert!(symbolic_variables(&chain, &[]).is_err());
        assert!(latex_expression(&chain).is_err());
    }

    /// 预算**边界内**的最深树对每个遍历都安全(202609 审查 SYM-P1.3).
    ///
    /// 用 `tree_depth - 1` 个 `+` 构造深度恰好等于 `MAX_TREE_DEPTH` 的左倾树:
    /// 它必须能通过解析,并且归一化/打印/化简/求导/变量提取/`Drop` 全都不炸栈
    /// (实测阈值见 `parser.rs` 的 `MAX_TREE_DEPTH` 注释;求导最紧).
    /// 这个用例把"预算值"和"遍历栈开销"绑在一起:调大预算而没测过遍历的人会
    /// 在这里当场看到失败,而不是线上 abort.
    #[test]
    fn deepest_allowed_tree_is_safe_for_every_traversal() {
        let depth = super::parser::MAX_TREE_DEPTH;
        let chain = std::iter::repeat_n("x", depth - 1)
            .collect::<Vec<_>>()
            .join(" + ");
        assert_eq!(
            normalize_expression(&chain).unwrap().matches(" + ").count(),
            depth - 2
        );
        assert!(latex_expression(&chain).is_ok());
        assert!(symbolic_derivative(&chain, "x").is_ok());
        assert_eq!(symbolic_variables(&chain, &[]).unwrap(), vec!["x"]);
    }

    /// 基础函数的元数表是单事实来源(202609 审查 SYM-P2.1).
    #[test]
    fn builtin_arity_table_is_wired_up() {
        assert_eq!(builtins::function_arity("sin"), Some(1));
        assert_eq!(builtins::function_arity("sqrt"), Some(1));
        assert_eq!(builtins::function_arity("nope"), None);
        assert!(builtins::check_function_arity("cos", 1).is_ok());
        assert!(builtins::check_function_arity("cos", 2).is_err());
    }

    /// 多字母标识符是单个符号,`1e` 是 1 * e(202609 审查 SYM-P3.1).
    #[test]
    fn multi_letter_identifiers_are_single_symbols() {
        assert_eq!(normalize_expression("2xy").unwrap(), "2 * xy");
        assert_eq!(normalize_expression("x2").unwrap(), "x2");
        assert_eq!(normalize_expression("sinx").unwrap(), "sinx");
        assert_eq!(normalize_expression("x_1").unwrap(), "x_1");
        assert_eq!(normalize_expression("1e").unwrap(), "1 * 2.718281828459045");
        assert_eq!(normalize_expression("1.2.3").unwrap(), "1.2 * 0.3");
        assert_eq!(normalize_expression("1e-20").unwrap(), "1e-20");
    }

    /// 裸函数名是自由符号,不是被静默吞掉的"内建"(202609 审查 SYM-P3.2).
    #[test]
    fn bare_builtin_names_are_reported_as_free_symbols() {
        // 带数值的常量不是自由变量.
        assert!(symbolic_variables("pi + e", &[]).unwrap().is_empty());
        assert!(symbolic_variables("Infinity", &[]).unwrap().is_empty());
        // 裸函数名/别名名求值时会报"变量未定义",必须报出来.
        assert_eq!(symbolic_variables("sin", &[]).unwrap(), vec!["sin"]);
        assert_eq!(symbolic_variables("deg", &[]).unwrap(), vec!["deg"]);
        // 同名常量仍按常量处理:`i` 是登记过的保留字,不是自由变量.
        assert!(symbolic_variables("i", &[]).unwrap().is_empty());
        // 真正的调用仍然只报参数里的自由变量.
        assert_eq!(symbolic_variables("sin(x)", &[]).unwrap(), vec!["x"]);
    }

    /// 矩阵是结构参数:非有限条目必须报错(202609 审查 SYM-P2.2).
    #[test]
    fn matrix_rejects_non_finite_entries() {
        let infinite = "[[1/0,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]";
        let error = matrix4_from_expr(infinite).unwrap_err();
        assert!(
            error.contains("第 1 行第 1 列"),
            "错误信息应带行列下标: {error}"
        );
        let nan = "[[0,0,0,0],[0,0/0,0,0],[0,0,1,0],[0,0,0,1]]";
        let error = matrix4_from_expr(nan).unwrap_err();
        assert!(
            error.contains("第 2 行第 2 列"),
            "错误信息应带行列下标: {error}"
        );
    }

    #[test]
    fn shared_printer_keeps_necessary_parentheses_once() {
        assert_eq!(normalize_expression("2 * (a + b)").unwrap(), "2 * (a + b)");
        assert_eq!(normalize_expression("a - (b - c)").unwrap(), "a - (b - c)");
        assert_eq!(normalize_expression("(a + b) / c").unwrap(), "(a + b) / c");
        assert_eq!(normalize_expression("x ^ (y ^ z)").unwrap(), "x ^ (y ^ z)");
    }

    #[test]
    fn differentiates_common_expressions() {
        assert_eq!(symbolic_derivative("x^2", "x").unwrap(), "2 * x");
        assert_eq!(
            symbolic_derivative("pi*x", "x").unwrap(),
            "3.141592653589793"
        );
        assert_eq!(
            symbolic_derivative("sin(x*a)", "x").unwrap(),
            "a * cos(x * a)"
        );
        assert_eq!(
            symbolic_derivative("sin(x)*cos(y)", "x").unwrap(),
            "cos(y) * cos(x)"
        );
        assert_eq!(
            symbolic_derivative("sin(x)*cos(y)", "y").unwrap(),
            "-(sin(x) * sin(y))"
        );
    }

    /// 202609 审查 SYM-P1.1 系列:|x| 的符号导数输出 sign 语义,而不是
    /// 0/0 形态的 |x|/x(数值侧 sign(0) 显式 NaN,见 `builtins.rs`).
    #[test]
    fn derivative_of_abs_uses_sign_semantics() {
        assert_eq!(symbolic_derivative("abs(x)", "x").unwrap(), "sign(x)");
        assert_eq!(
            symbolic_derivative("abs(sin(x))", "x").unwrap(),
            "cos(x) * sign(sin(x))"
        );
        // cbrt 是登记过的一元函数,可求导.
        assert_eq!(
            symbolic_derivative("cbrt(x)", "x").unwrap(),
            "1 / (3 * cbrt(x) ^ 2)"
        );
    }

    #[test]
    fn extracts_free_symbols() {
        let mut vars = symbolic_variables("sin(a * x) + b^2", &["x".to_string()]).unwrap();
        vars.sort();
        assert_eq!(vars, vec!["a", "b"]);
    }

    #[test]
    fn renders_latex_expressions() {
        assert_eq!(
            latex_expression("sin(x * a) * cos(x * b)").unwrap(),
            "\\sin\\left(x\\,a\\right)\\,\\cos\\left(x\\,b\\right)"
        );
        assert_eq!(latex_expression("2x").unwrap(), "2\\,x");
        assert_eq!(latex_expression("2 * (a + b)").unwrap(), "2\\,(a + b)");
        assert_eq!(latex_expression("pow(x, 2)").unwrap(), "x^{2}");
        assert_eq!(latex_expression("-(a + b)").unwrap(), "-(a + b)");
        assert_eq!(
            latex_expression("sqrt(x^2 + y^2)").unwrap(),
            "\\sqrt{x^{2} + y^{2}}"
        );
        assert_eq!(latex_expression("cbrt(x)").unwrap(), "\\sqrt[3]{x}");
        assert_eq!(
            latex_expression("sign(x)").unwrap(),
            "\\operatorname{sgn}\\left(x\\right)"
        );
    }

    #[test]
    fn renders_latex_constants_symbolically() {
        assert_eq!(latex_expression("pi / 4").unwrap(), "\\frac{\\pi}{4}");
        // normalize_expression 会把 pi 展开成浮点数;LaTeX 打印器按精确值
        // 还原成 \pi,避免 UI 公式出现一长串小数.
        assert_eq!(
            latex_expression("3.141592653589793 / 4").unwrap(),
            "\\frac{\\pi}{4}"
        );
        assert_eq!(
            latex_expression("log10(x) + theta").unwrap(),
            "\\log_{10}\\left(x\\right) + \\theta"
        );
    }

    #[test]
    fn parses_nested_arrays() {
        assert_eq!(
            parse_array_strings("[x, [y, z]]").unwrap(),
            "[\"x\", [\"y\", \"z\"]]"
        );
        assert_eq!(parse_array_strings("[x, y,]").unwrap(), "[\"x\", \"y\"]");
    }

    #[test]
    fn evaluates_matrix_literals() {
        let identity =
            matrix4_from_expr("matrix([[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]])").unwrap();
        assert_eq!(
            identity,
            vec![1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]
        );
        let trailing_comma =
            matrix4_from_expr("[[1, 0, 0, 2], [0, 1, 0, 3], [0, 0, 1, 4], [0, 0, 0, 1],]").unwrap();
        assert_eq!(
            trailing_comma,
            vec![1.0, 0.0, 0.0, 2.0, 0.0, 1.0, 0.0, 3.0, 0.0, 0.0, 1.0, 4.0, 0.0, 0.0, 0.0, 1.0]
        );
    }

    /// 数字因子合并不随书写顺序漂移(202609 审查前 x*2*3 输出 3*(2*x)).
    #[test]
    fn simplify_merges_numeric_factors_regardless_of_position() {
        assert_eq!(symbolic_derivative("x * 2 * 3", "x").unwrap(), "6");
        assert_eq!(symbolic_derivative("2 * 3 * x", "x").unwrap(), "6");
    }

    /// 打印器必须给幂底数补括号:`(x^2)^3` 与 `x^(2^3)` 值不同(202609).
    ///
    /// 修复前 Text 模式只给幂的**右侧**同级子树补括号,`(x^4)^2` 打成
    /// `x ^ 4 ^ 2`,回读(右结合)后从 x^8 变成 x^16,`7/x^4` 的导数被静默算错.
    #[test]
    fn printer_parenthesizes_power_base() {
        fn evaluate(source: &str) -> Option<f64> {
            let node = compile_runtime_expr(source).unwrap();
            evaluate_runtime_expr(&node, &std::collections::HashMap::new()).unwrap()
        }
        assert_eq!(normalize_expression("(x ^ 2) ^ 3").unwrap(), "(x ^ 2) ^ 3");
        assert_eq!(normalize_expression("x ^ (2 ^ 3)").unwrap(), "x ^ (2 ^ 3)");
        // 回读语义:((2)^2)^3 = 64,而不是 2^(2^3) = 256.
        assert_eq!(
            evaluate(&normalize_expression("(2 ^ 2) ^ 3").unwrap()),
            Some(64.0)
        );
        assert_eq!(
            evaluate(&normalize_expression("2 ^ 2 ^ 3").unwrap()),
            Some(256.0)
        );
        assert_eq!(latex_expression("(x^2)^3").unwrap(), "(x^{2})^{3}");
    }

    /// 求导结果收敛成可读的一行(202609):数字系数并进分子,同底数幂相除,
    /// 负号提到运算符上.这是修复 `x^{4^{2}}` 打印 bug 后真正正确的化简结果
    /// (d/dx 7/x^4 = -28/x^5,d/dx 2/x = -2/x^2).
    #[test]
    fn derivative_simplifies_quotient_powers_and_signs() {
        assert_eq!(
            symbolic_derivative("x^3 + 7/x^4 - 2/x", "x").unwrap(),
            "3 * x ^ 2 - 28 / x ^ 5 + 2 / x ^ 2"
        );
        // 同底数幂相乘同样要合并,否则嵌套幂的导数会留下 `x^3 * x^4`.
        assert_eq!(
            symbolic_derivative("7/(x^4)^2", "x").unwrap(),
            "-56 / x ^ 9"
        );
    }

    /// 教科书例题[2-2.2.1]:`d/dx (x^3 + 7/x^4 - 2/x + 12) = 3x^2 - 28/x^5 + 2/x^2`.
    ///
    /// 两个都要守住:常数项 12 的导数折成 0 后不能在结果里留下尾部 `+ 0`,
    /// 商法则留下的分数要收成同底数幂相除.
    #[test]
    fn derivative_of_textbook_example() {
        assert_eq!(
            symbolic_derivative("x^3+7/x^4-2/x+12", "x").unwrap(),
            "3 * x ^ 2 - 28 / x ^ 5 + 2 / x ^ 2"
        );
        assert_eq!(
            latex_expression(&symbolic_derivative("x^3+7/x^4-2/x+12", "x").unwrap()).unwrap(),
            "3\\,x^{2} - \\frac{28}{x^{5}} + \\frac{2}{x^{2}}"
        );
    }

    /// 递归下降解析器的深度护栏:超深括号链报错而不是栈溢出.
    #[test]
    fn deeply_nested_expression_is_rejected_not_stack_overflow() {
        let deep = format!("{}x{}", "(".repeat(600), ")".repeat(600));
        let error = normalize_expression(&deep).unwrap_err();
        assert!(error.contains("嵌套"), "护栏报错应可读: {error}");
    }
}
