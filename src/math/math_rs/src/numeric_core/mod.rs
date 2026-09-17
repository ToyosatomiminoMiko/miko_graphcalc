//! 共享数值原语(crate 级):线性消元,一维求根与去重,非线性方程组 Newton.
//!
//! ## 为什么单独成层
//!
//! 202609 的统一口径把"求解 / 求交 / 联立"看成同一件事的不同形状(见
//! [`crate::solve_core`]):它们共享的**不是算法**,而是底层数值原语.
//! 这些原语原先散在 `symbolic::linalg`(部分分式消元)与
//! `intersection_core::roots`(曲线求交的一维求根与去重)里,各自都能被第三个
//! 消费方(联立方程组)复用,所以提到 crate 级:
//!
//! - [`linalg`]:小规模稠密高斯消元(线性方程组精确解的底座);
//! - [`roots`]:沿一维区间扫符号变化找根 + 点/根去重(容差按几何自身尺度缩放);
//! - [`newton`]:方阵非线性方程组的阻尼 Newton 与盒域多起点扫描.
//!
//! 依赖方向:`symbolic` 与 `intersection_core` 都可以依赖本层;本层**不**
//! 依赖它们(只用 `transform_core` 之外什么都不用),因此不会成环.
//!
//! 未使用的项按需保留:`linalg` 的调用方是 `symbolic::integral` 与
//! `symbolic::system`, `roots` 的调用方是 `intersection_core`,
//! `newton` 的调用方是 `solve_core` 的联立数值路径.

pub(crate) mod linalg;
pub(crate) mod newton;
pub(crate) mod roots;

/// 三维点.求交与联立的解点都用它;与 `intersection_core` 的既有别名同型.
pub(crate) type V3 = [f64; 3];

pub(crate) fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(crate) fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn dist(a: V3, b: V3) -> f64 {
    sub(a, b).iter().map(|v| v * v).sum::<f64>().sqrt()
}

pub(crate) fn midpoint(a: V3, b: V3) -> V3 {
    [
        (a[0] + b[0]) * 0.5,
        (a[1] + b[1]) * 0.5,
        (a[2] + b[2]) * 0.5,
    ]
}

pub(crate) fn clamp(value: f64, lo: f64, hi: f64) -> f64 {
    value.max(lo).min(hi)
}

pub(crate) fn finite(value: f64) -> bool {
    value.is_finite()
}
