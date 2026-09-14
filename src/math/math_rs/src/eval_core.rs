//! 表达式求值的共享运行时:编译缓存 + 系数上下文 + CompiledEvaluator.
//!
//! 行为契约:
//! - 表达式只按字符串编译一次(EXPR_CACHE,256 上限,Rc 共享),系数/坐标
//!   永不进缓存键;改系数/坐标只重建 context 或覆写坐标槽;
//! - **符号在构造期解析成槽位**(`symbolic::eval::SymBinding`),求值期零
//!   字符串,零哈希,零分配.202609 性能改造 P0 之前是每点
//!   `HashMap<String, f64>` + `name.to_string()`,实测 context 记账占求值成本
//!   94-99%(微基准表见 docs/wasm-boundary-cost.md §三);
//! - 系数名与保留符号的约定:见 [`build_coefficients`]--"x" 与带数值的
//!   内置常量名一律拒绝;y/z 仅在被 eval_2d/eval_at 覆写时才是冲突,调用
//!   方负责按维度给出与坐标集不相交的系数表(TS 侧 WORLD_VARIABLES 镜像);
//! - 求值结果语义:有限值 -> Ok(Some);非有限 -> Ok(None)(掩码语义,由
//!   消费方决定跳过/置零/报错);解析与未绑定变量 -> Err;
//! - 编码注意:坐标槽按**本次调用维度**覆写(eval_1d 只覆写 x,eval_2d 覆写
//!   x/y,eval_at 覆写 x/y/z);y/z 作系数名时正是靠这个维度位决定读坐标还是
//!   读系数,不要改成"构造期猜维度"的静态绑定(同一个 evaluator 混用维度会
//!   立刻偏离旧语义);不要手动实现"编译 + 建表 + 覆写坐标"的循环,
//!   直接建 CompiledEvaluator.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::builtins;
use crate::symbolic::{
    bind_expression, compile_runtime_expr, evaluate_bound, BoundExpr, EvalContext, RuntimeExpr,
};

/// 构建系数槽表.
///
/// 与旧的 `build_base_context` 同口径,只是不再建 `HashMap`:
/// - 系数名冲突防护:x 在任何采样维度都会被坐标覆写,数值常量在求值
///   时优先于变量,两者都是"静默失效",报错优于猜对.y/z 不在此列:
///   它们在 1D(interval/curve)与 2D(rectangle)语境是合法参数名,
///   只有被 eval_2d/eval_at 覆写时才冲突(调用方建表 bug,见文件头契约).
/// - 只校验 `names.iter().zip(values.iter())` 覆盖到的名字,与旧实现一致;
///   多出来的名字/值被忽略(截断到公共长度),同名系数以最后一个为准.
pub(crate) fn build_coefficients(
    coeff_names: &[String],
    coeff_values: &[f64],
) -> Result<Vec<f64>, String> {
    let paired = coeff_names.len().min(coeff_values.len());
    for name in coeff_names.iter().take(paired) {
        if name == "x" || builtins::constant_value(name).is_some() {
            return Err(format!(
                "系数名 '{name}' 与保留符号(采样坐标 x 或内置常量)冲突,请更换参数名"
            ));
        }
    }
    Ok(coeff_values[..paired].to_vec())
}

/// 编译树缓存:表达式字符串 -> 已编译求值树.
///
/// 场分析(gradient/divergence/curl 的逐点入口)与 `evaluate_scalar` 高频按
/// 同一批表达式反复调用 `CompiledEvaluator::new`;解析(词法/语法/别名重写)
/// 是其中最大开销,这里按字符串缓存编译产物(只读,`Rc` 共享),
/// 每次调用只剩"绑定槽位 + 求值".系数/坐标不参与缓存键,它们走 context.
const EXPR_CACHE_CAP: usize = 256;

thread_local! {
    static EXPR_CACHE: RefCell<HashMap<String, Rc<RuntimeExpr>>> = RefCell::new(HashMap::new());
}

/// 把表达式字符串编译为符号引擎的求值树(带编译缓存).
pub(crate) fn compile_expression(expr: &str) -> Result<Rc<RuntimeExpr>, String> {
    if let Some(cached) = EXPR_CACHE.with(|cache| cache.borrow().get(expr).cloned()) {
        return Ok(cached);
    }
    let node = Rc::new(compile_runtime_expr(expr).map_err(|e| format!("表达式解析失败: {}", e))?);
    EXPR_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= EXPR_CACHE_CAP {
            cache.clear();
        }
        cache.insert(expr.to_string(), node.clone());
    });
    Ok(node)
}

/// 已编译表达式 + 可复用求值上下文.
///
/// 采样/求交/场分析都要做大量逐点求值;把它们各自的"compile + 绑定槽位
/// + 每次写入坐标"收口到这里,避免每个调用点重复这套初始化逻辑.
///
/// `node` 是构造期解析好的槽位树(见 `symbolic::eval::bind_expression`):
/// 求值期既不碰字符串也不查哈希,所有名字都已经变成数组下标.
pub(crate) struct CompiledEvaluator {
    node: BoundExpr,
    context: EvalContext,
}

impl CompiledEvaluator {
    pub(crate) fn new(
        expr: &str,
        coeff_names: &[String],
        coeff_values: &[f64],
    ) -> Result<Self, String> {
        let compiled = compile_expression(expr)?;
        let coefficients = build_coefficients(coeff_names, coeff_values)?;
        // 绑定只看"哪些名字是系数",取值走 context;所以配对长度必须与
        // `coefficients` 一致,否则 `SymBinding::Coefficient(i)` 会越界.
        let paired = coefficients.len();
        let node = bind_expression(&compiled, &coeff_names[..paired]);
        let context = EvalContext {
            x: f64::NAN,
            y: f64::NAN,
            z: f64::NAN,
            // 构造后,首次求值前不应读到坐标槽;0 表示"没有坐标被覆写".
            dim: 0,
            coefficients,
        };
        Ok(Self { node, context })
    }

    /// 在给定三维坐标处求值;不参与该表达式的坐标传 NaN 即可.
    pub(crate) fn eval_at(&mut self, x: f64, y: f64, z: f64) -> Result<Option<f64>, String> {
        self.context.x = x;
        self.context.y = y;
        self.context.z = z;
        self.context.dim = 3;
        evaluate_bound(&self.node, &self.context)
    }

    /// 一元函数求值: y = f(x).
    pub(crate) fn eval_1d(&mut self, x: f64) -> Result<Option<f64>, String> {
        self.context.x = x;
        self.context.dim = 1;
        evaluate_bound(&self.node, &self.context)
    }

    /// 二元函数求值: z = f(x, y).
    pub(crate) fn eval_2d(&mut self, x: f64, y: f64) -> Result<Option<f64>, String> {
        self.context.x = x;
        self.context.y = y;
        self.context.dim = 2;
        evaluate_bound(&self.node, &self.context)
    }

    /// 在给定坐标处严格求值:非有限结果同样视为错误.
    pub(crate) fn eval_at_strict(&mut self, x: f64, y: f64, z: f64) -> Result<f64, String> {
        match self.eval_at(x, y, z)? {
            Some(value) => Ok(value),
            None => Err("表达式结果为非有限数值".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::{E, PI};

    fn coeff(values: &[f64]) -> (Vec<String>, Vec<f64>) {
        (
            (0..values.len()).map(|index| format!("a{index}")).collect(),
            values.to_vec(),
        )
    }

    #[test]
    fn evaluates_coefficients_coordinates_and_builtins() {
        let (names, values) = coeff(&[PI / 6.0]);
        let mut evaluator =
            CompiledEvaluator::new("sin(a0 * x) + sqrt(4)", &names, &values).unwrap();

        let result = evaluator.eval_at(1.0, f64::NAN, f64::NAN).unwrap().unwrap();
        assert!((result - 2.5).abs() < 1e-12);
    }

    #[test]
    fn rewrites_aliases_before_runtime_evaluation() {
        let mut evaluator = CompiledEvaluator::new("log(x) + pow(x, 2)", &[], &[]).unwrap();
        let result = evaluator.eval_1d(std::f64::consts::E).unwrap().unwrap();
        assert!((result - 1.0 - E * E).abs() < 1e-12);
    }

    #[test]
    fn nonfinite_results_are_none_instead_of_errors() {
        let mut evaluator = CompiledEvaluator::new("1 / (x - 1)", &[], &[]).unwrap();
        assert!(evaluator.eval_1d(1.0).unwrap().is_none());
    }

    #[test]
    fn missing_variables_report_errors() {
        let mut evaluator = CompiledEvaluator::new("x + y", &[], &[]).unwrap();
        assert!(evaluator.eval_1d(1.0).is_err());
    }

    #[test]
    fn negative_base_rational_power_and_cbrt_evaluate_to_real_values() {
        // 202609 审查 SYM-P1.1 条目来源:负底 + 奇数分母有理指数给出实值,
        // 不再是静默 NaN(归一化串必须能 round-trip 才守得住这条).
        let mut evaluator = CompiledEvaluator::new("pow(x, 1 / 3)", &[], &[]).unwrap();
        let value = evaluator.eval_1d(-8.0).unwrap().unwrap();
        assert!((value - -2.0).abs() < 1e-12, "(-8)^(1/3) = {value}");

        let mut evaluator = CompiledEvaluator::new("cbrt(x)", &[], &[]).unwrap();
        let value = evaluator.eval_1d(-27.0).unwrap().unwrap();
        assert!((value - -3.0).abs() < 1e-12, "cbrt(-27) = {value}");

        // 偶数分母(平方根)依旧无实值 -> Ok(None),与既有一致.
        let mut evaluator = CompiledEvaluator::new("pow(x, 0.5)", &[], &[]).unwrap();
        assert!(evaluator.eval_1d(-4.0).unwrap().is_none());
    }

    #[test]
    fn sign_is_explicit_nan_at_zero_not_ieee_accident() {
        // 202609 审查 SYM-P1.1 条目来源:sign(u) = u/|u|;0 处显式 NaN
        // (而非 0/0 的 IEEE 撞大运).
        let mut evaluator = CompiledEvaluator::new("sign(x)", &[], &[]).unwrap();
        assert_eq!(evaluator.eval_1d(2.0).unwrap(), Some(1.0));
        assert_eq!(evaluator.eval_1d(-2.0).unwrap(), Some(-1.0));
        assert!(evaluator.eval_1d(0.0).unwrap().is_none());

        // |x| 的导数 = sign(x),同样在 0 处显式无定义.
        let mut evaluator = CompiledEvaluator::new("sign(x)", &[], &[]).unwrap();
        assert!(evaluator.eval_1d(0.0).unwrap().is_none());
    }

    #[test]
    fn coefficients_named_x_or_constants_are_rejected() {
        // x 在任何采样维度都会被坐标覆写(静默失效),常量在求值时优先于
        // 变量--两者都以明确报错代替猜对.
        let values = vec![2.0];
        let error = match CompiledEvaluator::new("a * x", &["x".to_string()], &values) {
            Err(e) => e,
            Ok(_) => panic!("x 系数应被拒绝"),
        };
        assert!(error.contains("x"), "错误应点名冲突的系数: {error}");

        for constant in ["e", "pi", "Infinity"] {
            let names = vec![constant.to_string()];
            let error = match CompiledEvaluator::new("a * x", &names, &values) {
                Err(e) => e,
                Ok(_) => panic!("{constant} 系数应被拒绝"),
            };
            assert!(error.contains(constant), "{constant} 应被拒绝: {error}");
        }
    }

    #[test]
    fn coefficients_named_y_or_z_are_allowed_in_1d_context() {
        // y/z 在 1D(interval/curve)语境是合法参数名,不被 eval_1d 覆写;
        // 只有把它们送进会覆写 y/z 的 2D/3D 采样才是调用方 bug(见头契约).
        let names = vec!["y".to_string(), "z".to_string()];
        let values = vec![2.0, 3.0];
        let mut evaluator = CompiledEvaluator::new("y * x + z", &names, &values).unwrap();
        assert_eq!(evaluator.eval_1d(0.0).unwrap(), Some(3.0));
        assert_eq!(evaluator.eval_1d(1.0).unwrap(), Some(5.0));
    }

    // ============================================================
    // 旧 -> 新 逐点对拍(语义等价的唯一证明方式)
    // ============================================================

    /// 求值维度;决定哪些坐标槽被覆写.
    #[derive(Debug, Clone, Copy)]
    enum Mode {
        OneD,
        TwoD,
        ThreeD,
    }

    /// 旧实现(查表版)的一次求值:重建 HashMap 上下文 -> 覆写坐标 -> 求值.
    ///
    /// 与改造前的 `CompiledEvaluator` 完全同构:`compile_expression` 之后
    /// `HashMap<String, f64>` + `set_variable` + `evaluate_runtime_expr`.
    fn legacy_eval(
        expr: &str,
        coeff_names: &[String],
        coeff_values: &[f64],
        mode: Mode,
        x: f64,
        y: f64,
        z: f64,
    ) -> Result<Option<f64>, String> {
        let node = compile_expression(expr)?;
        let mut context = HashMap::new();
        for (name, value) in coeff_names.iter().zip(coeff_values.iter()) {
            if name == "x" || builtins::constant_value(name).is_some() {
                return Err(format!(
                    "系数名 '{name}' 与保留符号(采样坐标 x 或内置常量)冲突,请更换参数名"
                ));
            }
            context.insert(name.clone(), *value);
        }
        match mode {
            Mode::OneD => {
                context.insert("x".to_string(), x);
            }
            Mode::TwoD => {
                context.insert("x".to_string(), x);
                context.insert("y".to_string(), y);
            }
            Mode::ThreeD => {
                context.insert("x".to_string(), x);
                context.insert("y".to_string(), y);
                context.insert("z".to_string(), z);
            }
        }
        crate::symbolic::evaluate_runtime_expr(&node, &context)
    }

    fn bound_eval(
        expr: &str,
        coeff_names: &[String],
        coeff_values: &[f64],
        mode: Mode,
        x: f64,
        y: f64,
        z: f64,
    ) -> Result<Option<f64>, String> {
        let mut evaluator = CompiledEvaluator::new(expr, coeff_names, coeff_values)?;
        match mode {
            Mode::OneD => evaluator.eval_1d(x),
            Mode::TwoD => evaluator.eval_2d(x, y),
            Mode::ThreeD => evaluator.eval_at(x, y, z),
        }
    }

    /// 结果按**位**比较:NaN==NaN 算相等,其余逐位相等.错误文案也要一致.
    #[track_caller]
    fn assert_same_result(
        context: &str,
        legacy: Result<Option<f64>, String>,
        bound: Result<Option<f64>, String>,
    ) {
        match (&legacy, &bound) {
            (Ok(Some(a)), Ok(Some(b))) => {
                assert_eq!(
                    a.to_bits(),
                    b.to_bits(),
                    "{context}: 数值不一致 legacy={a} bound={b}"
                );
            }
            (Ok(None), Ok(None)) => {}
            (Err(a), Err(b)) => {
                assert_eq!(a, b, "{context}: 错误文案不一致");
            }
            _ => panic!("{context}: 形态不一致 legacy={legacy:?} bound={bound:?}"),
        }
    }

    #[test]
    fn bound_and_lookup_paths_agree_pointwise() {
        let expressions = [
            "x",
            "x * y",
            "sin(x) * cos(y)",
            "(x^2 + y^2)^0.5 + sin(x)*cos(y)",
            "y",
            "z",
            "y * x + z",
            "a0 * x + b",
            "a0 + a1",
            "e",
            "pi * x",
            "x + 1e-20",
            "sqrt(x)",
            "1 / (x - 1)",
            "sign(x)",
            "pow(x, 1 / 3)",
            "log(x) + pow(x, 2)",
            "abs(x) + cbrt(x)",
            "missing + x",
            "y + z + x",
            "0 / x",
            "0 / 0",
            "x - x",
            "exp(x) / (1 + exp(x))",
        ];
        let coefficient_sets: &[(&[&str], &[f64])] = &[
            (&[], &[]),
            (&["a0", "b"], &[2.0, 3.0]),
            (&["a0", "a1"], &[PI / 6.0, -1.5]),
            (&["y", "z"], &[2.0, 3.0]),
            // 同名系数:旧 HashMap 覆盖语义 = 取最后一个.
            (&["a0", "a0"], &[1.0, 2.0]),
            // 名字比值多:多出来的名字不参与绑定.
            (&["a0", "orphan"], &[4.0]),
            // 值比名字多:多余的值被忽略.
            (&["a0"], &[4.0, 5.0]),
        ];
        let coordinates = [
            (0.0, 0.0, 0.0),
            (1.0, 2.0, 3.0),
            (-1.0, -2.0, -3.0),
            (-8.0, 0.5, 1e-9),
            (0.25, -0.75, 2.0),
            (1e16, -1e16, 1.0),
            (f64::NAN, 0.0, f64::INFINITY),
            (f64::INFINITY, f64::NEG_INFINITY, f64::NAN),
        ];
        let modes = [Mode::OneD, Mode::TwoD, Mode::ThreeD];

        let mut checked = 0usize;
        for expr in expressions {
            for (names, values) in coefficient_sets {
                let names: Vec<String> = names.iter().map(|name| (*name).to_string()).collect();
                // 冲突系数(会被 build_coefficients 拒绝)也要对齐错误文案.
                for mode in modes {
                    for (x, y, z) in coordinates {
                        let legacy = legacy_eval(expr, &names, values, mode, x, y, z);
                        let bound = bound_eval(expr, &names, values, mode, x, y, z);
                        assert_same_result(
                            &format!(
                                "expr={expr:?} coeffs={names:?} mode={mode:?} xyz=({x},{y},{z})"
                            ),
                            legacy,
                            bound,
                        );
                        checked += 1;
                    }
                }
            }
        }
        assert!(checked > 1000, "对拍样本太少: {checked}");
    }

    /// 系数名与坐标名冲突时,新旧一致报错(含错误文案).
    #[test]
    fn bound_path_rejects_conflicting_coefficient_names_like_before() {
        for name in ["x", "e", "pi", "Infinity", "NaN", "PI"] {
            let names = vec![name.to_string(), "a0".to_string()];
            let values = vec![1.0, 2.0];
            let legacy = legacy_eval("a0 * x", &names, &values, Mode::OneD, 1.0, 0.0, 0.0);
            let bound = bound_eval("a0 * x", &names, &values, Mode::OneD, 1.0, 0.0, 0.0);
            assert_same_result(name, legacy, bound);
            assert!(
                CompiledEvaluator::new("a0 * x", &names, &values).is_err(),
                "{name} 应被拒绝"
            );
        }
    }

    /// `y`/`z` 作系数:1D 读系数,2D 覆写 y(仍保留 z 系数),3D 两者都被覆写.
    #[test]
    fn y_and_z_coefficients_follow_the_current_dimension() {
        let names = vec!["y".to_string(), "z".to_string()];
        let values = vec![2.0, 3.0];

        let mut one_d = CompiledEvaluator::new("y + z", &names, &values).unwrap();
        assert_eq!(one_d.eval_1d(0.0).unwrap(), Some(5.0), "1D: y/z 都读系数");

        let mut two_d = CompiledEvaluator::new("y + z", &names, &values).unwrap();
        assert_eq!(
            two_d.eval_2d(0.0, 10.0).unwrap(),
            Some(13.0),
            "2D: y 是坐标, z 是系数"
        );

        let mut three_d = CompiledEvaluator::new("y + z", &names, &values).unwrap();
        assert_eq!(
            three_d.eval_at(0.0, 10.0, 100.0).unwrap(),
            Some(110.0),
            "3D: y/z 都是坐标"
        );
    }

    /// 编译缓存命中后语义不变:同一表达式重复构造,结果一致.
    #[test]
    fn compiled_cache_hits_keep_the_same_semantics() {
        let names = vec!["a0".to_string()];
        let values = vec![2.0];
        for _ in 0..3 {
            let mut evaluator = CompiledEvaluator::new("sin(a0 * x)", &names, &values).unwrap();
            assert!((evaluator.eval_1d(1.0).unwrap().unwrap() - (2.0f64).sin()).abs() < 1e-12);
        }
    }

    /// 性能冒烟(默认忽略,手动跑):
    /// `cargo test -p math_rs --release -- --ignored --nocapture`
    ///
    /// 打印槽位版 vs 查表版的 ns/点;P0 的收益是"每点省一次 String 分配 +
    /// 若干次字符串哈希",这条用来防止收益被无声回退.
    #[test]
    #[ignore = "性能冒烟,需手动 --ignored --nocapture 运行"]
    fn bound_eval_is_faster_than_lookup_perf_smoke() {
        let names = vec!["a0".to_string()];
        let values = vec![1.5];
        let source = "sin(a0 * x) * cos(x) + a0";
        let points: Vec<f64> = (0..65 * 65).map(|index| index as f64 * 1e-3).collect();

        let mut bound = CompiledEvaluator::new(source, &names, &values).unwrap();
        let start = std::time::Instant::now();
        let mut bound_sum = 0.0;
        for &x in &points {
            bound_sum += bound.eval_1d(x).unwrap().unwrap_or(0.0);
        }
        let bound_time = start.elapsed();

        // 查表版:context 只建一次,每点 insert 一次坐标(旧实现的口径).
        let node = compile_expression(source).unwrap();
        let mut context: HashMap<String, f64> =
            names.iter().cloned().zip(values.iter().copied()).collect();
        let start = std::time::Instant::now();
        let mut lookup_sum = 0.0;
        for &x in &points {
            context.insert("x".to_string(), x);
            lookup_sum += crate::symbolic::evaluate_runtime_expr(&node, &context)
                .unwrap()
                .unwrap_or(0.0);
        }
        let lookup_time = start.elapsed();

        let count = points.len() as f64;
        println!(
            "bound: {:>8.1} ns/point | lookup: {:>8.1} ns/point | speedup: {:.2}x (sums differ by {:.3e})",
            bound_time.as_nanos() as f64 / count,
            lookup_time.as_nanos() as f64 / count,
            lookup_time.as_secs_f64() / bound_time.as_secs_f64(),
            (bound_sum - lookup_sum).abs(),
        );
    }
}
