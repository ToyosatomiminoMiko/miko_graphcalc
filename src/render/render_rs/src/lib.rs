pub mod config;
pub mod surface_utils;

use wasm_bindgen::prelude::*;

/// 曲面打包结果的头部字节数(小端,与 JS DataView littleEndian=true 一致):
///   [0..4)    positions 元素个数(u32)
///   [4..8)    normals   元素个数(u32)
///   [8..12)   valid_indices 元素个数(u32)
///   [12..20)  z_min (f64)
///   [20..28)  z_max (f64)
///   [28 .. 28+4*positions_len)       positions 字节(f32)
///   [.. +4*normals_len)              normals 字节(f32)
///   [.. +4*valid_indices_len)        valid_indices 字节(u32)
///
/// 头部 28 字节是 4 的倍数,保证三个数组都从 4 字节对齐偏移开始;f64 z 极值
/// 位于非 8 对齐偏移,wasm 与 JS DataView 均允许非对齐访问,无影响.
const SURFACE_PACKED_HEADER_BYTES: usize = 28;

#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn sample_and_process_surface(
    expr: &str,
    coeff_names: Vec<String>,
    coeff_values: Vec<f64>,
    x_min: f64,
    x_max: f64,
    y_min: f64,
    y_max: f64,
    cols: u32,
    rows: u32,
) -> Result<Vec<u8>, JsValue> {
    let result = surface_utils::sample_and_process_surface(
        expr,
        &coeff_names,
        &coeff_values,
        x_min,
        x_max,
        y_min,
        y_max,
        cols,
        rows,
    )
    .map_err(|e| JsValue::from_str(&e))?;

    Ok(pack_surface_result(&result))
}

/// 把多个采样数组拼进单一扁平缓冲区.
///
/// 这是"方案 A:结构体 getter -> 函数直返 `Vec<T>`"在**多数组**场景下的落地形态:
/// wasm-bindgen 一次函数调用无法同时 move 返回多个 `Vec`,故把 positions /
/// normals / valid_indices 连同 z_min / z_max 一并塞进一个 `Vec<u8>` 由函数
/// 直接返回.返回的 `Vec<u8>` 走 glue 的"函数直返"路径(只做一次 `.slice()`),
/// 消除了原先 `getter_with_clone` 结构体 getter 在 wasm 内的那次全量克隆.
/// 见 prompt/JS_WASM_BOUNDARY_COPY_REPORT.md.
fn pack_surface_result(r: &surface_utils::SurfaceSampleResult) -> Vec<u8> {
    let n_pos = r.positions.len();
    let n_nor = r.normals.len();
    let n_idx = r.valid_indices.len();
    let data_bytes = 4 * (n_pos + n_nor + n_idx);

    let mut buf = Vec::with_capacity(SURFACE_PACKED_HEADER_BYTES + data_bytes);

    buf.extend_from_slice(&(n_pos as u32).to_le_bytes());
    buf.extend_from_slice(&(n_nor as u32).to_le_bytes());
    buf.extend_from_slice(&(n_idx as u32).to_le_bytes());
    buf.extend_from_slice(&r.z_min.to_le_bytes());
    buf.extend_from_slice(&r.z_max.to_le_bytes());

    for v in &r.positions {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    for v in &r.normals {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    for v in &r.valid_indices {
        buf.extend_from_slice(&v.to_le_bytes());
    }

    buf
}
