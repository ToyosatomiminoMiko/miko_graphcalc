/// 曲面伪彩色映射参数.
///
/// 当前颜色映射是固定的 HSL 方案,先把这些值集中到这里;
/// 后续若需要允许前端覆盖,再把它们变成函数参数或配置结构体.
pub const SURFACE_HUE_START: f64 = 0.66;
pub const SURFACE_SATURATION: f64 = 0.9;
pub const SURFACE_LIGHTNESS_BASE: f64 = 0.5;
pub const SURFACE_LIGHTNESS_RANGE: f64 = 0.3;

/// 所有 z 值都非法时的退化极值.
pub const DEGENERATE_Z_MIN: f64 = 0.0;
pub const DEGENERATE_Z_MAX: f64 = 1.0;

/// 平坦曲面(range == 0)的颜色位置.
pub const FLAT_COLOR_T: f64 = 0.5;

/// 颜色映射 z 区间使用的分位数(低/高).
///
/// 若直接用 z 的全量 min/max,像 `tan(x*a)` 这类曲面在竖直渐近线两侧的巨大
/// 值会把整个色彩区间撑到 ±极大,导致正常区域全挤在一个色上,看不出起伏.
/// 这里改用分位数取"主体区间",让正常区域占满渐变,尖刺部分钳到颜色两端
/// (着色器里 t 已 clamp 到 [0,1]).
pub const COLOR_PERCENTILE_LO: f64 = 0.05;
pub const COLOR_PERCENTILE_HI: f64 = 0.95;

/// 只有当全量区间比分位数区间明显更宽(存在显著尖刺/outlier)时,才回退到
/// 分位数区间;否则保持全量 min/max,避免把光滑曲面也轻微压缩.
pub const COLOR_AUTO_SWITCH_FACTOR: f64 = 3.0;
