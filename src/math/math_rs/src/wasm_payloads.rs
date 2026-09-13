//! 复杂 wasm 入口的请求结构(替代 20+ 扁平参数的旧签名).
//!
//! 背景:lib.rs 的 wasm 导出曾经把 intersect_pair / integrate_region /
//! sample_vector_field 等堆到 9–20 个扁平参数,每加一个字段都要同步改
//! wasm 签名,Worker 调用,Client 透传与 IR spec 四处;`math_error` 与
//! `JsValue::from_str` 的用法也各自为政.
//!
//! 现在每个这类入口只接受一个 **JSON 字符串**(`payload: &str`),由
//! serde 反序列化成下面的类型化请求.对应 TS 侧在 Worker/编译层构造同名
//! JSON 对象(`JSON.stringify`)即可;wasm 签名保持 `(payload: &str)`,
//! 以后加字段只动"本结构体 + TS 构造处"两处.
//!
//! 字段名沿用旧参数名(下划线命名),JSON 键与之完全一致;数字数组即 JSON
//! number 数组(TS 侧需把 Float64Array 展开成普通数组再 stringify).

use serde::{Deserialize, Serialize};

/// `integrate1d`:一维曲线域积分请求.
#[derive(Debug, Deserialize, Serialize)]
pub struct Integrate1dPayload {
    pub expr: String,
    pub coeff_names: Vec<String>,
    pub coeff_values: Vec<f64>,
    pub a: f64,
    pub b: f64,
    pub n: usize,
    pub layers: usize,
    pub method: String,
}

/// `integrate2d`:二维矩形域积分请求.
#[derive(Debug, Deserialize, Serialize)]
pub struct Integrate2dPayload {
    pub expr: String,
    pub coeff_names: Vec<String>,
    pub coeff_values: Vec<f64>,
    pub xa: f64,
    pub xb: f64,
    pub ya: f64,
    pub yb: f64,
    pub n: usize,
    pub m: usize,
    pub layers: usize,
    pub method: String,
}

/// `integrate_region`:region(面积图形)域积分请求.
#[derive(Debug, Deserialize, Serialize)]
pub struct IntegrateRegionPayload {
    pub method: String,
    pub integrand_expr: String,
    pub integrand_names: Vec<String>,
    pub integrand_values: Vec<f64>,
    pub boundary_a_expr: String,
    pub boundary_a_names: Vec<String>,
    pub boundary_a_values: Vec<f64>,
    pub boundary_b_expr: String,
    pub boundary_b_names: Vec<String>,
    pub boundary_b_values: Vec<f64>,
    pub xa: f64,
    pub xb: f64,
    pub n: usize,
    pub layers: usize,
}

/// `integrate_solid`:3D 实体域积分请求.
#[derive(Debug, Deserialize, Serialize)]
pub struct IntegrateSolidPayload {
    pub method: String,
    pub kind: String,
    pub params: Vec<f64>,
    pub matrix_values: Vec<f64>,
    pub inverse_values: Vec<f64>,
    pub integrand_expr: String,
    pub integrand_names: Vec<String>,
    pub integrand_values: Vec<f64>,
    pub n: usize,
    pub layers: usize,
}

/// `sample_vector_field`:三维向量场采样请求.
#[derive(Debug, Deserialize, Serialize)]
pub struct SampleVectorFieldPayload {
    pub p_expr: String,
    pub q_expr: String,
    pub r_expr: String,
    pub coeff_names: Vec<String>,
    pub coeff_values: Vec<f64>,
    pub x_min: f64,
    pub x_max: f64,
    pub y_min: f64,
    pub y_max: f64,
    pub z_min: f64,
    pub z_max: f64,
    pub nx: usize,
    pub ny: usize,
    pub nz: usize,
}

/// `intersect_pair`:两个对象求交请求(与旧参数一一对应).
#[derive(Debug, Deserialize, Serialize)]
pub struct IntersectPairPayload {
    pub kind_a: String,
    pub expr_a: String,
    pub coeff_names_a: Vec<String>,
    pub coeff_values_a: Vec<f64>,
    pub params_a: Vec<f64>,
    pub matrix_a: Vec<f64>,
    pub inverse_a: Vec<f64>,
    pub kind_b: String,
    pub expr_b: String,
    pub coeff_names_b: Vec<String>,
    pub coeff_values_b: Vec<f64>,
    pub params_b: Vec<f64>,
    pub matrix_b: Vec<f64>,
    pub inverse_b: Vec<f64>,
    pub segments: usize,
}

/// `evaluate_gradient_point`:梯度数值求值请求.
#[derive(Debug, Deserialize, Serialize)]
pub struct EvaluateGradientPointPayload {
    pub surface_expr: String,
    pub fx_expr: String,
    pub fy_expr: String,
    pub coeff_names: Vec<String>,
    pub coeff_values: Vec<f64>,
    pub x: f64,
    pub y: f64,
}

/// `evaluate_divergence_point`:散度数值求值请求.
#[derive(Debug, Deserialize, Serialize)]
pub struct EvaluateDivergencePointPayload {
    pub dpx_expr: String,
    pub dqy_expr: String,
    pub drz_expr: String,
    pub coeff_names: Vec<String>,
    pub coeff_values: Vec<f64>,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// `evaluate_curl_point`:旋度数值求值请求.
#[derive(Debug, Deserialize, Serialize)]
pub struct EvaluateCurlPointPayload {
    pub dr_dy_expr: String,
    pub dq_dz_expr: String,
    pub dp_dz_expr: String,
    pub dr_dx_expr: String,
    pub dq_dx_expr: String,
    pub dp_dy_expr: String,
    pub coeff_names: Vec<String>,
    pub coeff_values: Vec<f64>,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}
