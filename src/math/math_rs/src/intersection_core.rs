//! 求交数值内核(原 IntersectionMath.ts 的 Rust 移植).
//!
//! 设计约束:
//! - 表达式只解析一次,上下文只构建一次,后续逐点求值都复用;
//! - 所有坐标均为世界坐标,对象静态 transform 在描述符进入内核前已经附带;
//! - 对象描述是可序列化的枚举数据,不携带跨 WASM 边界的闭包;
//! - marching squares 的鞍点歧义与旧 TS 实现保持一致(中心符号判定).
//!
//! 行为契约:
//! - **所有几何容差都是相对尺度**(随坐标量级缩放:`roots` 的 find_1d_roots /
//!   dedupe_*,`marching_squares` 的顶点池),场景整体缩放到任意量级都不该
//!   改变拓扑--新容差一律相对化,禁止再引入硬编码绝对半径/绝对量化;
//! - segments 规模护栏在 [`compute_pair`] 入口执行(见 config),marching
//!   squares 单元数与 curve×curve 空间候选对都是 O(segments²);
//! - 顶点池合并(VertexPool)与点/根去重语义一致:视作"同一几何顶点"合并,
//!   防止跨单元同一边两侧的浮点差产生缝隙.合并标度必须**整块面片共用**
//!   (面片点集直径),逐点按自身坐标量级取相对精度会把过原点的整条交线
//!   塌成一个顶点,详见 `VertexPool`;
//! - 交线折线是简单链:等值线交叉处(度 != 2 的顶点)断开,闭合环首尾点
//!   相同,见 `chain_segments`.渲染侧把每条链当一个 `Line` 画出,
//!   因此链内相邻两点必须真的是一条网格单元内的线段.
//!
//! 模块边界(2026 架构审查):对象描述符模型/解析与隐式场(FieldEval /
//! SolidProbe / solid_world_aabb)已抽到共享的 [`crate::geometry_core`]--
//! 体积积分(domain_integral / lib.rs::integrate_solid)与求交各取所需,
//! 本模块只保留求交算法(曲线求根/参数化面片/marching squares/顶层编排),
//! 依赖方向为 `domain_integral -> geometry_core ← intersection_core`.
//! 参与方描述仍以 ObjectDescriptor 给出,公开面经 `pub use` 维持.
//!
//! 本模块不直接依赖 wasm-bindgen,便于在 `cargo test` 里做纯 Rust 验证.
//!
//! 子模块划分(202609 结构整理,原来单文件 2000 行):
//! - `patches`:参数化面片(曲面网格 / 球面 / 盒面 / 旋转体);
//! - `curve_intersection`:曲线 ∩ 曲线 / 曲线 ∩ 隐式场;
//! - `marching_squares`:等值线描迹与折线连接;
//! - `pipeline`:组合语义与顶层入口,对外只暴露 `compute_pair` /
//!   `IntersectionCoreOutput`;
//! - `test_support`:`#[cfg(test)]` 描述符构造与输出解码;
//! - 本文件只留模块文档,共享向量小工具转发,以及 `geometry_core` 的转发.
//!
//! 202609 后续整理:一维求根与点/根去重("沿参数扫符号变化找根"这件事本身
//! 与几何无关)已提到 crate 级 [`crate::numeric_core::roots`],与联立的数值
//! 路径共用;这里只做转发,调用方路径不变.

mod curve_intersection;
mod marching_squares;
mod patches;
mod pipeline;

#[cfg(test)]
mod test_support;

use crate::transform_core::{apply_to_point, Mat4};

// ================================================================
// 公开面:geometry_core 转发 + 顶层入口
// ================================================================

/// 对象描述符模型与解析由共享几何层统一提供(求交与体积积分同一口径),
/// 参与方/域仍以 ObjectDescriptor 描述;布局见 [`crate::geometry_core`].
pub use crate::geometry_core::{parse_object_descriptor, ObjectDescriptor, ObjectKind};
/// 顶层入口实现在 `pipeline`,这里转发是为了让 `intersection_core::compute_pair`
/// 这条既有路径不变(lib.rs 的 WASM 皮只认这个名字).
pub use pipeline::{compute_pair, IntersectionCoreOutput};

// ================================================================
// 共享向量小工具:各子模块通过 `super::` 复用,不重复定义
// ================================================================

/// 向量小工具与去重原语统一由 [`crate::numeric_core`] 提供,这里转发给
/// 子模块的 `super::` 路径,避免每个子模块各抄一份.
pub(crate) use crate::numeric_core::{clamp, dist, finite, V3};

fn to_world(matrix: Option<Mat4>, local: V3) -> V3 {
    match matrix {
        Some(matrix) => apply_to_point(matrix, local[0], local[1], local[2]),
        None => local,
    }
}
