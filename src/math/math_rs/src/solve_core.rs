//! 约束求解的统一词汇与调度壳(为求解 / 求交 / 后续联立共用).
//!
//! ## 为什么要有这一层
//!
//! `symbolic::solve`(单变量多项式,精确,产出教学步骤)与
//! `intersection_core`(几何隐式场,采样数值,产出点集与交线)在算法上**不该**
//! 合并:一个要符号推导,一个要网格扫描.但它们服务的是同一件事--
//! **解一组约束**,只是"方程数 / 未知量数 / 方法"不同:
//! - 解方程:1 个约束,1 个未知量,精确;
//! - 求交:几何对象的隐式场约束,数值,解集可能是离散点或 1 维轨迹(交线);
//! - 联立(后续):N 个约束,M 个未知量,线性可精确消元,其余走数值.
//!
//! 所以这一层只统一**问题词汇**与**结果词汇**,不碰任何数值算法:
//! [`ConstraintProblem`] 描述"解什么",[`solve_problem`] 按 [`SolveMethod`]
//! 选后端,[`ConstraintOutcome`] 把两种后端的产物装进同一个类型.
//!
//! ## 刻意不统一的东西(WASM 线格式)
//!
//! 两个 wasm 导出的**线格式保持不变**:`solve_equation` 仍返回 `SolveOutcome`
//! 的 JSON,`intersect_pair` 仍返回扁平 `Vec<f64>`.它们各有消费方与性能特征
//! (JSON 字符串 vs 扁平数组),把它们并成一种线格式只会让两边都变差.这一层
//! 只在内核内部做映射,`lib.rs` 的皮负责把统一结果还原成原线格式.
//! 因此 [`ConstraintOutcome`] 的轨迹字段沿用 `intersection_core` 的扁平表示
//! (`curve_points` + `curve_offsets`),让求交路径的进出都是**零成本搬运**,
//! 不引入二次解码/再编码.

use crate::geometry_core::ObjectDescriptor;
use crate::intersection_core::{compute_pair, IntersectionCoreOutput};
use crate::symbolic::{
    solve_equation, solve_system, SolveOutcome, SolveStep, SystemMethod, SystemOutcome,
};

/// 求解方法:决定由哪个内核后端算这道约束题.
///
/// `Auto` 由调度壳按问题形状选择(方程 -> 精确,几何对象对 -> 数值);显式指定
/// 一个当前没有后端的组合会得到可读错误,而不是静默换路.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SolveMethod {
    /// 符号精确内核(`symbolic::solve`):多项式,产出教学步骤.
    Exact,
    /// 采样数值内核(`intersection_core`):几何隐式场,产出点集与轨迹.
    Numeric,
    /// 由调度壳按问题形状选择.
    Auto,
}

/// 问题的形状:当前已接的三种来源.
///
/// 新增一种约束语句时在这里加一个变体,调度壳与结果词汇都不需要改
/// (联立就是这么接进来的).
#[derive(Debug, Clone, Copy)]
pub enum ConstraintKind<'a> {
    /// 单个方程文本 `左边 = 右边`;`variable` 为 `None` 时由内核推断未知量.
    Equation {
        text: &'a str,
        variable: Option<&'a str>,
        coefficients: &'a [(String, f64)],
    },
    /// 联立方程组:多条方程共享一组未知量;线性走精确,非线性走数值.
    System {
        equations: &'a [String],
        /// `variables` 选项给的未知量;空表示从方程组推断.
        variables: &'a [String],
        coefficients: &'a [(String, f64)],
        /// 数值路径的搜索盒域(每个未知量一条区间);空表示用内核默认.
        domain: &'a [[f64; 2]],
        /// 数值路径的网格分段数;0 表示用内核默认.
        segments: usize,
    },
    /// 两个几何对象的交集:约束由对象隐式场给出,走数值后端.
    ObjectPair {
        a: &'a ObjectDescriptor,
        b: &'a ObjectDescriptor,
        segments: usize,
    },
}

/// 一道约束题:方法 + 问题形状.
#[derive(Debug, Clone, Copy)]
pub struct ConstraintProblem<'a> {
    pub method: SolveMethod,
    pub kind: ConstraintKind<'a>,
}

/// 统一的约束结果:符号解与数值解集同处一个类型.
///
/// 各后端各填自己那一半:
/// - 精确路径(`symbolic::solve` / `symbolic::system`)填 `problem_latex` /
///   `solution_latex` / `real_root_count` / `identity` / `steps`,点集与轨迹留空;
/// - 几何数值路径(`intersection_core`)填 `points` / `curve_points` /
///   `curve_offsets`,符号字段留空(轨迹是**采样折线**,不是精确解,
///   不伪造成 LaTeX);联立的数值路径只给近似解 LaTeX,不给坐标点集.
///
/// `error` 与两个既有内核同义:**能力边界理由是结果的一部分**,不是调用失败;
/// `Err` 只留给"输入读不出来"这类真正的错误.
#[derive(Debug, Clone, PartialEq)]
pub struct ConstraintOutcome {
    /// 实际使用的后端方法(由 `Auto` 解析后写回,便于调用方/测试对拍).
    pub method: SolveMethod,
    /// 未知量名;精确路径是求解变量,数值几何路径是坐标轴.
    pub unknowns: Vec<String>,
    /// 题目 LaTeX(原方程;数值几何路径留空).
    pub problem_latex: String,
    /// 解集 LaTeX;无解时为 `None`.
    ///
    /// 精确路径是精确解;联立的数值路径是 `\approx` 近似解(由 `method` 区分)
    /// --两者都是"解集的一种排版",所以共用一个字段而不是各立一个.
    pub solution_latex: Option<String>,
    /// 实数解个数(精确路径是根的个数;数值路径是离散解点个数).
    pub real_root_count: usize,
    /// 恒等式(任意实数都是解)标记;数值路径恒为 false.
    pub identity: bool,
    /// 离散解点,扁平 `[x, y, z, ...]`.
    pub points: Vec<f64>,
    /// 解轨迹 / 交线点,扁平 `[x, y, z, ...]`.
    pub curve_points: Vec<f64>,
    /// 每条轨迹在 `curve_points` 里的起始下标,末尾追加总长(见
    /// `IntersectionCoreOutput`;解码后长度不足两点的退化链由 TS 侧丢弃).
    pub curve_offsets: Vec<u32>,
    /// 推导步骤;数值路径一般为空.
    pub steps: Vec<SolveStep>,
    /// 能力边界理由;`None` 表示求解成功.
    pub error: Option<String>,
}

/// 把几何求交的坐标轴作为未知量:数值路径在世界坐标里求解.
fn axes_unknowns() -> Vec<String> {
    vec!["x".to_string(), "y".to_string(), "z".to_string()]
}

impl ConstraintOutcome {
    /// 精确内核产物 -> 统一结果.
    ///
    /// 与 [`Self::into_solve`] 互为逆映射:`SolveOutcome` 经这一对往返后逐字段
    /// 相等(有单测锁定),这样线格式的两侧都不会漂移.
    pub fn from_solve(outcome: SolveOutcome) -> Self {
        let unknowns = if outcome.variable.is_empty() {
            Vec::new()
        } else {
            vec![outcome.variable.clone()]
        };
        Self {
            method: SolveMethod::Exact,
            unknowns,
            problem_latex: outcome.equation_latex,
            solution_latex: outcome.solution_latex,
            real_root_count: outcome.real_root_count,
            identity: outcome.identity,
            points: Vec::new(),
            curve_points: Vec::new(),
            curve_offsets: Vec::new(),
            steps: outcome.steps,
            error: outcome.error_message,
        }
    }

    /// 统一结果 -> 精确内核产物(还原 `solve_equation` 的 JSON 线格式).
    pub fn into_solve(self) -> SolveOutcome {
        SolveOutcome {
            variable: self.unknowns.into_iter().next().unwrap_or_default(),
            equation_latex: self.problem_latex,
            solution_latex: self.solution_latex,
            real_root_count: self.real_root_count,
            identity: self.identity,
            steps: self.steps,
            error_message: self.error,
        }
    }

    /// 数值内核产物 -> 统一结果(纯搬运,零解码).
    pub fn from_intersection(output: IntersectionCoreOutput) -> Self {
        Self {
            method: SolveMethod::Numeric,
            unknowns: axes_unknowns(),
            problem_latex: String::new(),
            solution_latex: None,
            real_root_count: output.points.len() / 3,
            identity: false,
            points: output.points,
            curve_points: output.curve_points,
            curve_offsets: output.curve_offsets,
            steps: Vec::new(),
            error: None,
        }
    }

    /// 统一结果 -> 数值内核产物(还原 `intersect_pair` 的扁平线格式).
    pub fn into_intersection(self) -> IntersectionCoreOutput {
        IntersectionCoreOutput {
            points: self.points,
            curve_points: self.curve_points,
            curve_offsets: self.curve_offsets,
        }
    }

    /// 联立内核产物 -> 统一结果.
    ///
    /// 数值路径的 `solution_latex` 是 `\approx` 近似解,与精确解共用一个字段;
    /// `method` 负责把两者区分开(见字段文档).
    pub fn from_system(outcome: SystemOutcome) -> Self {
        let method = match outcome.method.as_str() {
            "numeric" => SolveMethod::Numeric,
            // 能力边界可能停在 auto(内核还没选定后端):如实保留.
            "auto" => SolveMethod::Auto,
            _ => SolveMethod::Exact,
        };
        Self {
            method,
            unknowns: outcome.variables,
            problem_latex: outcome.problem_latex,
            solution_latex: outcome.solution_latex,
            real_root_count: outcome.solution_count,
            identity: false,
            points: Vec::new(),
            curve_points: Vec::new(),
            curve_offsets: Vec::new(),
            steps: outcome.steps,
            error: outcome.error,
        }
    }

    /// 统一结果 -> 联立内核产物(还原 `solve_system` 的 JSON 线格式).
    pub fn into_system(self) -> SystemOutcome {
        SystemOutcome {
            variables: self.unknowns,
            problem_latex: self.problem_latex,
            solution_latex: self.solution_latex,
            solution_count: self.real_root_count,
            steps: self.steps,
            error: self.error,
            method: match self.method {
                SolveMethod::Numeric => "numeric".to_string(),
                SolveMethod::Auto => "auto".to_string(),
                SolveMethod::Exact => "exact".to_string(),
            },
        }
    }
}

/// 联立内核方法与统一方法的对应.
fn system_method(method: SolveMethod) -> SystemMethod {
    match method {
        SolveMethod::Exact => SystemMethod::Exact,
        SolveMethod::Numeric => SystemMethod::Numeric,
        SolveMethod::Auto => SystemMethod::Auto,
    }
}

/// 解一道约束题:按方法选后端,把产物收进统一结果.
///
/// `Auto` 的分派规则(当前):
/// - 方程 -> [`SolveMethod::Exact`];
/// - 方程组 -> 精确优先,非线性自动落到数值(由 `symbolic::system` 内部决定);
/// - 几何对象对 -> [`SolveMethod::Numeric`].
///
/// 显式指定了没有后端的组合(方程走数值 / 对象对走精确)返回 `Err`:这是**调用
/// 方的用法错误**,不是"这道题超纲",所以不走 `error` 字段.
pub fn solve_problem(problem: ConstraintProblem<'_>) -> Result<ConstraintOutcome, String> {
    match (problem.kind, problem.method) {
        (
            ConstraintKind::Equation {
                text,
                variable,
                coefficients,
            },
            SolveMethod::Auto | SolveMethod::Exact,
        ) => solve_equation(text, variable, coefficients).map(ConstraintOutcome::from_solve),
        (
            ConstraintKind::System {
                equations,
                variables,
                coefficients,
                domain,
                segments,
            },
            method @ (SolveMethod::Auto | SolveMethod::Exact | SolveMethod::Numeric),
        ) => solve_system(
            equations,
            Some(variables),
            coefficients,
            system_method(method),
            domain,
            segments,
        )
        .map(ConstraintOutcome::from_system),
        (
            ConstraintKind::ObjectPair { a, b, segments },
            SolveMethod::Auto | SolveMethod::Numeric,
        ) => compute_pair(a, b, segments).map(ConstraintOutcome::from_intersection),
        (ConstraintKind::Equation { .. }, SolveMethod::Numeric) => {
            Err("单方程的数值后端尚未接入:请使用 method = exact 或 auto".to_string())
        }
        (ConstraintKind::ObjectPair { .. }, SolveMethod::Exact) => {
            Err("几何求交没有精确符号后端:请使用 method = numeric 或 auto".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry_core::parse_object_descriptor;

    /// 与 `intersection_core::test_support` 同口径:无静态变换用空矩阵,
    /// 平面曲线因此走 planar 路径(不做空间最近点细化).
    fn descriptor(kind: &str, expr: &str, params: Vec<f64>) -> ObjectDescriptor {
        parse_object_descriptor(kind, expr, vec![], vec![], params, vec![], vec![])
            .expect("描述符应当可解析")
    }

    fn curve(expr: &str, range: [f64; 2]) -> ObjectDescriptor {
        descriptor("curve", expr, range.to_vec())
    }

    fn equation_problem<'a>(
        text: &'a str,
        variable: Option<&'a str>,
        coefficients: &'a [(String, f64)],
    ) -> ConstraintProblem<'a> {
        ConstraintProblem {
            method: SolveMethod::Auto,
            kind: ConstraintKind::Equation {
                text,
                variable,
                coefficients,
            },
        }
    }

    /// 调度壳必须是无损的:精确内核产物经统一结果往返后逐字段相等.
    #[test]
    fn solve_round_trip_is_lossless() {
        // 覆盖四条路径:因式分解,参数系数,能力边界(三次),恒等式.
        for text in ["x^2 - 5*x + 6 = 0", "a*x^2 - 2 = 0", "x^3 - 1 = 0", "0 = 0"] {
            let coefficients = [("a".to_string(), 1.0)];
            let original = solve_equation(text, Some("x"), &coefficients).expect("应当能解析");
            let round_tripped = ConstraintOutcome::from_solve(original.clone()).into_solve();
            assert_eq!(round_tripped, original, "往返丢信息: {text}");
        }
    }

    /// `Auto` 对方程解析为精确后端,并且确实走通了内核.
    #[test]
    fn auto_resolves_equation_to_exact_backend() {
        let outcome =
            solve_problem(equation_problem("x^2 - 5*x + 6 = 0", None, &[])).expect("方程应当可解");

        assert_eq!(outcome.method, SolveMethod::Exact);
        assert_eq!(outcome.unknowns, vec!["x".to_string()]);
        assert!(
            outcome.problem_latex.contains("x^{2}"),
            "题目 LaTeX 应保留: {}",
            outcome.problem_latex
        );
        assert_eq!(outcome.real_root_count, 2);
        assert!(outcome.solution_latex.is_some());
        assert!(!outcome.steps.is_empty());
        assert!(outcome.points.is_empty(), "精确路径不产出数值点集");
        assert!(outcome.error.is_none());
    }

    /// 能力边界仍是**结果**:三次方程不抛错,理由落在 `error`.
    #[test]
    fn capacity_limits_stay_in_the_outcome() {
        let outcome =
            solve_problem(equation_problem("x^3 - 1 = 0", None, &[])).expect("能力边界不抛错");
        assert!(outcome.error.is_some());
        assert!(outcome.solution_latex.is_none());
        assert!(outcome.steps.is_empty());
    }

    /// 调度壳对数值几何路径同样无损,并且 `Auto` 解析为数值后端.
    #[test]
    fn intersection_round_trip_is_lossless_and_auto_is_numeric() {
        let a = curve("x", [-2.0, 2.0]);
        let b = curve("-x + 2", [-2.0, 2.0]);
        let problem = ConstraintProblem {
            method: SolveMethod::Auto,
            kind: ConstraintKind::ObjectPair {
                a: &a,
                b: &b,
                segments: 64,
            },
        };

        let original = compute_pair(&a, &b, 64).expect("两条直线应当相交");
        let outcome = solve_problem(problem).expect("应当可算");

        assert_eq!(outcome.method, SolveMethod::Numeric);
        assert_eq!(outcome.unknowns, vec!["x", "y", "z"]);
        assert_eq!(outcome.real_root_count, 1);
        assert!(outcome.problem_latex.is_empty(), "数值路径不给题目 LaTeX");
        assert!(outcome.steps.is_empty(), "数值路径不给推导步骤");
        assert_eq!(outcome.into_intersection(), original, "往返丢信息");
    }

    /// 面片交线(轨迹)也要零成本往返:扁平点列与 offsets 逐元素相等.
    #[test]
    fn intersection_contours_round_trip_is_lossless() {
        let sphere = descriptor("sphere", "", vec![0.0, 0.0, 0.0, 1.5]);
        let surface = descriptor("surface", "0", vec![-1.5, 1.5, -1.5, 1.5]);

        let original = compute_pair(&sphere, &surface, 32).expect("应当有交线");
        assert!(!original.curve_offsets.is_empty());
        let outcome = ConstraintOutcome::from_intersection(original.clone());
        assert_eq!(outcome.into_intersection(), original, "往返丢信息");
    }

    /// 显式指定了没有后端的组合:报用法错误,不静默换路.
    #[test]
    fn unsupported_method_combination_is_a_usage_error() {
        let numeric = ConstraintProblem {
            method: SolveMethod::Numeric,
            kind: ConstraintKind::Equation {
                text: "x^2 - 1 = 0",
                variable: None,
                coefficients: &[],
            },
        };
        let message = solve_problem(numeric).unwrap_err();
        assert!(message.contains("数值后端尚未接入"), "{message}");

        let a = curve("x", [-2.0, 2.0]);
        let b = curve("-x + 2", [-2.0, 2.0]);
        let exact = ConstraintProblem {
            method: SolveMethod::Exact,
            kind: ConstraintKind::ObjectPair {
                a: &a,
                b: &b,
                segments: 64,
            },
        };
        let message = solve_problem(exact).unwrap_err();
        assert!(message.contains("没有精确符号后端"), "{message}");
    }

    /// 输入读不出来仍走 `Err`(与既有内核口径一致),不混进 `error` 字段.
    #[test]
    fn unreadable_equation_stays_an_err() {
        let message = solve_problem(equation_problem("x + 1", None, &[])).unwrap_err();
        assert!(message.contains("缺少等号"), "{message}");
    }
    /// 联立方程组的调度与往返:`Auto` 走精确后端,统一结果无损.
    #[test]
    fn system_dispatch_and_round_trip_are_lossless() {
        let equations = vec!["x + y = 3".to_string(), "x - y = 1".to_string()];
        let original =
            solve_system(&equations, None, &[], SystemMethod::Auto, &[], 0).expect("应当可解");

        let problem = ConstraintProblem {
            method: SolveMethod::Auto,
            kind: ConstraintKind::System {
                equations: &equations,
                variables: &[],
                coefficients: &[],
                domain: &[],
                segments: 0,
            },
        };
        let outcome = solve_problem(problem).expect("应当可解");

        assert_eq!(outcome.method, SolveMethod::Exact);
        assert_eq!(outcome.unknowns, vec!["x", "y"]);
        assert!(outcome
            .solution_latex
            .as_deref()
            .unwrap_or("")
            .contains("x = 2"));
        assert_eq!(
            ConstraintOutcome::from_system(original.clone()).into_system(),
            original,
            "往返丢信息"
        );
    }

    /// 非线性方程组在 `Auto` 下落进数值后端(`method` 如实标注).
    #[test]
    fn system_auto_falls_back_to_numeric_backend() {
        let equations = vec!["x^2 + y^2 = 1".to_string(), "x - y = 0".to_string()];
        let domain = [[-2.0, 2.0], [-2.0, 2.0]];
        let problem = ConstraintProblem {
            method: SolveMethod::Auto,
            kind: ConstraintKind::System {
                equations: &equations,
                variables: &[],
                coefficients: &[],
                domain: &domain,
                segments: 16,
            },
        };

        let outcome = solve_problem(problem).expect("应当可算");

        assert_eq!(outcome.method, SolveMethod::Numeric);
        assert_eq!(outcome.real_root_count, 2);
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
    }
}
