//! 数值内核的全局可调参数与输入规模护栏(唯一配置收口).
//!
//! 行为契约:
//! - 影响数学语义的容差/边界值集中在这里,不在算法分支里内联数字;
//! - wasm/JSON 进入的 n/m/layers/segments 等"规模参数"一律先过这里的上限,
//!   避免一次请求触发 n³ 级分配或 O(steps²) 扫描(内存/时间护栏).
//!   正常 UI 取值远低于这些上限;越界是调用方 bug,报错而不是截断.

/// 勒贝格积分中把正/负部视为"可忽略"的零值阈值.
pub const LEBESGUE_ZERO_EPSILON: f64 = 1e-12;

/// 每轴网格步数上限:1D/2D rectangle/region 采样(内存 O(n·m) 级).
pub const MAX_GRID_N: usize = 4096;

/// 3D solid 每轴格数上限:C1 体元样本与可视化样本都是 O(n³),
/// 该上限用于给 n³ 分配一个内存护栏.
pub const MAX_SOLID_N: usize = 256;

/// 勒贝格分层上限:每层都要按单元数扫描一次,代价 O(layers × cells).
pub const MAX_LEBESGUE_LAYERS: usize = 16384;

/// 曲线采样最大点数(曲线渲染 / 一维采样).
pub const MAX_CURVE_SAMPLES: usize = 200_000;

/// 三维向量场采样总点数上限 nx·ny·nz(每点输出 3 个 f32).
pub const MAX_VECTOR_FIELD_POINTS: usize = 8_000_000;

/// 求交 / 等值线网格 segments 上限:marching squares 的单元数是
/// O(segments²) × 面片数,curve×curve 空间路径另有 O(segments²) 候选对.
pub const MAX_INTERSECTION_SEGMENTS: usize = 1024;
