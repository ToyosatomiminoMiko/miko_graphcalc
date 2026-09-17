//! marching squares 等值线:在参数面片上描出隐式场的零等值线并连成折线.
//!
//! 从 `intersection_core` 拆出(202609 结构整理):这一层只依赖"面片能给点"
//! (见 `patches`)与"隐式场能求值"(见 `geometry_core`),是曲面/体积求交的
//! 公共后端.
//!
//! 两条契约:
//! - 顶点合并见 `VertexPool`:整块面片共用一把尺子,禁止逐点相对量化;
//! - 折线见 `chain_segments`:等值线交叉处断开,渲染侧一条链画一个 Line.

use std::collections::{HashMap, HashSet};

use crate::geometry_core::{FieldEval, ObjectDescriptor};

use super::patches::{build_patches, PatchEval};
use super::{dist, finite, V3};

/// 顶点池合并容差的相对精度:容差 = 该面片点集直径 / VERTEX_QUANTUM
/// (即相对 1e-6),与坐标绝对值无关,场景整体平移/缩放不改变并键结果.
const VERTEX_QUANTUM: f64 = 1e6;

/// marching squares 交叉点的共享顶点池(把"同一几何顶点"合并成一个 id).
///
/// 为什么不能再按"每个点各自的坐标量级"取相对精度(202609 修复):
/// 旧实现 `quantum = VERTEX_QUANTUM / max|该点坐标|` 让每个点用自己的尺子,
/// 于是任何一条过原点,只有一个坐标在变化的交线都会整条塌成一个点--
/// 例如交线 `x = 0, z = 0` 上的所有点都被量化成 `(0, ±VERTEX_QUANTUM, 0)`.
/// 顶点合并后,折线的相邻两点不再是网格内的相邻交叉点,而是在场景两端
/// 各取一个"代表点",于是画出横贯整个曲面的长弦(曲面求交示例里成扇形的
/// 白色错误线条).
///
/// 现在改成"整块面片共用一把尺子":容差 = 面片点集直径 × 相对精度,
/// 仍然平移/缩放无关,但同一个面片里真实不同的顶点不会再并键.
/// 合并用空间哈希 + 邻格精确距离查询,不再依赖坐标落在网格线上的运气.
struct VertexPool {
    /// 格子划分的原点(取面片外接盒最小角):先减原点再量化,格子下标
    /// 只与面片尺度有关,场景整体平移到很大的坐标也不会丢精度.
    origin: V3,
    /// 单元格边长,同时就是合并容差(相对面片尺度).
    tolerance: f64,
    points: Vec<V3>,
    cells: HashMap<(i64, i64, i64), Vec<u32>>,
}

impl VertexPool {
    fn new(origin: V3, tolerance: f64) -> Self {
        Self {
            origin,
            // 退化面片(所有采样点重合)时直径可以是 0:此时容差取最小正数,
            // 行为退化为"只合并完全相等的点",不会把不同点错误并键.
            tolerance: tolerance.max(f64::MIN_POSITIVE),
            points: Vec::new(),
            cells: HashMap::new(),
        }
    }

    fn cell_of(&self, point: V3) -> (i64, i64, i64) {
        let inverse = 1.0 / self.tolerance;
        (
            ((point[0] - self.origin[0]) * inverse).floor() as i64,
            ((point[1] - self.origin[1]) * inverse).floor() as i64,
            ((point[2] - self.origin[2]) * inverse).floor() as i64,
        )
    }

    /// 返回 `point` 的顶点 id:与已有点的距离不超过容差时复用,否则新建.
    ///
    /// 容差等于单元格边长,故距离在容差内的两点最多相差一个格子,
    /// 查 3×3×3 邻格即可覆盖(不必全池扫描).
    fn intern(&mut self, point: V3) -> u32 {
        let cell = self.cell_of(point);
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    let key = (cell.0 + dx, cell.1 + dy, cell.2 + dz);
                    let Some(ids) = self.cells.get(&key) else {
                        continue;
                    };
                    for &id in ids {
                        if dist(self.points[id as usize], point) <= self.tolerance {
                            return id;
                        }
                    }
                }
            }
        }
        let id = self.points.len() as u32;
        self.points.push(point);
        self.cells.entry(cell).or_default().push(id);
        id
    }
}

#[derive(Clone, Copy)]
struct Crossing {
    u: f64,
    v: f64,
}

fn trace_contours(
    patch: &PatchEval,
    field: &mut FieldEval,
    nu: usize,
    nv: usize,
) -> Result<Vec<Vec<V3>>, String> {
    let grid_width = nu + 1;
    let mut values = vec![f64::NAN; grid_width * (nv + 1)];
    let mut valid_flags = vec![false; grid_width * (nv + 1)];
    // 有效采样点的世界坐标外接盒:用来量出"这块面片的几何尺度",
    // 作为顶点池合并容差的基准(见 VertexPool).
    let mut bounds_min = [f64::INFINITY; 3];
    let mut bounds_max = [f64::NEG_INFINITY; 3];

    for j in 0..=nv {
        let v = patch.v0 + ((patch.v1 - patch.v0) * j as f64) / nv as f64;
        for i in 0..=nu {
            let u = patch.u0 + ((patch.u1 - patch.u0) * i as f64) / nu as f64;
            let index = j * grid_width + i;
            let (point, point_valid) = patch.point_valid(u, v);
            let f = match point {
                Some(point) => field.eval(point)?,
                None => None,
            };
            let f = f.unwrap_or(f64::NAN);
            let ok = point_valid && finite(f);
            values[index] = f;
            valid_flags[index] = ok;
            if ok {
                if let Some(point) = point {
                    for axis in 0..3 {
                        bounds_min[axis] = bounds_min[axis].min(point[axis]);
                        bounds_max[axis] = bounds_max[axis].max(point[axis]);
                    }
                }
            }
        }
    }

    // 面片尺度 = 采样点外接盒对角线.用整块面片共用的标度,而不是每个点
    // 各自的坐标量级,否则过原点的直线交线会整条塌成一个点.
    let vertex_tolerance = VERTEX_QUANTUM.recip() * dist(bounds_min, bounds_max);
    let mut pool = VertexPool::new(bounds_min, vertex_tolerance);
    let mut vertex_id = |u: f64, v: f64| -> Option<u32> {
        let p = patch.point(u, v)?;
        Some(pool.intern(p))
    };

    let mut segments: Vec<(u32, u32)> = Vec::new();
    for j in 0..nv {
        for i in 0..nu {
            let i_a = j * grid_width + i;
            let i_b = j * grid_width + i + 1;
            let i_c = (j + 1) * grid_width + i + 1;
            let i_d = (j + 1) * grid_width + i;
            if !valid_flags[i_a] || !valid_flags[i_b] || !valid_flags[i_c] || !valid_flags[i_d] {
                continue;
            }

            let v_a = values[i_a];
            let v_b = values[i_b];
            let v_c = values[i_c];
            let v_d = values[i_d];
            let neg_a = v_a < 0.0;
            let neg_b = v_b < 0.0;
            let neg_c = v_c < 0.0;
            let neg_d = v_d < 0.0;

            let u0 = patch.u0 + ((patch.u1 - patch.u0) * i as f64) / nu as f64;
            let u1 = patch.u0 + ((patch.u1 - patch.u0) * (i + 1) as f64) / nu as f64;
            let v0 = patch.v0 + ((patch.v1 - patch.v0) * j as f64) / nv as f64;
            let v1 = patch.v0 + ((patch.v1 - patch.v0) * (j + 1) as f64) / nv as f64;

            let mut crossings: Vec<Crossing> = Vec::with_capacity(4);
            // 角点符号约定:`< 0` 为负,恰好 0 归入非负.
            //
            // 旧实现在这里对"角点恰好为 0"做了两个特例(推到角点 / 两边都是 0
            // 就跳过),结果同一条边的两个端点会各自把同一个角点压进 crossings,
            // 单元因此可能出现 3 个交叉点(被静默丢弃,交线出现缺口)或出现
            // 一点重复的退化线段.统一符号后,四条边的跨号次数恒为偶数,
            // 只会出现 0 / 2 / 4 个交叉点,且端点恰好为 0 时 t 取 0 或 1,
            // 交叉点精确落在角点上.
            let mut add_crossing = |fa: f64, fb: f64, ua: f64, va: f64, ub: f64, vb: f64| {
                if (fa < 0.0) == (fb < 0.0) {
                    return;
                }
                // 跨号(含端点恰为 0)保证 fa - fb != 0.
                let t = fa / (fa - fb);
                crossings.push(Crossing {
                    u: ua + (ub - ua) * t,
                    v: va + (vb - va) * t,
                });
            };

            add_crossing(v_a, v_b, u0, v0, u1, v0);
            add_crossing(v_b, v_c, u1, v0, u1, v1);
            add_crossing(v_c, v_d, u1, v1, u0, v1);
            add_crossing(v_d, v_a, u0, v1, u0, v0);

            if crossings.len() == 2 {
                push_segment(&mut vertex_id, &mut segments, crossings[0], crossings[1]);
            } else if crossings.len() == 4 {
                let center_neg = (v_a + v_b + v_c + v_d) * 0.25 < 0.0;
                if neg_a == neg_c && neg_b == neg_d && neg_a != neg_b {
                    if neg_a == center_neg {
                        push_segment(&mut vertex_id, &mut segments, crossings[0], crossings[1]);
                        push_segment(&mut vertex_id, &mut segments, crossings[2], crossings[3]);
                    } else {
                        push_segment(&mut vertex_id, &mut segments, crossings[0], crossings[3]);
                        push_segment(&mut vertex_id, &mut segments, crossings[1], crossings[2]);
                    }
                } else {
                    push_segment(&mut vertex_id, &mut segments, crossings[0], crossings[1]);
                    push_segment(&mut vertex_id, &mut segments, crossings[2], crossings[3]);
                }
            }
        }
    }

    // 退化情形(整条网格边恰好落在等值线上)下,相邻两个单元可能各生成一次
    // 同一条线段;先按无向边去重,避免出现假的度为 3 顶点把折线截断.
    let mut seen: HashSet<(u32, u32)> = HashSet::with_capacity(segments.len());
    let segments: Vec<(u32, u32)> = segments
        .into_iter()
        .filter(|&(a, b)| seen.insert(if a < b { (a, b) } else { (b, a) }))
        .collect();

    let chains = chain_segments(&segments);
    let mut contours = Vec::with_capacity(chains.len());
    for chain in chains {
        if chain.len() >= 2 {
            let contour: Vec<V3> = chain
                .into_iter()
                .map(|id| pool.points[id as usize])
                .collect();
            contours.push(contour);
        }
    }
    Ok(contours)
}

fn push_segment(
    vertex_id: &mut impl FnMut(f64, f64) -> Option<u32>,
    segments: &mut Vec<(u32, u32)>,
    first: Crossing,
    second: Crossing,
) {
    if let (Some(first), Some(second)) =
        (vertex_id(first.u, first.v), vertex_id(second.u, second.v))
    {
        // 两端并进同一个顶点说明这条线段的长度已在合并容差以下
        // (极窄的等值线切片):画成自环只会让折线原地折返,直接丢弃.
        if first != second {
            segments.push((first, second));
        }
    }
}

/// 把无向线段集连接成折线(等值线轮廓).
///
/// 连接规则(202609 重写):
/// - **只在度为 2 的顶点继续延伸**.遇到度 ≥ 3 的交点(两条等值线在此
///   交叉,例如 `sin(x)cos(y) = 0` 的 `x = 0` 与 `y = π/2`)就断开:
///   贪心延伸会在交点上拐弯,把本不共线的分支串成一条折线;
/// - 先走度 1 的端点(开链),再走剩下的环(所有顶点度为 2);
///   环回到起点,首尾点相同,渲染为闭合曲线;
/// - 线段集内没有自环(见 [`push_segment`])且已去重,故每条线段只被消费一次.
fn chain_segments(segments: &[(u32, u32)]) -> Vec<Vec<u32>> {
    let mut adjacency: HashMap<u32, Vec<(u32, usize)>> = HashMap::new();
    for (id, (a, b)) in segments.iter().enumerate() {
        adjacency.entry(*a).or_default().push((*b, id));
        adjacency.entry(*b).or_default().push((*a, id));
    }

    let degree = |vertex: u32| adjacency.get(&vertex).map_or(0, Vec::len);
    let mut used = vec![false; segments.len()];
    let mut chains: Vec<Vec<u32>> = Vec::new();

    // 开链:从度 1 的端点出发.端点排序,避免依赖 HashMap 迭代顺序.
    let mut endpoints: Vec<u32> = adjacency
        .iter()
        .filter(|(_, edges)| edges.len() == 1)
        .map(|(vertex, _)| *vertex)
        .collect();
    endpoints.sort_unstable();
    for endpoint in endpoints {
        if adjacency[&endpoint].iter().all(|(_, id)| used[*id]) {
            continue;
        }
        chains.push(walk_chain(&adjacency, &mut used, endpoint, &degree));
    }

    // 剩下的都是环:任取一条未消费线段,沿度 2 的顶点走回起点.
    for id in 0..segments.len() {
        if used[id] {
            continue;
        }
        chains.push(walk_chain(&adjacency, &mut used, segments[id].0, &degree));
    }

    chains
}

/// 从 `start` 出发沿未消费线段前进,直到端点或交点(度 != 2)为止.
fn walk_chain(
    adjacency: &HashMap<u32, Vec<(u32, usize)>>,
    used: &mut [bool],
    start: u32,
    degree: &impl Fn(u32) -> usize,
) -> Vec<u32> {
    let mut chain = vec![start];
    let mut current = start;
    while let Some(edges) = adjacency.get(&current) {
        let Some((next, id)) = edges.iter().find(|(_, id)| !used[*id]) else {
            break;
        };
        used[*id] = true;
        chain.push(*next);
        // 交点上断开:折线不在等值线交叉处拐弯串到另一条分支.
        if degree(*next) != 2 {
            break;
        }
        current = *next;
    }
    chain
}

pub(crate) fn patch_field_intersections(
    patch: &ObjectDescriptor,
    field: &ObjectDescriptor,
    segments: usize,
) -> Result<Vec<Vec<V3>>, String> {
    let mut field_eval = FieldEval::new(field)?;
    let patches = build_patches(patch, segments)?;
    let mut contours = Vec::new();
    for patch_eval in &patches {
        contours.extend(trace_contours(
            patch_eval,
            &mut field_eval,
            segments,
            segments,
        )?);
    }
    Ok(contours)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归:过原点的直线交线曾被顶点池整条塌成一个顶点.
    ///
    /// 旧 `vertex_key` 用"该点自身的坐标量级"做量化,`(0, y, 0)` 上任意 y
    /// 都量化到同一个键;折线的相邻两点于是变成场景两端的代表点,渲染成
    /// 横贯曲面的长弦(曲面求交示例里的扇形错误线条).这里直接量顶点池.
    #[test]
    fn vertex_pool_keeps_points_along_axis_apart() {
        let mut pool = VertexPool::new([0.0, -5.0, 0.0], 1e-6 * 10.0);
        let low = pool.intern([0.0, -4.9, 0.0]);
        let high = pool.intern([0.0, 4.9, 0.0]);
        assert_ne!(low, high, "x = z = 0 直线上的不同顶点被并成了一个");
        // 同一顶点的浮点扰动(远小于容差)仍必须命中同一个顶点.
        assert_eq!(pool.intern([1e-9, -4.9, 0.0]), low);
        // 距离超过容差的点必须另起一个顶点.
        assert_ne!(pool.intern([0.0, -4.9 + 1e-3, 0.0]), low);
    }
}
