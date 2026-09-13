//! math_rs 的 wasm-bindgen 门面(lib crate 根).
//!
//! 职责与约定:
//! - 每个 wasm 导出都只是"解包参数 -> 调 core 模块 -> 包结果/错误"的薄层,
//!   数值语义一律在 core(integral_core/sampling_core/domain_integral/
//!   geometry_core/intersection_core/...)里定义并可在 `cargo test` 纯
//!   Rust 验证;
//! - 几何对象模型与隐式场在 geometry_core(求交与体积积分共享),求交算法在
//!   intersection_core,带域积分在 domain_integral:域积分特性只依赖几何,
//!   不依赖求交实现(依赖方向见 geometry_core 文件头);
//! - 复杂入口走 JSON payload(wasm_payloads.rs),签名保持 `(payload: &str)`,
//!   新增字段只动"结构体 + TS 构造处",不要退回 20 个扁平参数的旧风格;
//! - 掩码语义,规模护栏(n/m/layers/segments 上限)由 core 模块统一执行,
//!   这里不重复校验(除非要先报错再分配);
//! - 本文件尾部 `glue_tests` 覆盖"方法字符串 -> 采样形状 -> 消费核"的 wasm 层
//!   语义分发(host 测试只走成功路径);纯 Rust 错误用例在 core 模块内.
//!
//! 编码注意:不要在此文件内联任何采样/积分/求交算法;改动数学行为先找 core.

pub mod builtins;
pub mod config;
pub mod domain_integral;
pub mod eval_core;
pub mod field_core;
pub mod geometry_core;
pub mod integral_core;
pub mod integral_method;
pub mod intersection_core;
pub mod sampling_core;
pub mod symbolic;
pub mod transform_core;
mod wasm_payloads;

use integral_method::IntegralMethod;
use wasm_bindgen::prelude::*;
use wasm_payloads::{
    EvaluateCurlPointPayload, EvaluateDivergencePointPayload, EvaluateGradientPointPayload,
    Integrate1dPayload, Integrate2dPayload, IntegrateRegionPayload, IntegrateSolidPayload,
    IntersectPairPayload, SampleVectorFieldPayload,
};

fn math_error(message: impl Into<String>) -> JsValue {
    JsValue::from_str(&message.into())
}

/// 把 JSON 请求串解析为类型化请求;解析失败也统一走 `math_error`.
fn parse_payload<T: serde::de::DeserializeOwned>(payload: &str) -> Result<T, JsValue> {
    serde_json::from_str::<T>(payload).map_err(|e| math_error(format!("请求参数解析失败: {e}")))
}

// ================================================================
// 4x4 矩阵变换
// ================================================================

#[wasm_bindgen]
pub fn mat4_identity() -> Vec<f64> {
    transform_core::identity4().to_vec()
}

#[wasm_bindgen]
pub fn mat4_translate(tx: f64, ty: f64, tz: f64) -> Vec<f64> {
    transform_core::translate4(tx, ty, tz).to_vec()
}

#[wasm_bindgen]
pub fn mat4_scale(sx: f64, sy: f64, sz: f64) -> Vec<f64> {
    transform_core::scale4(sx, sy, sz).to_vec()
}

#[wasm_bindgen]
pub fn mat4_rotate(rx: f64, ry: f64, rz: f64) -> Vec<f64> {
    transform_core::rotate4(rx, ry, rz).to_vec()
}

#[wasm_bindgen]
pub fn mat4_multiply(a: Vec<f64>, b: Vec<f64>) -> Result<Vec<f64>, JsValue> {
    let a = transform_core::from_flat(a).map_err(math_error)?;
    let b = transform_core::from_flat(b).map_err(math_error)?;
    Ok(transform_core::multiply4x4(a, b).to_vec())
}

#[wasm_bindgen]
pub fn mat4_apply_point(matrix: Vec<f64>, x: f64, y: f64, z: f64) -> Result<Vec<f64>, JsValue> {
    let matrix = transform_core::from_flat(matrix).map_err(math_error)?;
    Ok(transform_core::apply_to_point(matrix, x, y, z).to_vec())
}

// ================================================================
// 曲线 / 向量场采样
// ================================================================

/// 曲线采样结果:扁平顶点 + 每段起始顶点下标.
///
/// 曲线会在定义域空洞/竖直渐近线处拆成多段,渲染层据此画多条互不相连的
/// 折线,避免在断点两侧画出一条伪连接线(见 `sampling_core::sample_curve`).
#[wasm_bindgen(getter_with_clone)]
pub struct CurveSampleResult {
    /// 扁平 `[x, y, 0, ...]` 顶点数组.
    pub points: Vec<f32>,
    /// 每段在 `points` 里的起始顶点下标;末项等于顶点总数.
    pub offsets: Vec<u32>,
}

#[wasm_bindgen]
pub fn sample_curve(
    expr: &str,
    coeff_names: Vec<String>,
    coeff_values: Vec<f64>,
    x_min: f64,
    x_max: f64,
    steps: usize,
) -> Result<CurveSampleResult, JsValue> {
    let (points, offsets) =
        sampling_core::sample_curve(expr, &coeff_names, &coeff_values, x_min, x_max, steps)
            .map_err(math_error)?;
    Ok(CurveSampleResult { points, offsets })
}

/// 三维向量场采样统一入口:参数走 JSON 请求(见 `wasm_payloads`),
/// 避免在 wasm 边界暴露 14 个扁平参数.
#[wasm_bindgen]
pub fn sample_vector_field(payload: &str) -> Result<Vec<f32>, JsValue> {
    let req = parse_payload::<SampleVectorFieldPayload>(payload)?;
    sampling_core::sample_vector_field(
        &req.p_expr,
        &req.q_expr,
        &req.r_expr,
        &req.coeff_names,
        &req.coeff_values,
        req.x_min,
        req.x_max,
        req.y_min,
        req.y_max,
        req.z_min,
        req.z_max,
        req.nx,
        req.ny,
        req.nz,
    )
    .map_err(math_error)
}

// ================================================================
// 表达式级积分
// ================================================================

#[wasm_bindgen(getter_with_clone)]
pub struct IntegralSampleResult {
    pub value: f64,
    pub samples: Vec<f64>,
    pub sample_shape: String,
    pub n: usize,
    pub m: usize,
    /// 域积分(region 2D / solid 3D)回传的外接范围;其他域按需填 NaN.
    pub xa: f64,
    pub xb: f64,
    pub ya: f64,
    pub yb: f64,
    pub za: f64,
    pub zb: f64,
}

/// 一维(曲线域)积分统一入口;参数走 JSON 请求(见 `wasm_payloads`).
#[wasm_bindgen]
pub fn integrate1d(payload: &str) -> Result<IntegralSampleResult, JsValue> {
    let Integrate1dPayload {
        ref expr,
        ref coeff_names,
        ref coeff_values,
        a,
        b,
        n,
        layers,
        ref method,
    } = parse_payload::<Integrate1dPayload>(payload)?;
    let method = IntegralMethod::parse(method).map_err(math_error)?;
    let sample_shape = method.sample_shape_1d();
    let samples =
        sampling_core::sample_function_1d(expr, coeff_names, coeff_values, a, b, n, sample_shape)
            .map_err(math_error)?;

    let value = match method {
        IntegralMethod::Trapz => {
            integral_core::trapz1d_from_values(&samples, a, b).map_err(math_error)?
        }
        IntegralMethod::Simpson => {
            integral_core::simpson1d_from_values(&samples, a, b).map_err(math_error)?
        }
        IntegralMethod::RiemannLeft => {
            integral_core::riemann1d_left_from_values(&samples, a, b).map_err(math_error)?
        }
        IntegralMethod::RiemannRight => {
            integral_core::riemann1d_right_from_values(&samples, a, b).map_err(math_error)?
        }
        IntegralMethod::RiemannMid => {
            integral_core::riemann1d_mid_from_values(&samples, a, b).map_err(math_error)?
        }
        IntegralMethod::Lebesgue => {
            integral_core::lebesgue1d_from_values(&samples, a, b, layers).map_err(math_error)?
        }
    };

    Ok(IntegralSampleResult {
        value,
        samples,
        sample_shape: sample_shape.tag_1d().to_string(),
        n,
        m: 0,
        xa: a,
        xb: b,
        ya: f64::NAN,
        yb: f64::NAN,
        za: f64::NAN,
        zb: f64::NAN,
    })
}

/// 二维(矩形域)积分统一入口;参数走 JSON 请求(见 `wasm_payloads`).
#[wasm_bindgen]
pub fn integrate2d(payload: &str) -> Result<IntegralSampleResult, JsValue> {
    let Integrate2dPayload {
        ref expr,
        ref coeff_names,
        ref coeff_values,
        xa,
        xb,
        ya,
        yb,
        n,
        m,
        layers,
        ref method,
    } = parse_payload::<Integrate2dPayload>(payload)?;
    let method = IntegralMethod::parse(method).map_err(math_error)?;
    let sample_shape = method.sample_shape_2d();
    let samples = sampling_core::sample_function_2d(
        expr,
        coeff_names,
        coeff_values,
        xa,
        xb,
        ya,
        yb,
        n,
        m,
        sample_shape,
    )
    .map_err(math_error)?;

    let value = match method {
        IntegralMethod::Trapz => {
            integral_core::trapz2d_from_values(&samples, (xa, xb), (ya, yb), n, m)
                .map_err(math_error)?
        }
        IntegralMethod::Simpson => {
            integral_core::simpson2d_from_values(&samples, (xa, xb), (ya, yb), n, m)
                .map_err(math_error)?
        }
        IntegralMethod::RiemannLeft => {
            integral_core::riemann2d_left_from_values(&samples, (xa, xb), (ya, yb), n, m)
                .map_err(math_error)?
        }
        IntegralMethod::RiemannRight => {
            integral_core::riemann2d_right_from_values(&samples, (xa, xb), (ya, yb), n, m)
                .map_err(math_error)?
        }
        IntegralMethod::RiemannMid => {
            integral_core::riemann2d_mid_from_values(&samples, (xa, xb), (ya, yb), n, m)
                .map_err(math_error)?
        }
        IntegralMethod::Lebesgue => {
            integral_core::lebesgue2d_from_values(&samples, (xa, xb), (ya, yb), n, m, layers)
                .map_err(math_error)?
        }
    };

    Ok(IntegralSampleResult {
        value,
        samples,
        sample_shape: sample_shape.tag_2d().to_string(),
        n,
        m,
        xa,
        xb,
        ya,
        yb,
        za: f64::NAN,
        zb: f64::NAN,
    })
}

// ================================================================
// 带域积分:region(2D 面积图形)/ solid(3D 实体)
// ================================================================

/// region(2D, x 型带状)域积分统一入口;参数走 JSON 请求(见 `wasm_payloads`).
///
/// - 被积函数(世界坐标 x,y,`integrand`)与两条边界曲线各带独立系数表;
/// - 曲线 y=f(x) 求值走一元后端(不会误把 y/z 当坐标变量);
/// - 数值语义见 `domain_integral::integrate_region`.
#[wasm_bindgen]
pub fn integrate_region(payload: &str) -> Result<IntegralSampleResult, JsValue> {
    let IntegrateRegionPayload {
        ref method,
        ref integrand_expr,
        ref integrand_names,
        ref integrand_values,
        ref boundary_a_expr,
        ref boundary_a_names,
        ref boundary_a_values,
        ref boundary_b_expr,
        ref boundary_b_names,
        ref boundary_b_values,
        xa,
        xb,
        n,
        layers,
    } = parse_payload::<IntegrateRegionPayload>(payload)?;
    let input = domain_integral::RegionInput {
        integrand_expr,
        integrand_names,
        integrand_values,
        boundary_exprs: [boundary_a_expr, boundary_b_expr],
        boundary_names: [boundary_a_names, boundary_b_names],
        boundary_values: [boundary_a_values, boundary_b_values],
        xa,
        xb,
    };
    let method = IntegralMethod::parse(method).map_err(math_error)?;
    let outcome =
        domain_integral::integrate_region(method, &input, n, layers).map_err(math_error)?;
    Ok(IntegralSampleResult {
        value: outcome.value,
        samples: outcome.samples,
        sample_shape: "2d-cell".to_string(),
        n: outcome.n,
        m: outcome.n,
        xa,
        xb,
        ya: outcome.y_min,
        yb: outcome.y_max,
        za: f64::NAN,
        zb: f64::NAN,
    })
}

/// solid(3D 实体:sphere/box/conic)域积分统一入口;参数走 JSON 请求
/// (见 `wasm_payloads`).
///
/// 域描述复用求交的 ObjectDescriptor 形状(kind+params+matrix+inverse),
/// 使三重积分与"渲染出的世界实体"保持同一几何口径.
#[wasm_bindgen]
pub fn integrate_solid(payload: &str) -> Result<IntegralSampleResult, JsValue> {
    let IntegrateSolidPayload {
        ref method,
        ref kind,
        params,
        matrix_values,
        inverse_values,
        ref integrand_expr,
        ref integrand_names,
        ref integrand_values,
        n,
        layers,
    } = parse_payload::<IntegrateSolidPayload>(payload)?;
    // 实体没有表达式:expr 传空,系数为空.
    let descriptor = geometry_core::parse_object_descriptor(
        kind,
        "",
        Vec::new(),
        Vec::new(),
        params,
        matrix_values,
        inverse_values,
    )
    .map_err(math_error)?;

    let method = IntegralMethod::parse(method).map_err(math_error)?;

    // f≡1 的 3D lebesgue 直接返回解析测度(体积),不建层几何,不做 O(n³) 网格.
    if method == IntegralMethod::Lebesgue && integrand_expr.trim() == "1" {
        let measure = domain_integral::solid_exact_measure(&descriptor).map_err(math_error)?;
        let aabb = geometry_core::solid_world_aabb(&descriptor).map_err(math_error)?;
        return Ok(IntegralSampleResult {
            value: measure,
            samples: Vec::new(),
            sample_shape: "3d-skip".to_string(),
            n: 0,
            m: 0,
            xa: aabb.0[0],
            xb: aabb.0[1],
            ya: aabb.1[0],
            yb: aabb.1[1],
            za: aabb.2[0],
            zb: aabb.2[1],
        });
    }

    let outcome = domain_integral::integrate_solid(
        method,
        &descriptor,
        integrand_expr,
        integrand_names,
        integrand_values,
        n,
        layers,
    )
    .map_err(math_error)?;
    Ok(IntegralSampleResult {
        value: outcome.value,
        samples: outcome.samples,
        sample_shape: "3d-cells".to_string(),
        n: outcome.n,
        m: outcome.n,
        xa: outcome.x_min,
        xb: outcome.x_max,
        ya: outcome.y_min,
        yb: outcome.y_max,
        za: outcome.z_min,
        zb: outcome.z_max,
    })
}

// ================================================================
// 梯度 / 散度 / 旋度
// ================================================================

#[wasm_bindgen]
pub struct GradientPointResult {
    pub f0: f64,
    pub fx: f64,
    pub fy: f64,
}

#[wasm_bindgen]
pub struct CurlPointResult {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[wasm_bindgen(getter_with_clone)]
pub struct IntersectionOutput {
    /// 离散交点,扁平 `[x, y, z, ...]`.
    pub points: Vec<f64>,
    /// 交线折线点,扁平 `[x, y, z, ...]`.
    pub curve_points: Vec<f64>,
    /// 每条折线在 `curve_points` 里的起始点下标,末尾为总点数.
    pub curve_offsets: Vec<u32>,
}

#[wasm_bindgen]
pub fn evaluate_scalar(
    expr: &str,
    coeff_names: Vec<String>,
    coeff_values: Vec<f64>,
    x: f64,
    y: f64,
    z: f64,
) -> Result<f64, JsValue> {
    field_core::evaluate_scalar(expr, &coeff_names, &coeff_values, x, y, z).map_err(math_error)
}

/// 求交统一入口;参数走 JSON 请求(见 `wasm_payloads`).
///
/// 两个对象各用 `(kind, expr, coeff_names, coeff_values, params, matrix, inverse)`
/// 描述;`params` 布局见 `geometry_core` 模块注释(求交参与方与体积积分域
/// 共用同一描述符).表达式/系数只在 Rust
/// 内核里编译一次,后续逐点求值都复用上下文,不再每次跨 JS/WASM 边界重建.
#[wasm_bindgen]
pub fn intersect_pair(payload: &str) -> Result<IntersectionOutput, JsValue> {
    let IntersectPairPayload {
        ref kind_a,
        ref expr_a,
        coeff_names_a,
        coeff_values_a,
        params_a,
        matrix_a,
        inverse_a,
        ref kind_b,
        ref expr_b,
        coeff_names_b,
        coeff_values_b,
        params_b,
        matrix_b,
        inverse_b,
        segments,
    } = parse_payload::<IntersectPairPayload>(payload)?;
    let a = intersection_core::parse_object_descriptor(
        kind_a,
        expr_a,
        coeff_names_a,
        coeff_values_a,
        params_a,
        matrix_a,
        inverse_a,
    )
    .map_err(math_error)?;
    let b = intersection_core::parse_object_descriptor(
        kind_b,
        expr_b,
        coeff_names_b,
        coeff_values_b,
        params_b,
        matrix_b,
        inverse_b,
    )
    .map_err(math_error)?;

    let output = intersection_core::compute_pair(&a, &b, segments).map_err(math_error)?;
    Ok(IntersectionOutput {
        points: output.points,
        curve_points: output.curve_points,
        curve_offsets: output.curve_offsets,
    })
}

// ================================================================
// 符号解析 / 求导 / 变量提取 / 数组与矩阵解析
// ================================================================

#[wasm_bindgen]
pub fn normalize_expression(expr: &str) -> Result<String, JsValue> {
    symbolic::normalize_expression(expr).map_err(math_error)
}

#[wasm_bindgen]
pub fn latex_expression(expr: &str) -> Result<String, JsValue> {
    symbolic::latex_expression(expr).map_err(math_error)
}

#[wasm_bindgen]
pub fn symbolic_derivative(expr: &str, variable: &str) -> Result<String, JsValue> {
    symbolic::symbolic_derivative(expr, variable).map_err(math_error)
}

#[wasm_bindgen]
pub fn symbolic_variables(expr: &str, exclude: Vec<String>) -> Result<Vec<String>, JsValue> {
    symbolic::symbolic_variables(expr, &exclude).map_err(math_error)
}

#[wasm_bindgen]
pub fn parse_array_strings(expr: &str) -> Result<String, JsValue> {
    symbolic::parse_array_strings(expr).map_err(math_error)
}

#[wasm_bindgen]
pub fn matrix4_from_expr(expr: &str) -> Result<Vec<f64>, JsValue> {
    symbolic::matrix4_from_expr(expr).map_err(math_error)
}

/// 梯度数值求值入口;参数走 JSON 请求(见 `wasm_payloads`).
#[wasm_bindgen]
pub fn evaluate_gradient_point(payload: &str) -> Result<GradientPointResult, JsValue> {
    let EvaluateGradientPointPayload {
        ref surface_expr,
        ref fx_expr,
        ref fy_expr,
        ref coeff_names,
        ref coeff_values,
        x,
        y,
    } = parse_payload::<EvaluateGradientPointPayload>(payload)?;
    let (f0, fx, fy) = field_core::evaluate_gradient_point(
        surface_expr,
        fx_expr,
        fy_expr,
        coeff_names,
        coeff_values,
        x,
        y,
    )
    .map_err(math_error)?;

    Ok(GradientPointResult { f0, fx, fy })
}

/// 散度数值求值入口;参数走 JSON 请求(见 `wasm_payloads`).
#[wasm_bindgen]
pub fn evaluate_divergence_point(payload: &str) -> Result<f64, JsValue> {
    let EvaluateDivergencePointPayload {
        ref dpx_expr,
        ref dqy_expr,
        ref drz_expr,
        ref coeff_names,
        ref coeff_values,
        x,
        y,
        z,
    } = parse_payload::<EvaluateDivergencePointPayload>(payload)?;
    field_core::evaluate_divergence_point(
        dpx_expr,
        dqy_expr,
        drz_expr,
        coeff_names,
        coeff_values,
        x,
        y,
        z,
    )
    .map_err(math_error)
}

/// 旋度数值求值入口;参数走 JSON 请求(见 `wasm_payloads`).
#[wasm_bindgen]
pub fn evaluate_curl_point(payload: &str) -> Result<CurlPointResult, JsValue> {
    let EvaluateCurlPointPayload {
        ref dr_dy_expr,
        ref dq_dz_expr,
        ref dp_dz_expr,
        ref dr_dx_expr,
        ref dq_dx_expr,
        ref dp_dy_expr,
        ref coeff_names,
        ref coeff_values,
        x,
        y,
        z,
    } = parse_payload::<EvaluateCurlPointPayload>(payload)?;
    let (x, y, z) = field_core::evaluate_curl_point(
        dr_dy_expr,
        dq_dz_expr,
        dp_dz_expr,
        dr_dx_expr,
        dq_dx_expr,
        dp_dy_expr,
        coeff_names,
        coeff_values,
        x,
        y,
        z,
    )
    .map_err(math_error)?;

    Ok(CurlPointResult { x, y, z })
}

// ================================================================
// 分发层 / 契约层测试
//
// 审查报告指出:Rust 测试全是"核函数对拍",没有任何一项覆盖 lib.rs 的
// wasm 语义分发(方法字符串 -> 采样形状 -> 消费核这条 glue)--P0(2D
// rectangle lebesgue 采样/消费长度不一致)就住在 glue 里却一直全绿.
// 这里为每个积分 wasm 入口放一条"真值已知"的黄金用例,直接以 wasm 层
// 参数语义调用导出函数(宿主测试只走成功路径,Err 由 JsValue 构造,见
// integral_core/domain_integral 的纯 Rust 错误用例).
// ================================================================
#[cfg(test)]
mod glue_tests {
    use super::*;
    use wasm_payloads::{
        Integrate1dPayload, Integrate2dPayload, IntegrateRegionPayload, IntegrateSolidPayload,
    };

    fn no_coeffs() -> (Vec<String>, Vec<f64>) {
        (Vec::new(), Vec::new())
    }

    fn approx(actual: f64, expected: f64, tol: f64, label: &str) {
        assert!(
            (actual - expected).abs() <= tol,
            "{label}: {actual} vs 期望 {expected} (±{tol})"
        );
    }

    fn payload_of<T: serde::Serialize>(request: &T) -> String {
        serde_json::to_string(request).expect("请求可序列化")
    }

    #[test]
    fn integrate1d_trapezoid_simpson_riemann_known_values() {
        let (names, values) = no_coeffs();
        let request = Integrate1dPayload {
            expr: "x".to_string(),
            coeff_names: names.clone(),
            coeff_values: values.clone(),
            a: 0.0,
            b: 1.0,
            n: 128,
            layers: 8,
            method: "trapezoid".to_string(),
        };
        let result = integrate1d(&payload_of(&request)).expect("trapezoid 应成功");
        approx(result.value, 0.5, 1e-9, "trapezoid ∫x");

        let request = Integrate1dPayload {
            expr: "x".to_string(),
            coeff_names: names.clone(),
            coeff_values: values.clone(),
            a: 0.0,
            b: 1.0,
            n: 128,
            layers: 8,
            method: "simpson".to_string(),
        };
        let result = integrate1d(&payload_of(&request)).expect("simpson 应成功");
        approx(result.value, 0.5, 1e-12, "simpson ∫x");

        let request = Integrate1dPayload {
            expr: "x".to_string(),
            coeff_names: names.clone(),
            coeff_values: values.clone(),
            a: 0.0,
            b: 1.0,
            n: 128,
            layers: 8,
            method: "riemann:left".to_string(),
        };
        let result = integrate1d(&payload_of(&request)).expect("riemann:left 应成功");
        approx(result.value, 0.5, 5e-3, "riemann:left ∫x");

        let request = Integrate1dPayload {
            expr: "1".to_string(),
            coeff_names: names,
            coeff_values: values,
            a: 0.0,
            b: 1.0,
            n: 320,
            layers: 32,
            method: "lebesgue".to_string(),
        };
        let result = integrate1d(&payload_of(&request)).expect("1D lebesgue 应成功");
        approx(result.value, 1.0, 1e-9, "1D lebesgue ∫1");
    }

    /// P0 回归:2D rectangle 的 lebesgue 曾经因"corner 采样 N² 个值 vs
    /// 消费端期望 (N+1)²"必然报错;这里要求以 wasm 层语义直接成功.
    #[test]
    fn integrate2d_rectangle_lebesgue_glue_contract() {
        let (names, values) = no_coeffs();
        let request = Integrate2dPayload {
            expr: "1".to_string(),
            coeff_names: names.clone(),
            coeff_values: values.clone(),
            xa: 0.0,
            xb: 1.0,
            ya: 0.0,
            yb: 1.0,
            n: 64,
            m: 64,
            layers: 16,
            method: "lebesgue".to_string(),
        };
        let result =
            integrate2d(&payload_of(&request)).expect("2D lebesgue f≡1 应成功(不再有长度错误)");
        assert_eq!(result.sample_shape, "2d-corner");
        assert_eq!(result.samples.len(), 64 * 64);
        approx(result.value, 1.0, 1e-9, "2D lebesgue f≡1 面积");

        // f=x:∬_[0,1]² x dA = 1/2(层-测度近似的量化误差随 n,layers 收敛).
        let request = Integrate2dPayload {
            expr: "x".to_string(),
            coeff_names: names,
            coeff_values: values,
            xa: 0.0,
            xb: 1.0,
            ya: 0.0,
            yb: 1.0,
            n: 512,
            m: 512,
            layers: 512,
            method: "lebesgue".to_string(),
        };
        let result = integrate2d(&payload_of(&request)).expect("2D lebesgue f=x 应成功");
        approx(result.value, 0.5, 5e-3, "2D lebesgue f=x");
    }

    #[test]
    fn integrate2d_rectangle_other_methods_known_values() {
        let (names, values) = no_coeffs();
        // 梯形/辛普森对双线性精确.
        let request = Integrate2dPayload {
            expr: "x + y".to_string(),
            coeff_names: names.clone(),
            coeff_values: values.clone(),
            xa: 0.0,
            xb: 1.0,
            ya: 0.0,
            yb: 1.0,
            n: 64,
            m: 64,
            layers: 8,
            method: "simpson".to_string(),
        };
        let result = integrate2d(&payload_of(&request)).expect("2D simpson 应成功");
        approx(result.value, 1.0, 1e-9, "2D simpson ∬(x+y)");

        let request = Integrate2dPayload {
            expr: "x".to_string(),
            coeff_names: names.clone(),
            coeff_values: values.clone(),
            xa: 0.0,
            xb: 1.0,
            ya: 0.0,
            yb: 1.0,
            n: 128,
            m: 128,
            layers: 8,
            method: "riemann:mid".to_string(),
        };
        let result = integrate2d(&payload_of(&request)).expect("2D riemann:mid 应成功");
        approx(result.value, 0.5, 1e-9, "2D riemann:mid ∬x");
    }

    #[test]
    fn integrate_region_known_area_and_moment() {
        let (n1, v1) = no_coeffs();
        // D = {0≤x≤1, 0≤y≤x}:面积 1/2,∬ x dA = 1/3.
        let request = IntegrateRegionPayload {
            method: "simpson".to_string(),
            integrand_expr: "1".to_string(),
            integrand_names: n1.clone(),
            integrand_values: v1.clone(),
            boundary_a_expr: "0".to_string(),
            boundary_a_names: n1.clone(),
            boundary_a_values: v1.clone(),
            boundary_b_expr: "x".to_string(),
            boundary_b_names: n1.clone(),
            boundary_b_values: v1.clone(),
            xa: 0.0,
            xb: 1.0,
            n: 128,
            layers: 8,
        };
        let outcome = integrate_region(&payload_of(&request)).expect("region simpson 应成功");
        approx(outcome.value, 0.5, 1e-9, "region simpson 面积");

        let request = IntegrateRegionPayload {
            method: "simpson".to_string(),
            integrand_expr: "x".to_string(),
            integrand_names: n1.clone(),
            integrand_values: v1.clone(),
            boundary_a_expr: "0".to_string(),
            boundary_a_names: n1.clone(),
            boundary_a_values: v1.clone(),
            boundary_b_expr: "x".to_string(),
            boundary_b_names: n1,
            boundary_b_values: v1,
            xa: 0.0,
            xb: 1.0,
            n: 128,
            layers: 8,
        };
        let outcome = integrate_region(&payload_of(&request)).expect("region simpson 应成功");
        approx(outcome.value, 1.0 / 3.0, 1e-7, "region simpson ∬x");
    }

    #[test]
    fn integrate_solid_volume_and_quadratic_integrand() {
        let (names, values) = no_coeffs();
        // 单位球体积 4π/3(wasm 层的 lebesgue f≡1 短路径).
        let request = IntegrateSolidPayload {
            method: "lebesgue".to_string(),
            kind: "sphere".to_string(),
            params: vec![0.0, 0.0, 0.0, 1.0],
            matrix_values: vec![],
            inverse_values: vec![],
            integrand_expr: "1".to_string(),
            integrand_names: names.clone(),
            integrand_values: values.clone(),
            n: 0,
            layers: 8,
        };
        let result = integrate_solid(&payload_of(&request)).expect("solid lebesgue f≡1 应成功");
        approx(
            result.value,
            4.0 / 3.0 * std::f64::consts::PI,
            1e-9,
            "球体积",
        );

        // ∭(x²+y²+z²) dV = 4π/5.
        let request = IntegrateSolidPayload {
            method: "simpson".to_string(),
            kind: "sphere".to_string(),
            params: vec![0.0, 0.0, 0.0, 1.0],
            matrix_values: vec![],
            inverse_values: vec![],
            integrand_expr: "x*x + y*y + z*z".to_string(),
            integrand_names: names,
            integrand_values: values,
            n: 64,
            layers: 8,
        };
        let result = integrate_solid(&payload_of(&request)).expect("solid simpson 应成功");
        approx(
            result.value,
            4.0 / 5.0 * std::f64::consts::PI,
            1e-3,
            "单位球 ∭r² dV",
        );
    }
}
