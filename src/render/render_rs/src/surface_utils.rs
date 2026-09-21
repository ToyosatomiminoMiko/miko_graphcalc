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
//                 (x,y,z 扁平 f32,经 saturate_to_f32 钳进 f32 有限区间)
//                 并统计 z_min/z_max -- 只统计有限 z,
//                 若全部非法则回退 DEGENERATE_Z_MIN/Z_MAX(见 config.rs)
//              ② math_rs::interval_core::certify_surface_cells()
//                                              整格定义域认证
//                 与①共用同一棵绑定树,把每个单元的坐标区间代入表达式做
//                 区间算术,证明"整格处处有定义".判据是三值的:整格有定义
//                 (可绘制)/ 整格在定义域外 / 一部分有定义(边界或极点穿过,
//                 按四分自适应细分,仍证不出就不绘制).
//                 这取代了旧版的"跳变中位数 + 经验倍数 + 边中点重采样"
//                 启发式:那套判据只看有限个点,原理上抓不到落在格子内部的
//                 极点,且阈值(16 倍,2 倍)与采样密度耦合;区间认证给的是
//                 证明.代价是定义域边界上留一条一个网格步宽的缺失带.
//              ③ compute_valid_cells()       无效单元过滤
//                 一个单元在以下情况不参与绘制(与关系):
//                   · 任一顶点 z 为非有限--主要挡 f64 溢出(认证会说
//                     "处处有定义",但采样值已不可用),同时防止 NaN 面法线
//                     经顶点平均污染相邻正常三角形;
//                   · 未被②认证为整格有定义--`tan(x*a)`,`1/(x-a)` 这类
//                     竖直渐近线两侧都是"有限但巨大"的 z 值,不产生 NaN,
//                     只有整格证明才能把它们挡在几何之外.
//              ④ generate_valid_indices()    网格索引
//                 只对有效单元出两个三角形,每格拆 (a,b,d)+(a,d,c);
//                 无效单元不产出任何索引,这才是真正参与绘制的几何.
//              ⑤ compute_vertex_normals()   平滑法线
//                 对共享顶点累加三角形面法线再归一化,与 Three.js
//                 BufferGeometry.computeVertexNormals() 语义一致;
//                 放在 WASM 做,避免主线程 O(顶点数) 遍历.
//                 中间量走 f64:只要顶点有限(由 saturate_to_f32 保证),
//                 f64 路径上不可能溢出,因此不会出现 `Inf − Inf = NaN`.
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
// 非有限(NaN)三角形的四条成因,各自修在哪,以及两条**有意保留**的边界
// (定义域边界的一格缺失带,一维曲线仍是跳变启发式),连同 A/B 实测数字,
// 见 docs/surface-nan-audit.md.改动本文件的顶点/法线写出路径前请先读它.
//
// 同步约束:config.rs 中的配色常量(SURFACE_HUE_START / SURFACE_SATURATION /
// SURFACE_LIGHTNESS_BASE / SURFACE_LIGHTNESS_RANGE / FLAT_COLOR_T)必须与
// surfaceColorMap.ts 内嵌的 GLSL 常量保持一致 -- 改任一侧都要同步另一侧.
// ================================================================
use crate::config::{
    COLOR_AUTO_SWITCH_FACTOR, COLOR_PERCENTILE_HI, COLOR_PERCENTILE_LO, DEGENERATE_Z_MAX,
    DEGENERATE_Z_MIN,
};

/// f32 的最大有限值 `(2−2⁻²³)·2¹²⁷ ≈ 3.4028235e38`.
///
/// 写成"从 f32 取"而不是字面量,保证与目标平台的 f32::MAX 逐位一致.
const F32_FINITE_MAX: f64 = f32::MAX as f64;

/// 把 f64 投影到 f32 的**可表示有限区间** `±F32_FINITE_MAX`.
///
/// # 为什么必须在写出的那个类型上设闸门
///
/// `f64 as f32` **不保有限**:任何绝对值大于 [`F32_FINITE_MAX`] 的有限 f64
/// 都会变成 `f32::INFINITY`.旧版只在 f64 上判 `z.is_finite()`,于是
/// `exp(x^2+y^2)` 在 (10,10) 处的 e²⁰⁰ ≈ 7.2e86(f64 有限)顺利过闸,
/// 写进 positions 就成了 Inf -- 这正是"采样层非有限值"之外的第二条
/// 非有限顶点通路,闸门漏掉了它.
///
/// # 为什么是饱和而不是丢格
///
/// `clamp` 是**单调保序投影**:有限进,有限出,±∞ 映到 ±`f32::MAX`,
/// NaN 保持 NaN(NaN 顶点所在单元由 [`compute_valid_cells`] 剔除,语义不变).
/// 饱和不改变单元有效性,所以不会在极点/溢出区额外制造空洞;"丢格"则会
/// 把本可连续逼近的极限面变成破洞.饱和后的几何仍是单调的,视觉上是一根
/// 封顶尖刺,与 [`robust_color_range`] 对颜色尖刺"钳到两端"的处理同源.
///
/// 注意:这只保证**有限**,不保证**尺度可看**.若 z 全量被撑到 1e30,
/// 场景尺度仍会被包围盒拉爆 -- 那是"几何 z 区间"的问题,与 NaN 无关.
fn saturate_to_f32(value: f64) -> f32 {
    value.clamp(-F32_FINITE_MAX, F32_FINITE_MAX) as f32
}

/// 逐单元判断是否可参与绘制.
///
/// 两个条件是**与**关系,各自挡住一类"不能出三角形"的理由:
///
/// **① 任一顶点 z 为非有限(保留,勿删).**
///
/// `z_values` 里的 NaN 有两个来源:求值层的定义域外掩码,以及 `f64` 溢出
/// (`exp(x²+y²)` 在 |x|,|y| 较大时直接越过 `f64` 上限).定义域那一类已由
/// ② 覆盖,这里主要挡**溢出** -- 它与定义域无关,区间认证会如实判"处处有
/// 定义",但采样值已经不再是一个可用的高度.
///
/// 另外,含 NaN 顶点的三角形其面法线是 NaN,而 [`compute_vertex_normals`] 把
/// 面法线按共享顶点累加,NaN 会顺着顶点平均扩散到整片相邻的正常三角形.
/// 所以这条闸门同时是"不让非有限值进入几何"的最后一道.
///
/// **② 该单元未被区间认证为"整格有定义"**
/// (见 [`math_rs::interval_core::certify_surface_cells`]).
///
/// `tan(x*a)`,`1/(x-a)` 这类竖直渐近线两侧都是"有限但巨大"的 z 值,不产生
/// NaN;只看顶点有限性的话,跨线单元会被画成一堵贯穿渐近线的"墙".判据从
/// "跳变比中位数大多少倍"这类经验阈值换成了**对整格的证明**:把坐标区间代入
/// 表达式做区间算术,只要除法分母区间不含 0,`sqrt`/`ln` 的实参区间合法,
/// 就证明了整格处处有定义.证明不了的格子(定义域边界,极点,区间算术过于
/// 保守)一律不出三角形.
///
/// 两条判据的分工是"点"与"整格":① 只看 4 个角,便宜且能挡住溢出;
/// ② 看整个单元,能挡住落在格子内部的极点 -- 那是任何有限点采样都抓不到的.
fn compute_valid_cells(
    z_values: &[f64],
    cols: usize,
    rows: usize,
    certified: &[bool],
) -> Vec<bool> {
    debug_assert_eq!(certified.len(), cols * rows);
    let width = cols + 1;
    let mut valid = Vec::with_capacity(cols * rows);
    for j in 0..rows {
        for i in 0..cols {
            let corners = [
                z_values[j * width + i],
                z_values[j * width + i + 1],
                z_values[(j + 1) * width + i],
                z_values[(j + 1) * width + i + 1],
            ];
            valid.push(corners.iter().all(|z| z.is_finite()) && certified[j * cols + i]);
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

            // 三个分量都过 f32 饱和闸门:x/y 来自用户区间,同样可能超出 f32
            // 范围(如 range = ±1e40),不能只防 z.
            positions.push(saturate_to_f32(x));
            positions.push(saturate_to_f32(y));
            positions.push(saturate_to_f32(z));

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

    // 先做"整格有定义"的区间认证(math_rs 侧,与采样共用同一棵绑定树),
    // 再叠加顶点有限性闸门(挡溢出),据此生成索引.
    let certified = math_rs::interval_core::certify_surface_cells(
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
    let cell_valid = compute_valid_cells(&z_vals, cols as usize, rows as usize, &certified);
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
///
/// # 中间量用 f64 是"法线不可能非有限"的证明前提
///
/// 顶点有限性已由 [`saturate_to_f32`] 保证(positions 中每个分量都是有限
/// f32).在此前提下:
/// - 两个有限 f32 之差绝对值 `< 2^129`;
/// - 叉积分量是两数之积,`< 2^258`;
/// - 规则网格里每个顶点至多被 6 个有效三角形共享,累加 `< 2^261`.
///
/// 而 f64 的有限上界约 `2^1024`,余量约 700 个二进制数量级.所以**只要顶点
/// 有限,f64 路径上不可能产生 Inf,也就不可能出现 `Inf − Inf = NaN`**.
/// 归一化后结果落在 `[-1,1]`,转回 f32 无损.
///
/// 旧版直接在 f32 里做叉积与累加:两个 1e30 量级的边分量相乘即 `inf`,
/// 再相减就是 NaN,而 NaN 会经顶点平均扩散到整片相邻三角形 --
/// 文件头注释担心的正是这条扩散路径,但采样层的 NaN 闸门管不到它.
pub fn compute_vertex_normals(positions: &[f32], valid_indices: &[u32]) -> Vec<f32> {
    let vertex_count = positions.len() / 3;
    let mut accum = vec![0.0f64; positions.len()];

    // 第一遍:累加每个三角形对三个顶点的贡献(f64 精度)
    for triangle in valid_indices.as_chunks::<3>().0 {
        let ia = triangle[0] as usize;
        let ib = triangle[1] as usize;
        let ic = triangle[2] as usize;

        // 索引理论上都在合法范围内,这里做防御性检查
        if ia >= vertex_count || ib >= vertex_count || ic >= vertex_count {
            continue;
        }

        let a = (
            positions[ia * 3] as f64,
            positions[ia * 3 + 1] as f64,
            positions[ia * 3 + 2] as f64,
        );
        let b = (
            positions[ib * 3] as f64,
            positions[ib * 3 + 1] as f64,
            positions[ib * 3 + 2] as f64,
        );
        let c = (
            positions[ic * 3] as f64,
            positions[ic * 3 + 1] as f64,
            positions[ic * 3 + 2] as f64,
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

        accum[ia * 3] += nx;
        accum[ia * 3 + 1] += ny;
        accum[ia * 3 + 2] += nz;
        accum[ib * 3] += nx;
        accum[ib * 3 + 1] += ny;
        accum[ib * 3 + 2] += nz;
        accum[ic * 3] += nx;
        accum[ic * 3 + 1] += ny;
        accum[ic * 3 + 2] += nz;
    }

    // 第二遍:归一化并写回 f32.
    //
    // 零长度**不能留成零向量**:GLSL 的 `normalize(vec3(0.0))` 是 0/0 = NaN,
    // 会把"Rust 侧全是有限值"的努力在着色器里重新变回 NaN 法线.这里给一个
    // 稳定兜底方向 (0,0,1).真正参与绘制的顶点必然属于某个 xy 面内非退化
    // 的网格三角形,其累加向量非零,拿不到兜底;拿到它的只有未被任何有效
    // 三角形引用的顶点(NaN 顶点,被剔除单元独占的顶点),不参与绘制.
    let mut normals = vec![0.0f32; positions.len()];
    for (index, normal) in accum.as_chunks::<3>().0.iter().enumerate() {
        let x = normal[0];
        let y = normal[1];
        let z = normal[2];
        let length = (x * x + y * y + z * z).sqrt();
        let (ux, uy, uz) = if length > 1e-8 {
            (x / length, y / length, z / length)
        } else {
            (0.0, 0.0, 1.0)
        };
        normals[index * 3] = ux as f32;
        normals[index * 3 + 1] = uy as f32;
        normals[index * 3 + 2] = uz as f32;
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
    fn tan_surface_drops_exactly_the_pole_cells() {
        // tan(x) 在 x=±π/2, ±3π/2 有竖直渐近线:两侧都是有限但巨大的 z 值,
        // 跨线单元必须剔除(否则被画成一堵贯穿渐近线的"墙").
        //
        // 判据换成区间认证后,这里可以断言**精确**的剔除量:`tan = sin/cos`,
        // cos 区间含 0 的格子才无效,而 [-6,6] 上 4 条渐近线各自严格落在
        // 某一列之内(不在格线上),所以恰好剔除 4 列 = 4*64*6 个索引,
        // 与阈值/采样密度无关.旧版靠"跳变 > 16×中位跳变",只能断言一个
        // 宽松区间.
        let result = run("tan(x * a)", &[("a".to_string(), 1.0)]);
        let cols = 64usize;
        let rows = 64usize;
        let full = cols * rows * 6;
        assert_eq!(result.valid_indices.len() % 3, 0);
        assert_eq!(
            result.valid_indices.len(),
            full - 4 * rows * 6,
            "应恰好剔除 4 条渐近线所在的 4 列"
        );
    }

    #[test]
    fn smooth_zero_crossing_keeps_all_cells() {
        // `x * e^{-(x²+y²)}` 在 x=0 一整列光滑穿过零.变号边的跳变远超全局
        // 中位跳变(中位数被大片平坦区拉低),旧的"跳变倍数"判据会把这一列
        // 误判成渐近线,在曲面上切出一条方形空洞.
        // 现在的判据不看跳变:整个表达式处处有定义(exp 全实轴有定义,无除法,
        // 无根号),区间认证一次通过所有格子,与"变号"彻底无关.
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
        // 丢掉 30 个单元,渲染成一条方形空洞.表达式取编译器展开后的原样:
        // 底数是正常量 2.718...(正底),指数是区间,认证走 positive_pow,
        // 与 x 是否变号无关,因此全部单元保留.
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

    /// 区间认证独有的能力:极点落在**格子内部**时,任何有限点采样都抓不到,
    /// 区间算术能证明该格含奇异点.
    ///
    /// `1/((x−0.5)² + (y−0.5)² − 1e−4)` 在 (0.5, 0.5) 周围有一圈半径 0.01 的
    /// 极点(分母为 0).64×64 网格下这个圆完全落在第 34 列/第 34 行的单元
    /// 内部:该单元四个角的分母都显著为正(≈0.0312,0.0077),z 有限且同号,
    /// 旧启发式(顶点 NaN + 边跳变 vs 中位跳变 + 边中点重采样)看不到任何
    /// 异常,会把整格画成一道贯穿极点的"墙".区间认证只要看到分母区间含 0
    /// 就判该格无效 -- 不需要采样点恰好落在圆上.
    #[test]
    fn interior_pole_circle_inside_one_cell_is_dropped() {
        let segments = 64usize;
        let cols = segments;
        let result = sample_and_process_surface(
            "1 / ((x - 0.5) ^ 2 + (y - 0.5) ^ 2 - 0.0001)",
            &[],
            &[],
            -6.0,
            6.0,
            -6.0,
            6.0,
            segments as u32,
            segments as u32,
        )
        .unwrap();

        let full = segments * segments * 6;
        let dropped = (full - result.valid_indices.len()) / 6;
        assert_eq!(dropped, 1, "只应剔除含极点圆的那一个单元,实际 {dropped} 个");

        // 逐三角形取首索引即可唯一标识所属单元(每格出 [a,b,d] 与 [a,d,c],
        // 两段的首索引都是该单元的 a 角 = j*(cols+1)+i).不能直接对
        // valid_indices 查"某个顶点在不在":顶点被相邻单元共享,查不出归属.
        let drawn_cells: std::collections::HashSet<u32> = result
            .valid_indices
            .as_chunks::<3>()
            .0
            .iter()
            .map(|triangle| triangle[0])
            .collect();
        // 0.5 落在第 34 个单元(单元宽 12/64 = 0.1875)里.
        let pole_cell = (34 * (cols + 1) + 34) as u32;
        let neighbour_cell = (33 * (cols + 1) + 33) as u32;
        assert!(
            !drawn_cells.contains(&pole_cell),
            "含极点圆的单元 (34,34) 未被剔除"
        );
        assert!(
            drawn_cells.contains(&neighbour_cell),
            "相邻正常单元 (33,33) 不应被误剔"
        );
    }

    /// 定义域是圆盘:圆外的格子由**整格证明**拒绝,不是靠"角上是否 NaN".
    /// `sqrt(1 − x² − y²)` 的实参是连续的,圆内为正,圆外为负,认证对每一格
    /// 给出三值结论,边界带(证明不出的那一圈)按设计不绘制.
    #[test]
    fn disk_domain_is_certified_cell_by_cell() {
        let result = run("sqrt(1 - x * x - y * y)", &[]);
        let cells = result.valid_indices.len() / 6;
        // 半径 1 的圆盘面积 π ≈ 3.1416;单元面积 (12/64)² = 0.0352.
        // 完全落在圆内的格子约 π/0.0352 ≈ 89,再减去边界一格的环形带
        // (周长/步长 ≈ 2π/0.1875 ≈ 33),剩 ~56.给一个宽区间,只锁"确实
        // 画出了圆盘内部,且远少于全部 4096 格".
        assert!(
            (20..200).contains(&cells),
            "圆盘内部格子数不合理:{cells}(全量 4096)"
        );
    }

    #[test]
    fn nan_surface_still_masks_cells() {
        // sqrt(x) 在 x<0 时 z 为 NaN,这些单元应被剔除(原有 NaN 掩码行为不丢失).
        let result = run("sqrt(x)", &[]);
        let full = 64usize * 64usize * 6;
        assert!(result.valid_indices.len() < full, "NaN 区域单元应剔除");
    }

    /// 通路②回归:有限 f64 但超出 f32 范围的 z,不得以 Inf 形式进入 positions.
    ///
    /// `exp(x²+y²)` 在角落 (10,10) 处 = e²⁰⁰ ≈ 7.2e86:f64 完全有限,但远超
    /// `f32::MAX ≈ 3.4e38`.旧闸门只在 f64 上判 `is_finite()`,于是这里会写进
    /// `f32::INFINITY`,再经面法线的 `Inf − Inf` 变成 NaN 并扩散.
    #[test]
    fn finite_f64_beyond_f32_range_never_becomes_infinite_vertex() {
        let segments = 32usize;
        let result = sample_and_process_surface(
            "exp(x ^ 2 + y ^ 2)",
            &[],
            &[],
            -10.0,
            10.0,
            -10.0,
            10.0,
            segments as u32,
            segments as u32,
        )
        .unwrap();

        assert!(
            result.positions.iter().all(|v| v.is_finite()),
            "positions 里出现非有限顶点:f64->f32 溢出闸门失效"
        );
        assert!(
            result.normals.iter().all(|v| v.is_finite()),
            "normals 里出现非有限值"
        );
        // exp 处处有定义,不应因此丢掉任何单元(饱和不等于丢格).
        assert_eq!(
            result.valid_indices.len(),
            segments * segments * 6,
            "溢出只应饱和,不应改变单元有效性"
        );
    }

    /// x/y 来自用户区间,同样可能超出 f32 范围,闸门必须一视同仁.
    #[test]
    fn out_of_f32_range_axes_saturate_instead_of_overflowing() {
        let result =
            sample_and_process_surface("x + y", &[], &[], -1e40, 1e40, -1e40, 1e40, 8, 8).unwrap();

        assert!(
            result.positions.iter().all(|v| v.is_finite()),
            "x/y 轴超出 f32 范围时仍写入了非有限顶点"
        );
        assert!(result.normals.iter().all(|v| v.is_finite()));
    }

    /// 通路③回归:边长 1e30 的三角形在 f32 里叉积即溢出为 Inf,`Inf − Inf`
    /// 得 NaN.几何上它的法线就是 (0,0,1),必须算得出来且有限.
    #[test]
    fn vertex_normals_survive_coordinates_whose_cross_overflows_f32() {
        let positions = [0.0f32, 0.0, 0.0, 1e30, 0.0, 0.0, 0.0, 1e30, 0.0];
        let normals = compute_vertex_normals(&positions, &[0, 1, 2]);

        assert!(
            normals.iter().all(|v| v.is_finite()),
            "大坐标下的面法线溢出:f32 累加未被搬到 f64,normals = {normals:?}"
        );
        for normal in normals.as_chunks::<3>().0 {
            assert!(
                (normal[2].abs() - 1.0).abs() < 1e-6,
                "xy 平面内三角形的法线应为 (0,0,±1),实际 {normal:?}"
            );
        }
    }

    /// 通路④:零累加向量不能留成零向量 -- GLSL 的 `normalize(vec3(0.0))`
    /// 是 0/0 = NaN,会把 NaN 重新塞回着色器.
    #[test]
    fn unreferenced_vertices_get_a_fallback_normal_not_zero() {
        let positions = [0.0f32; 9];
        let normals = compute_vertex_normals(&positions, &[]);

        assert!(normals.iter().all(|v| v.is_finite()));
        for normal in normals.as_chunks::<3>().0 {
            assert_eq!(*normal, [0.0, 0.0, 1.0]);
        }
    }
}
