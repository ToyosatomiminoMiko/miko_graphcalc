// ================================================================
// surface_utils.rs -- 曲面生成:数值采样 + 网格后处理(Rust/WASM 侧)
//
// 职责:把 "z = f(x, y)" 表达式变成可直接交给 Three.js 的网格数据,
// 产出 positions / valid_indices / normals 以及 z_min / z_max.
// 本文件只做几何,不做颜色.
//
// ------------------------------------------------------------------
// 颜色映射已拆到渲染侧(着色器),见 src/render/visualization/
// surfaceColorMap.ts:旧的 CPU 路径 map_surface_colors(HSL 伪彩色 +
// color attribute + vertexColors)已从 render_rs 移除;同一套 z->HSL
// 映射搬进了顶点着色器,按 position.z 与 uZRange 每帧实时计算.
// 因此本文件仍需把采样结果的 z 极值(z_min/z_max)回传出去 -- 它是
// 着色器色带区间的数据来源(主线程把它更新进 uZRange uniform).
//
// 曲面生成的完整流程:
//
//   UI 输入(滑杆 / 系数 / 区间)变化
//     -> rAF 脏标记绘制 SurfaceRenderer.draw()
//     -> SurfaceMesh.update()
//     -> SurfaceComputeClient(latest-only,过期请求被丢弃)
//     -> surfaceWorker(独立线程)
//     -> render_rs::sample_and_process_surface(lib.rs 的 wasm 导出)
//         └─ sample_and_process_surface(本文件,编排入口)
//              ① sample_surface_values()    数值采样
//                 委托 math_rs::sampling_core::sample_surface_values:
//                 表达式(CompiledEvaluator)只编译一次,在
//                 (cols+1)×(rows+1) 行优先网格(外 y 内 x)上逐点求值
//                 z = f(x,y),非有限值写为 NaN;再据此组装 positions
//                 (x,y,z 扁平 f32)并统计 z_min/z_max -- 只统计有限 z,
//                 若全部非法则回退 DEGENERATE_Z_MIN/Z_MAX(见 config.rs)
//              ② compute_valid_cells()       无效单元过滤
//                 一个单元在以下情况不参与绘制:
//                   · 任一顶点 z 为 NaN(防止 NaN 面法线经顶点平均污染
//                     相邻正常三角形);
//                   · 单元跨过竖直渐近线/间断(某条边两端 z 符号相反且
//                     中点值跳出两端,再叠加"跳变远超该方向的中位跳变"
//                     或"中点值远超两端幅值"任一条)--像 tan(x) 在渐近线
//                     两侧都是"有限但巨大"的 z 值,不会产生 NaN,若不按此
//                     剔除会被画成一堵贯穿渐近线的"墙";
//                     符号相反但中点介于两端的光滑过零必须放行,否则会在
//                     曲面上误切出一条方形空洞.
//              ③ generate_valid_indices()    网格索引
//                 只对有效单元出两个三角形,每格拆 (a,b,d)+(a,d,c);
//                 无效单元不产出任何索引,这才是真正参与绘制的几何.
//              ④ compute_vertex_normals()   平滑法线
//                 对共享顶点累加三角形面法线再归一化,与 Three.js
//                 BufferGeometry.computeVertexNormals() 语义一致;
//                 放在 WASM 做,避免主线程 O(顶点数) 遍历
//             ↓ 产出
//         SurfaceSampleResult { positions, valid_indices, normals,
//                               z_min, z_max }
//     -> 结果经 Transferable 数组回主线程
//     -> SurfaceMesh._applyResult()
//          · 把 positions / normals / valid_indices 写回预分配的
//            BufferGeometry(几何体只创建一次,高频更新只改 attribute)
//          · colorRange.setRange(z_min, z_max) -> 更新 uZRange uniform
//     -> 渲染(Three.js Phong 材质,渲染侧流程)
//          顶点着色器  surfaceColorFromZ(position.z) -> vSurfaceColor
//                      · t = (z - z_min)/(z_max - z_min),clamp 到 [0,1];
//                        range == 0(平面)时取 FLAT_COLOR_T = 0.5
//                      · NaN/Inf 顶点 -> 黑(其所在三角形已被 ② 剔除)
//                      · hue 0.66->0,sat 0.9,light 0.5->0.8(HSL 伪彩)
//          片段着色器  diffuseColor.rgb *= vSurfaceColor
//                      (diffuse 乘顶点色;specular 不受影响,
//                       与旧 vertexColors + CPU color 语义一致)
//
// 同步约束:config.rs 中的配色常量(SURFACE_HUE_START / SURFACE_SATURATION /
// SURFACE_LIGHTNESS_BASE / SURFACE_LIGHTNESS_RANGE / FLAT_COLOR_T)必须与
// surfaceColorMap.ts 内嵌的 GLSL 常量保持一致 -- 改任一侧都要同步另一侧.
// ================================================================
use crate::config::{
    COLOR_AUTO_SWITCH_FACTOR, COLOR_PERCENTILE_HI, COLOR_PERCENTILE_LO, DEGENERATE_Z_MAX,
    DEGENERATE_Z_MIN,
};

/// 垂直渐近线式"跳变必须超出的相对倍数"(相对该方向的中位跳变).
///
/// 与采样层曲线的 `ASYMPTOTE_JUMP_FACTOR` 同量级.用于捕捉"渐近线恰好靠近
/// 网格点"的情形:此时近侧采样值已经很大,跨线边跳变远超中位跳变.
const POLE_JUMP_FACTOR: f64 = 16.0;

/// 中点发散倍数:判定一条符号翻转边是否是"冲到 ±∞"的间断.
///
/// 只在边中点重新求值一次 f:若中点值远超两端 z 的幅值,说明函数在两点之间
/// 发散(间断);若只是平滑过零(如 `z=1000·sin(x)`),中点值应介于两端之间.
const POLE_MIDPOINT_FACTOR: f64 = 2.0;

/// 中位数;空切片返回 0,避免除零/NaN 污染.
fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    } else {
        sorted[mid]
    }
}

/// 网格中某一方向(水平 x / 竖直 y)相邻边跳变 |Δz| 的中位数,作为该方向
/// "正常跳变"的稳健尺度.非有限端点不计入.
fn edge_median(z_values: &[f64], cols: usize, rows: usize, horizontal: bool) -> f64 {
    let width = cols + 1;
    let mut jumps: Vec<f64> = Vec::new();
    if horizontal {
        for j in 0..=rows {
            for i in 0..cols {
                let a = z_values[j * width + i];
                let b = z_values[j * width + i + 1];
                if a.is_finite() && b.is_finite() {
                    jumps.push((b - a).abs());
                }
            }
        }
    } else {
        for i in 0..=cols {
            for j in 0..rows {
                let a = z_values[j * width + i];
                let b = z_values[(j + 1) * width + i];
                if a.is_finite() && b.is_finite() {
                    jumps.push((b - a).abs());
                }
            }
        }
    }
    median(&jumps)
}

/// 判断一条"符号翻转"边是否跨越了竖直渐近线.
///
/// 变号边的绝大多数是"函数正常穿过零",而不是发散:例如
/// `z = x * e^{-(x²+y²)}` 在 x=0 一整列,`∂/∂x[e^{-(x²+y²)}]` 的过零线,
/// 都是光滑变号.因此这里先取边中点值 `f_mid`,再按下面的次序判定:
///
/// 1. **中点无定义** -> 间断(渐近线穿过单元,采样拿不到值);
/// 2. **中点介于两端之间**(`min(z0, z1) <= f_mid <= max(z0, z1)`) ->
///    函数在这条边上单调穿零,直接放行.这一票否决是必需的:它挡住的是
///    `POLE_JUMP_FACTOR` 那一路的误判 -- 曲面大片平坦时全局中位跳变很小,
///    而变号列的跳变可能超过它的 16 倍,只看跳变倍数会在光滑曲面上切出
///    一条方形空洞(回归用例 `smooth_zero_crossing_keeps_all_cells`);
/// 3. **中点跳出两端** -> 两路互相补充的信号任一成立即判为间断:
///    - **跳变远超**该方向的中位跳变:捕捉渐近线靠近网格点,近侧采样值
///      已经很大的情形;
///    - **中点发散**(`f_mid` 远超两端 z 幅值):捕捉渐近线落在单元中部,
///      两侧采样值都不大的情形.该项尺度无关,对 `tan(x*a)` 任意 `a` 都
///      稳定,不会因渐近线变密而被全局中位数污染.
///
/// 仅当两端 z 符号相反时才检查,以排除"平滑但陡峭"的正常边.
#[allow(clippy::too_many_arguments)]
fn edge_crosses_discontinuity(
    z0: f64,
    z1: f64,
    mid_x: f64,
    mid_y: f64,
    median_jump: f64,
    expr: &str,
    names: &[String],
    values: &[f64],
) -> bool {
    if (z0 < 0.0) == (z1 < 0.0) {
        return false;
    }
    let f_mid = math_rs::field_core::evaluate_scalar(expr, names, values, mid_x, mid_y, 0.0)
        .unwrap_or(f64::NAN);
    if !f_mid.is_finite() {
        return true;
    }
    if f_mid >= z0.min(z1) && f_mid <= z0.max(z1) {
        return false;
    }
    let scale = z0.abs().max(z1.abs()).max(f64::MIN_POSITIVE);
    if f_mid.abs() > POLE_MIDPOINT_FACTOR * scale {
        return true;
    }
    median_jump > 0.0 && (z1 - z0).abs() > POLE_JUMP_FACTOR * median_jump
}

/// 逐单元判断是否可参与绘制.
///
/// 无效条件(满足任一即丢弃该单元的两个三角形):
///
/// **① 任一顶点 z 为 NaN(必须剔除,勿删).**
///
/// 任何包含 NaN 顶点的三角形,其面法线是 NaN;而
/// `compute_vertex_normals` 会把三角形面法线按共享顶点累加再归一化,
/// 一旦某个含 NaN 的三角形参与了累加,NaN 就会通过顶点平均**扩散到所有
/// 相邻的正常三角形**,导致整片曲面出现高光/阴影异常.所以这里的 NaN
/// 判断不能省:它是"把采样层登记的非有限值(NaN 占位)挡在网格之外"的
/// 最后一道闸.某些统计口径(如 `z_min`/`z_max`)会遍历含 NaN 的顶点,
/// 但**绘制几何只认 `valid_indices`**,不含 NaN 单元.
///
/// **② 单元跨越了竖直渐近线(见 `edge_crosses_discontinuity`).**
///
/// `tan(x*a)` 这类曲面在渐近线两侧都是"有限但巨大"的 z 值,不会产生 NaN,
/// 若不按此剔除,跨线单元会被画成一堵贯穿渐近线的"墙".
///
/// 注意:符号相反**不等于**间断.光滑过零(中点值介于两端之间)一律放行,
/// 否则 `z = x*e^{-(x²+y²)}` 这类曲面会在变号线上被切出一条空洞.
#[allow(clippy::too_many_arguments)]
fn compute_valid_cells(
    z_values: &[f64],
    cols: usize,
    rows: usize,
    x_min: f64,
    x_max: f64,
    y_min: f64,
    y_max: f64,
    expr: &str,
    names: &[String],
    values: &[f64],
) -> Vec<bool> {
    let width = cols + 1;
    // 网格坐标映射:列/行 -> 世界坐标(与采样层 uniform_nodes 同式).
    let cell_x = |i: usize| x_min + (x_max - x_min) * (i as f64 / cols as f64);
    let cell_y = |j: usize| y_min + (y_max - y_min) * (j as f64 / rows as f64);

    let med_h = edge_median(z_values, cols, rows, true);
    let med_v = edge_median(z_values, cols, rows, false);

    let mut valid = Vec::with_capacity(cols * rows);
    for j in 0..rows {
        let y0 = cell_y(j);
        let y1 = cell_y(j + 1);
        for i in 0..cols {
            let x0 = cell_x(i);
            let x1 = cell_x(i + 1);

            let z00 = z_values[j * width + i];
            let z10 = z_values[j * width + i + 1];
            let z01 = z_values[(j + 1) * width + i];
            let z11 = z_values[(j + 1) * width + i + 1];

            let ok = [z00, z10, z01, z11].iter().all(|z| z.is_finite())
                // 四条边各查一次:下/上(水平,中点变 x),左/右(竖直,变 y).
                && !edge_crosses_discontinuity(
                    z00, z10, (x0 + x1) / 2.0, y0, med_h, expr, names, values,
                )
                && !edge_crosses_discontinuity(
                    z01, z11, (x0 + x1) / 2.0, y1, med_h, expr, names, values,
                )
                && !edge_crosses_discontinuity(
                    z00, z01, x0, (y0 + y1) / 2.0, med_v, expr, names, values,
                )
                && !edge_crosses_discontinuity(
                    z10, z11, x1, (y0 + y1) / 2.0, med_v, expr, names, values,
                );
            valid.push(ok);
        }
    }
    valid
}

/// 只对有效单元生成三角形索引(每个单元两个三角形).
///
/// 这些索引会一路传给 `compute_vertex_normals` 并被写入 Three.js
/// `BufferGeometry.index`,是**真正参与绘制的几何**.判断哪些单元"有效"
/// 的逻辑集中在 [`compute_valid_cells`](里对 NaN 与渐近线间断的剔除),
/// 这里只做"按有效 mask 产出对应三角形",不要再在这里补一套有效性规则.
fn generate_valid_indices(cols: usize, rows: usize, valid: &[bool]) -> Vec<u32> {
    let mut indices = Vec::with_capacity(cols * rows * 6);
    for j in 0..rows {
        for i in 0..cols {
            if !valid[j * cols + i] {
                continue;
            }
            let a = (j * (cols + 1) + i) as u32;
            let b = (j * (cols + 1) + i + 1) as u32;
            let c = ((j + 1) * (cols + 1) + i) as u32;
            let d = ((j + 1) * (cols + 1) + i + 1) as u32;
            indices.extend_from_slice(&[a, b, d, a, d, c]);
        }
    }
    indices
}
// ================================================================
// 统一后处理结果结构体
// ================================================================
pub struct SurfaceSampleResult {
    pub positions: Vec<f32>,
    pub valid_indices: Vec<u32>,
    pub normals: Vec<f32>,
    pub z_min: f64,
    pub z_max: f64,
}
// ================================================================
// 采样/索引过滤和法线计算
// ================================================================

/// 数组按升序排序后取第 `p` 分位的值(最近秩法).
fn percentile(sorted: &[f64], p: f64) -> f64 {
    let n = sorted.len();
    if n == 0 {
        return f64::NAN;
    }
    let idx = ((n - 1) as f64 * p).round() as usize;
    sorted[idx]
}

/// 计算用于颜色映射的稳健 z 区间(见 [`COLOR_PERCENTILE_LO`] 注释).
///
/// 动作:
/// - 平滑曲面(全量区间约等于分位数区间)-> 用全量 min/max,不压缩;
/// - 存在尖刺(全量区间显著宽于分位数区间,如 `tan(x*a)` 的渐近线
///   ±40 vs 主体 ±6)-> 用分位数区间,尖刺钳到颜色两端.
///
/// 只统计有限 z;若全部非法(整片曲面无定义),回退到 config.rs 的退化值.
fn robust_color_range(finite_z: &[f64]) -> (f64, f64) {
    if finite_z.is_empty() {
        return (DEGENERATE_Z_MIN, DEGENERATE_Z_MAX);
    }
    let mut sorted = finite_z.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let full_min = sorted[0];
    let full_max = *sorted.last().unwrap();
    let lo = percentile(&sorted, COLOR_PERCENTILE_LO);
    let hi = percentile(&sorted, COLOR_PERCENTILE_HI);

    let full_span = full_max - full_min;
    let robust_span = (hi - lo).max(f64::MIN_POSITIVE);
    if full_span > COLOR_AUTO_SWITCH_FACTOR * robust_span {
        (lo, hi)
    } else {
        (full_min, full_max)
    }
}

/// 曲面网格采样.
///
/// 返回 `(positions, z_vals, z_min, z_max)`.该函数只负责数值采样,
/// 不再掺杂索引过滤或法线计算.
///
/// 注意:返回的 `z_min/z_max` 是**颜色映射用的稳健区间**(分位数),而非
/// z 的绝对最小/最大(那会被渐近线附近的巨大值撑爆).它们只被上色 uniform
/// 消费,几何体真正的高度仍写在 `positions` 里.
#[allow(clippy::too_many_arguments)]
fn sample_surface_values(
    expr: &str,
    coeff_names: &[String],
    coeff_values: &[f64],
    x_min: f64,
    x_max: f64,
    y_min: f64,
    y_max: f64,
    cols: u32,
    rows: u32,
) -> Result<(Vec<f32>, Vec<f64>, f64, f64), String> {
    let z_vals = math_rs::sampling_core::sample_surface_values(
        expr,
        coeff_names,
        coeff_values,
        x_min,
        x_max,
        y_min,
        y_max,
        cols as usize,
        rows as usize,
    )?;

    let total = z_vals.len();
    let mut positions = Vec::with_capacity(total * 3);
    let mut finite_z: Vec<f64> = Vec::with_capacity(total);

    for j in 0..=rows {
        let y = y_min + (y_max - y_min) * (j as f64 / rows as f64);
        for i in 0..=cols {
            let x = x_min + (x_max - x_min) * (i as f64 / cols as f64);
            let z = z_vals[(j * (cols + 1) + i) as usize];

            positions.push(x as f32);
            positions.push(y as f32);
            positions.push(z as f32);

            if z.is_finite() {
                finite_z.push(z);
            }
        }
    }

    let (z_min, z_max) = robust_color_range(&finite_z);

    Ok((positions, z_vals, z_min, z_max))
}

/// 统一编排采样与后处理,保持对 WASM/Worker 的旧入口签名不变.
///
/// 注意:顶点配色(HSL 伪彩色)已移出 CPU 路径,改由渲染侧顶点着色器
/// 依据 `position.z` 与 `(z_min, z_max)` 实时计算,因此这里不再产出 colors.
#[allow(clippy::too_many_arguments)]
pub fn sample_and_process_surface(
    expr: &str,
    coeff_names: &[String],
    coeff_values: &[f64],
    x_min: f64,
    x_max: f64,
    y_min: f64,
    y_max: f64,
    cols: u32,
    rows: u32,
) -> Result<SurfaceSampleResult, String> {
    let (positions, z_vals, z_min, z_max) = sample_surface_values(
        expr,
        coeff_names,
        coeff_values,
        x_min,
        x_max,
        y_min,
        y_max,
        cols,
        rows,
    )?;

    // 先用"单元有效性"过滤(NaN + 渐近线间断),再据此生成索引.
    let cell_valid = compute_valid_cells(
        &z_vals,
        cols as usize,
        rows as usize,
        x_min,
        x_max,
        y_min,
        y_max,
        expr,
        coeff_names,
        coeff_values,
    );
    let valid_indices = generate_valid_indices(cols as usize, rows as usize, &cell_valid);
    let normals = compute_vertex_normals(&positions, &valid_indices);

    Ok(SurfaceSampleResult {
        positions,
        valid_indices,
        normals,
        z_min,
        z_max,
    })
}

// ================================================================
// 顶点法线计算
// ================================================================

/// 根据有效三角形索引计算平滑顶点法线
///
/// 与 Three.js `BufferGeometry.computeVertexNormals()` 的思路一致:
/// 对共享同一顶点的所有三角形面法线做累加,最后归一化
/// 放在 Rust/WASM 中计算,可以避免主线程做 O(顶点数) 的 CPU 遍历
pub fn compute_vertex_normals(positions: &[f32], valid_indices: &[u32]) -> Vec<f32> {
    let mut normals = vec![0.0f32; positions.len()];

    // 第一遍:累加每个三角形对三个顶点的贡献
    for triangle in valid_indices.as_chunks::<3>().0 {
        let ia = triangle[0] as usize;
        let ib = triangle[1] as usize;
        let ic = triangle[2] as usize;

        // 索引理论上都在合法范围内,这里做防御性检查
        if ia >= positions.len() / 3 || ib >= positions.len() / 3 || ic >= positions.len() / 3 {
            continue;
        }

        let a = (
            positions[ia * 3],
            positions[ia * 3 + 1],
            positions[ia * 3 + 2],
        );
        let b = (
            positions[ib * 3],
            positions[ib * 3 + 1],
            positions[ib * 3 + 2],
        );
        let c = (
            positions[ic * 3],
            positions[ic * 3 + 1],
            positions[ic * 3 + 2],
        );

        let abx = b.0 - a.0;
        let aby = b.1 - a.1;
        let abz = b.2 - a.2;
        let acx = c.0 - a.0;
        let acy = c.1 - a.1;
        let acz = c.2 - a.2;

        let nx = aby * acz - abz * acy;
        let ny = abz * acx - abx * acz;
        let nz = abx * acy - aby * acx;

        normals[ia * 3] += nx;
        normals[ia * 3 + 1] += ny;
        normals[ia * 3 + 2] += nz;
        normals[ib * 3] += nx;
        normals[ib * 3 + 1] += ny;
        normals[ib * 3 + 2] += nz;
        normals[ic * 3] += nx;
        normals[ic * 3 + 1] += ny;
        normals[ic * 3 + 2] += nz;
    }

    // 第二遍:归一化,零向量保留为零
    for normal in normals.as_chunks_mut::<3>().0 {
        let x = normal[0];
        let y = normal[1];
        let z = normal[2];
        let length = (x * x + y * y + z * z).sqrt();
        if length > 1e-8 {
            normal[0] = x / length;
            normal[1] = y / length;
            normal[2] = z / length;
        }
    }

    normals
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(expr: &str, coeffs: &[(String, f64)]) -> SurfaceSampleResult {
        let names: Vec<String> = coeffs.iter().map(|(n, _)| n.clone()).collect();
        let values: Vec<f64> = coeffs.iter().map(|(_, v)| *v).collect();
        sample_and_process_surface(expr, &names, &values, -6.0, 6.0, -6.0, 6.0, 64, 64).unwrap()
    }

    #[test]
    fn tan_surface_drops_pole_crossing_cells() {
        // tan(x) 在 x=±π/2, ±3π/2 附近有竖直渐近线:两侧都是有限但巨大的 z
        // 值,跨线单元应被剔除(不再画出贯穿渐近线的"墙"),因此有效三角形
        // 明显少于全量 cols*rows*6.
        let result = run("tan(x * a)", &[("a".to_string(), 1.0)]);
        let cols = 64usize;
        let rows = 64usize;
        let full = cols * rows * 6;
        assert!(result.valid_indices.len() < full, "渐近线单元应被剔除");
        assert_eq!(result.valid_indices.len() % 3, 0);
        // tan(x) 在 [-6,6] 上有 4 条渐近线(±π/2, ±3π/2),每条只剔除跨线的
        // 1 列(64 行 * 6 索引),共 4*64*6 = 1536.这里只校验剔除量"接近但小于
        // 全量",避免把因子/采样噪声锁死为精确值.
        assert!(
            result.valid_indices.len() > full - 8 * rows * 6,
            "剔除量应只集中在渐近线附近,实际有效 {} / 全量 {}",
            result.valid_indices.len(),
            full
        );
    }

    #[test]
    fn smooth_zero_crossing_keeps_all_cells() {
        // `x * e^{-(x²+y²)}` 在 x=0 一整列光滑穿过零.变号边的跳变远超全局
        // 中位跳变(中位数被大片平坦区拉低),若只看"跳变 > 16×中位跳变"就会
        // 把这一列误判成渐近线,在曲面上切出一条方形空洞.
        // 回归来源:example/gauss_surface.miko 里 `derivative dx =
        // derivative(s1, x)` 生成的曲面 dx = ∂/∂x[j·e^{-a(x²+y²)}] 同样是
        // 关于 x 的奇函数,默认 a=0.1 时在 x=0 附近丢过一条方形空洞.
        let result = run("x * exp(-(x ^ 2 + y ^ 2))", &[]);
        let full = 64usize * 64usize * 6;
        assert_eq!(
            result.valid_indices.len(),
            full,
            "光滑过零的曲面不应剔除任何单元"
        );
    }

    #[test]
    fn gaussian_derivative_surface_keeps_all_cells() {
        // 原始报告用例(example/gauss_surface.miko):偏导曲面
        // dx = ∂/∂x[3·e^{-0.1(x²+y²)}],range=[-8,8]² / segments=96.
        // 旧判据只按"跳变 > 16×中位跳变"就会在 x∈[0, 1/6],y∈[-2.5, 2.33]
        // 丢掉 30 个单元,渲染成一条方形空洞.表达式取编译器展开后的原样.
        let result = sample_and_process_surface(
            "-(3 * (2.718281828459045 ^ (-(0.1 * (x ^ 2 + y ^ 2))) * (0.2 * x)))",
            &[],
            &[],
            -8.0,
            8.0,
            -8.0,
            8.0,
            96,
            96,
        )
        .unwrap();
        assert_eq!(
            result.valid_indices.len(),
            96 * 96 * 6,
            "高斯曲面的 x 偏导曲面在过零线上不应出现空洞"
        );
    }

    #[test]
    fn steep_smooth_surface_not_dropped() {
        // 高幅平滑曲面(缩放正弦)即使很陡也不应被误判为间断:全部单元保留.
        // 这是防止"陡峭但连续"被误切的关键回归用例.
        let result = run("a * sin(x)", &[("a".to_string(), 1000.0)]);
        let full = 64usize * 64usize * 6;
        assert_eq!(
            result.valid_indices.len(),
            full,
            "1000·sin(x) 是连续曲面,不应剔除任何单元"
        );
    }

    #[test]
    fn robust_color_range_clamps_asymptote_blowout() {
        // tan(x) 的 z 全量 min/max 会被渐近线附近的巨大值撑到 ±几十;
        // 颜色区间应改用稳健分位数,明显收窄,避免正常区域全是同一个色.
        // 这里用 collect 出全部有限 z 来对比"全量极值"与"分位数区间".
        let names: Vec<String> = vec!["a".to_string()];
        let values: Vec<f64> = vec![1.0];
        let z = math_rs::sampling_core::sample_surface_values(
            "tan(x * a)",
            &names,
            &values,
            -6.0,
            6.0,
            -6.0,
            6.0,
            64,
            64,
        )
        .unwrap();
        let finite: Vec<f64> = z.iter().copied().filter(|v| v.is_finite()).collect();
        let global_min = finite.iter().copied().fold(f64::INFINITY, f64::min);
        let global_max = finite.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let (lo, hi) = robust_color_range(&finite);

        assert!(lo > global_min, "颜色区间下界应高于全量最小(剔除负向尖刺)");
        assert!(hi < global_max, "颜色区间上界应低于全量最大(剔除正向尖刺)");
        assert!(hi > lo, "颜色区间应是一个有意义(非退化)的区间");
        // 全量极值通常被撑到 ±20+;稳健区间应远窄于它.
        assert!(
            (hi - lo) < (global_max - global_min) * 0.5,
            "分位数区间应显著收窄"
        );
    }

    #[test]
    fn robust_color_range_falls_back_when_all_nonfinite() {
        let (lo, hi) = robust_color_range(&[]);
        assert!(lo.is_finite() && hi.is_finite());
        assert!(hi > lo);
    }

    #[test]
    fn smooth_surface_keeps_all_cells() {
        // 平滑平面(或光滑曲面)不应被误切成空洞:所有单元都保留.
        for expr in ["x + y", "x * x + y * y", "x * x * x"] {
            let result = run(expr, &[]);
            let full = 64usize * 64usize * 6;
            assert_eq!(
                result.valid_indices.len(),
                full,
                "{expr} 是光滑曲面,不应剔除任何单元"
            );
        }
    }

    #[test]
    fn nan_surface_still_masks_cells() {
        // sqrt(x) 在 x<0 时 z 为 NaN,这些单元应被剔除(原有 NaN 掩码行为不丢失).
        let result = run("sqrt(x)", &[]);
        let full = 64usize * 64usize * 6;
        assert!(result.valid_indices.len() < full, "NaN 区域单元应剔除");
    }
}
