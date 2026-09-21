//! 定义域认证:区间算术 + 三值判定.
//!
//! # 这个模块解决什么
//!
//! 曲面采样只能给出**有限个点**上的 z 值."某个网格单元里有没有奇异点"这个
//! 问题,点采样在原理上无法回答:单元四角全有限,内部却有一个小洞的函数
//! (`sqrt(ε² − ((x−x₀)² + (y−y₀)²))`)与"四角全有限且内部处处有定义"的函数
//! 在采样点上完全无法区分.穷举多少点都一样 -- 任何有限点集都能被一个只在该
//! 点集上有定义的函数骗过.
//!
//! 因此这里换一种判据:**对整格做证明**,而不是对点做估计.工具是区间算术:
//! 把坐标区间代进表达式,得到函数值的一个**包含**区间;只要每一层子表达式的
//! 定义域约束都被区间证据满足(除法分母区间不含 0,`sqrt`/`ln` 实参区间合法
//! ......),就证明了整格处处有定义.结论是"证明"不是"猜测",因此不会漏判.
//!
//! # 三值判定
//!
//! 每个区间额外带一个 [`Certainty`]:
//! - `Everywhere`:整个盒上都有定义,且值域落在 `[lo, hi]` 内(可认证);
//! - `Partial`:盒内一部分有定义,一部分没有(定义域边界/极点穿过该盒);
//! - `Nowhere`:整个盒都落在定义域之外.
//!
//! 传播规则:`Nowhere` 支配一切(某个子表达式整格无定义,则整个表达式整格
//! 无定义),`Partial` 支配 `Everywhere`.这个规则让**绝大多数格子一次判定就
//! 结束**:完全在定义域外的格子立刻得到 `Nowhere`,不需要细分.
//!
//! # 自适应细分
//!
//! `Partial` 格子按四分递归细分,深度上限 [`CERTIFY_SUBDIVISION_DEPTH`]:
//! 细分能挽回的是**区间算术自身的保守**(dependency problem,例如 `sqrt(x−x+1)`
//! 的 `x−x` 给出 `[−h,h]` 把 0 包了进去,细分后 `h` 减半即可证明);
//! 挽回不了的是真实的边界/极点 -- 那种格子细到最后仍是 `Partial`,认作无效.
//!
//! 代价必须说清楚:**认证只能证明"有定义",不能证明"无定义"**.边界与极点
//! 所在的格子一律不出三角形,所以定义域边界上永远留一条宽度为一个网格步长的
//! 缺失带(极点两侧各一格).这是判据保守性的代价,不是 bug;换来的是
//! "参与绘制的每个三角形都在定义域内部(不含奇异点)"这条可证的保证.
//!
//! # 与求值层的关系
//!
//! 认证必须与 `symbolic::eval::real_pow` 的**定义域语义**一致(负底数的奇
//! 分母有理指数有实值,`0^0 = 1`,`0^负指数` 发散 ...),否则会出现"认证通过,
//! 逐点求值给 NaN"的矛盾 -- 那正是本模块要消灭的东西.相关规则在
//! [`pow_interval`] 一处的注释里逐条对照.
//!
//! 更完整的成因清单(四条非有限通路),A/B 实测数字与两条有意保留的边界,
//! 见 `docs/surface-nan-audit.md`.
//!
//! 编码注意:区间扩张只允许**放宽**(over-approximate).任何不确定的情形都
//! 必须落到 `Partial`/`Nowhere`,绝不能"猜一个更窄的区间" -- 放宽只丢几何,
//! 收窄会把奇异点放进来.

use std::f64::consts::{FRAC_PI_2, PI, TAU};

use crate::builtins::IntervalOp;
use crate::config::{CERTIFY_SUBDIVISION_DEPTH, MAX_GRID_N};
use crate::eval_core::CompiledEvaluator;
use crate::integral_core::validate_2d_interval;
use crate::integral_method::{cell_end_at, CellEnd};
use crate::symbolic::{odd_denominator_rational, BinOp, BoundExpr, SymBinding};

/// 一个盒子上的定义域确定程度(三值格,见模块头).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Certainty {
    /// 整盒处处有定义.
    Everywhere,
    /// 盒内一部分有定义,一部分没有.
    Partial,
    /// 整盒都没有定义.
    Nowhere,
}

/// 区间值 + 定义域确定程度.
///
/// `certainty != Everywhere` 时 `lo/hi` 无意义(置 NaN,误用会立刻暴露).
#[derive(Clone, Copy, Debug)]
struct Interval {
    lo: f64,
    hi: f64,
    certainty: Certainty,
}

/// 两个确定程度的合并:`Nowhere` 支配 `Partial`,两者都支配 `Everywhere`.
///
/// 依据:复合表达式只在**所有**子表达式都有定义的点上有定义,所以任一子表达式
/// 整盒无定义 -> 整个表达式整盒无定义.
fn combine(left: Certainty, right: Certainty) -> Certainty {
    match (left, right) {
        (Certainty::Nowhere, _) | (_, Certainty::Nowhere) => Certainty::Nowhere,
        (Certainty::Partial, _) | (_, Certainty::Partial) => Certainty::Partial,
        _ => Certainty::Everywhere,
    }
}

/// 取一组候选值的最小/最大值.
///
/// 任一分量为 NaN 时返回 `(NaN, NaN)`:这是区间算术**自身**溢出(而不是函数
/// 无定义)的信号,调用方 [`Interval::bounded`] 会把它放宽成全体实数.
fn min_max(values: &[f64]) -> (f64, f64) {
    if values.iter().any(|value| value.is_nan()) {
        return (f64::NAN, f64::NAN);
    }
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for value in values {
        if *value < lo {
            lo = *value;
        }
        if *value > hi {
            hi = *value;
        }
    }
    (lo, hi)
}

impl Interval {
    /// 单点区间(常量,系数,精确坐标).
    fn point(value: f64) -> Self {
        Self {
            lo: value,
            hi: value,
            certainty: Certainty::Everywhere,
        }
    }

    /// 带确定程度的"无值"区间.
    fn undefined(certainty: Certainty) -> Self {
        debug_assert_ne!(
            certainty,
            Certainty::Everywhere,
            "undefined() 只接受 Partial/Nowhere"
        );
        Self {
            lo: f64::NAN,
            hi: f64::NAN,
            certainty,
        }
    }

    /// 有界区间.
    ///
    /// `lo/hi` 出现 NaN 说明区间算术自己溢出了(`inf − inf`,`0 · inf`),
    /// 这**不等于**函数无定义:例如 `x·x − x·x` 在 `x` 巨大时中间量溢出,
    /// 但表达式处处有定义.此时放宽到 `(−∞, +∞)`:信息变少,但结论仍然可靠,
    /// 且不会把有定义的格子误判成无定义.
    fn bounded(lo: f64, hi: f64) -> Self {
        if lo.is_nan() || hi.is_nan() {
            return Self {
                lo: f64::NEG_INFINITY,
                hi: f64::INFINITY,
                certainty: Certainty::Everywhere,
            };
        }
        debug_assert!(lo <= hi, "区间下界大于上界:{lo} > {hi}");
        Self {
            lo,
            hi,
            certainty: Certainty::Everywhere,
        }
    }

    /// 一元单调**递增**函数的区间像(用于 atan/sinh/tanh/exp/cbrt 等).
    fn monotone(self, function: fn(f64) -> f64) -> Self {
        match self.certainty {
            Certainty::Everywhere => Self::bounded(function(self.lo), function(self.hi)),
            certainty => Self::undefined(certainty),
        }
    }

    /// 二元运算的公共骨架:任一操作数非 `Everywhere` 时整格结论直接由
    /// [`combine`] 决定,不再计算值域.
    fn binary_with(
        self,
        other: Self,
        compute: impl FnOnce(f64, f64, f64, f64) -> (f64, f64),
    ) -> Self {
        match combine(self.certainty, other.certainty) {
            Certainty::Everywhere => {
                let (lo, hi) = compute(self.lo, self.hi, other.lo, other.hi);
                Self::bounded(lo, hi)
            }
            certainty => Self::undefined(certainty),
        }
    }

    fn neg(self) -> Self {
        match self.certainty {
            Certainty::Everywhere => Self::bounded(-self.hi, -self.lo),
            certainty => Self::undefined(certainty),
        }
    }

    fn add(self, other: Self) -> Self {
        self.binary_with(other, |a, b, c, d| (a + c, b + d))
    }

    fn sub(self, other: Self) -> Self {
        self.binary_with(other, |a, b, c, d| (a - d, b - c))
    }

    fn mul(self, other: Self) -> Self {
        self.binary_with(other, |a, b, c, d| min_max(&[a * c, a * d, b * c, b * d]))
    }

    /// 区间除法.
    ///
    /// 除数区间含 0 时**不能**给出值域(商发散),按定义域语义落 `Partial`;
    /// 除数恒为 0 时整格无定义,落 `Nowhere`.这两条正是 `1/x`,`tan(x)` 这类
    /// 竖直渐近线被剔除的根据 -- 不需要任何"跳变倍数"经验阈值.
    fn div(self, other: Self) -> Self {
        match combine(self.certainty, other.certainty) {
            Certainty::Everywhere => {}
            certainty => return Self::undefined(certainty),
        }
        if other.lo <= 0.0 && other.hi >= 0.0 {
            return if other.lo == 0.0 && other.hi == 0.0 {
                Self::undefined(Certainty::Nowhere)
            } else {
                Self::undefined(Certainty::Partial)
            };
        }
        let (lo, hi) = min_max(&[
            self.lo / other.lo,
            self.lo / other.hi,
            self.hi / other.lo,
            self.hi / other.hi,
        ]);
        Self::bounded(lo, hi)
    }
}

/// 区间 `[lo, hi]` 内是否存在 `phase + k·period`(k 为整数).
///
/// 用于 sin/cos 的极值判定(它们是周期函数,端点值不一定是极值).
/// 边界上的浮点舍入宁可判"存在":判存在只会放宽值域,不影响可靠性.
fn contains_phase(lo: f64, hi: f64, phase: f64, period: f64) -> bool {
    let k = ((lo - phase) / period).ceil();
    phase + k * period <= hi
}

fn sin_interval(arg: Interval) -> Interval {
    if arg.hi - arg.lo >= TAU {
        return Interval::bounded(-1.0, 1.0);
    }
    let (mut lo, mut hi) = min_max(&[arg.lo.sin(), arg.hi.sin()]);
    if contains_phase(arg.lo, arg.hi, FRAC_PI_2, TAU) {
        hi = 1.0;
    }
    if contains_phase(arg.lo, arg.hi, -FRAC_PI_2, TAU) {
        lo = -1.0;
    }
    Interval::bounded(lo, hi)
}

fn cos_interval(arg: Interval) -> Interval {
    if arg.hi - arg.lo >= TAU {
        return Interval::bounded(-1.0, 1.0);
    }
    let (mut lo, mut hi) = min_max(&[arg.lo.cos(), arg.hi.cos()]);
    if contains_phase(arg.lo, arg.hi, 0.0, TAU) {
        hi = 1.0;
    }
    if contains_phase(arg.lo, arg.hi, PI, TAU) {
        lo = -1.0;
    }
    Interval::bounded(lo, hi)
}

/// `asin`/`acos` 的公共定义域检查:实参必须整体落在 `[-1, 1]` 内.
fn arcsin_domain(arg: Interval) -> Option<Interval> {
    if arg.lo < -1.0 || arg.hi > 1.0 {
        return Some(if arg.hi < -1.0 || arg.lo > 1.0 {
            Interval::undefined(Certainty::Nowhere)
        } else {
            Interval::undefined(Certainty::Partial)
        });
    }
    None
}

/// `ln`/`log10`/`log2` 的公共定义域检查:实参必须整体为正.
fn log_interval(arg: Interval, function: fn(f64) -> f64) -> Interval {
    if arg.hi <= 0.0 {
        return Interval::undefined(Certainty::Nowhere);
    }
    if arg.lo <= 0.0 {
        return Interval::undefined(Certainty::Partial);
    }
    Interval::bounded(function(arg.lo), function(arg.hi))
}

fn sqrt_interval(arg: Interval) -> Interval {
    if arg.hi < 0.0 {
        return Interval::undefined(Certainty::Nowhere);
    }
    if arg.lo < 0.0 {
        return Interval::undefined(Certainty::Partial);
    }
    Interval::bounded(arg.lo.sqrt(), arg.hi.sqrt())
}

fn cosh_interval(arg: Interval) -> Interval {
    if arg.lo >= 0.0 {
        return Interval::bounded(arg.lo.cosh(), arg.hi.cosh());
    }
    if arg.hi <= 0.0 {
        return Interval::bounded(arg.hi.cosh(), arg.lo.cosh());
    }
    // 跨越 0:极小值 1 在 0 处取到,极大值在离 0 更远的端点.
    Interval::bounded(1.0, arg.lo.abs().max(arg.hi.abs()).cosh())
}

fn abs_interval(arg: Interval) -> Interval {
    let hi = arg.lo.abs().max(arg.hi.abs());
    let lo = if arg.lo <= 0.0 && arg.hi >= 0.0 {
        0.0
    } else {
        arg.lo.abs().min(arg.hi.abs())
    };
    Interval::bounded(lo, hi)
}

fn sign_interval(arg: Interval) -> Interval {
    // 求值层在 u = 0 处显式返回 NaN(该点符号无定义,见 builtins 的 sign 登记),
    // 所以含 0 的实参区间一律不可认证.
    if arg.lo > 0.0 {
        return Interval::point(1.0);
    }
    if arg.hi < 0.0 {
        return Interval::point(-1.0);
    }
    if arg.lo == 0.0 && arg.hi == 0.0 {
        return Interval::undefined(Certainty::Nowhere);
    }
    Interval::undefined(Certainty::Partial)
}

/// 一元内置函数的区间扩张(`IntervalOp` -> 区间语义的唯一实现处).
fn apply_unary(op: IntervalOp, arg: Interval) -> Interval {
    if arg.certainty != Certainty::Everywhere {
        return Interval::undefined(arg.certainty);
    }
    match op {
        IntervalOp::Sin => sin_interval(arg),
        IntervalOp::Cos => cos_interval(arg),
        // tan = sin/cos:极点就是"cos 区间含 0",直接由 div 的定义域语义给出
        // Partial/Nowhere,不需要另写一套 π/2 + kπ 的周期判定.
        IntervalOp::Tan => sin_interval(arg).div(cos_interval(arg)),
        IntervalOp::Asin => match arcsin_domain(arg) {
            Some(verdict) => verdict,
            None => Interval::bounded(arg.lo.asin(), arg.hi.asin()),
        },
        IntervalOp::Acos => match arcsin_domain(arg) {
            Some(verdict) => verdict,
            None => Interval::bounded(arg.hi.acos(), arg.lo.acos()),
        },
        IntervalOp::Atan => arg.monotone(f64::atan),
        IntervalOp::Sinh => arg.monotone(f64::sinh),
        IntervalOp::Cosh => cosh_interval(arg),
        IntervalOp::Tanh => arg.monotone(f64::tanh),
        IntervalOp::Exp => arg.monotone(f64::exp),
        IntervalOp::Ln => log_interval(arg, f64::ln),
        IntervalOp::Log10 => log_interval(arg, f64::log10),
        IntervalOp::Log2 => log_interval(arg, f64::log2),
        IntervalOp::Sqrt => sqrt_interval(arg),
        IntervalOp::Cbrt => arg.monotone(f64::cbrt),
        IntervalOp::Abs => abs_interval(arg),
        IntervalOp::Sign => sign_interval(arg),
    }
}

/// 区间幂.
///
/// 与 [`crate::symbolic::eval`] 的 `real_pow` 逐条对齐,因为认证结论必须与
/// 逐点求值的定义域完全一致:
/// 1. **整数指数**(含负整数):全体实数上有定义;`0^负指数` 发散,含 0 的
///    盒子判 `Partial`,只在 0 这一点时判 `Nowhere`;
/// 2. **奇分母有理指数**(如 `1/3`,`2/3`):`real_pow` 对负底也给实值,
///    符号由约分后分子奇偶决定,所以全体实数上有定义;
/// 3. **其它非整数指数**:只有 `base >= 0` 有实值;
/// 4. **指数是一个区间**:只有 `base` 严格为正才能整盒下结论;负底区间里必然
///    含有非奇分母有理数的指数(无理数),那些点求值为 NaN,所以整盒无效.
fn pow_interval(base: Interval, exponent: Interval) -> Interval {
    match combine(base.certainty, exponent.certainty) {
        Certainty::Everywhere => {}
        certainty => return Interval::undefined(certainty),
    }

    let point_exponent = if exponent.lo == exponent.hi {
        Some(exponent.lo)
    } else {
        None
    };

    if let Some(value) = point_exponent {
        if value.is_finite() && value.fract() == 0.0 && value.abs() <= i32::MAX as f64 {
            return integer_pow(base, value as i32);
        }
        if value.is_finite() {
            if let Some((numerator, _denominator)) = odd_denominator_rational(value) {
                return odd_rational_pow(base, value, numerator);
            }
        }
        // 非整数且非奇分母有理数:仅 base >= 0 有实值.
        if base.lo >= 0.0 {
            return positive_pow(base, exponent);
        }
        return if base.hi < 0.0 {
            Interval::undefined(Certainty::Nowhere)
        } else {
            Interval::undefined(Certainty::Partial)
        };
    }

    if base.lo >= 0.0 {
        // base.lo == 0 的情形由 positive_pow 再判 `0^负指数`.
        return positive_pow(base, exponent);
    }
    if base.hi < 0.0 {
        return Interval::undefined(Certainty::Nowhere);
    }
    Interval::undefined(Certainty::Partial)
}

/// `base >= 0` 且指数任意:逐角取值(正底上 `bᵉ` 对每个变量分别单调,
/// 极值必在角点),再把 `0^正指数 = 0` 补成下界.
fn positive_pow(base: Interval, exponent: Interval) -> Interval {
    if base.lo <= 0.0 && exponent.lo < 0.0 {
        // 0^负指数发散(求值层得 inf -> 判 None):整盒不可认证.
        return Interval::undefined(Certainty::Partial);
    }
    let (mut lo, hi) = min_max(&[
        base.lo.powf(exponent.lo),
        base.lo.powf(exponent.hi),
        base.hi.powf(exponent.lo),
        base.hi.powf(exponent.hi),
    ]);
    if base.lo <= 0.0 && exponent.lo > 0.0 {
        lo = 0.0;
    }
    Interval::bounded(lo, hi)
}

/// 整数指数幂(`real_pow` 走 `powf`,整数指数对负底也有实值).
fn integer_pow(base: Interval, exponent: i32) -> Interval {
    if exponent == 0 {
        return Interval::point(1.0);
    }
    if exponent < 0 && base.lo <= 0.0 && base.hi >= 0.0 {
        return if base.lo == 0.0 && base.hi == 0.0 {
            Interval::undefined(Certainty::Nowhere)
        } else {
            Interval::undefined(Certainty::Partial)
        };
    }
    let mut candidates = vec![base.lo.powi(exponent), base.hi.powi(exponent)];
    // 偶次幂在 0 处取到最小值,两个端点可能都更大.
    if exponent % 2 == 0 && base.lo < 0.0 && base.hi > 0.0 {
        candidates.push(0.0);
    }
    let (lo, hi) = min_max(&candidates);
    Interval::bounded(lo, hi)
}

/// 奇分母有理指数幂:`real_pow` 语义为
/// `b ≥ 0 -> bᵉ`,`b < 0 -> (−1)^m · |b|ᵉ`(m 为约分后分子).
fn odd_rational_pow(base: Interval, exponent: f64, numerator: i64) -> Interval {
    let negative_sign = if numerator % 2 == 0 { 1.0 } else { -1.0 };
    let value_at = |value: f64| {
        if value >= 0.0 {
            value.powf(exponent)
        } else {
            negative_sign * value.abs().powf(exponent)
        }
    };
    if exponent < 0.0 && base.lo <= 0.0 && base.hi >= 0.0 {
        return Interval::undefined(Certainty::Partial);
    }
    let mut candidates = vec![value_at(base.lo), value_at(base.hi)];
    if exponent > 0.0 && base.lo < 0.0 && base.hi > 0.0 {
        candidates.push(0.0);
    }
    let (lo, hi) = min_max(&candidates);
    Interval::bounded(lo, hi)
}

/// 2D 曲面语境下的坐标槽区间.
fn coordinate_interval(slot: u8, x: Interval, y: Interval) -> Interval {
    match slot {
        0 => x,
        1 => y,
        // 曲面(eval_2d)不覆写 z 槽:逐点求值读出构造期的 NaN,掩码语义下
        // 等价于"该点无定义",这里对应整盒无定义.
        _ => Interval::undefined(Certainty::Nowhere),
    }
}

/// 一元算子在实数轴上是否**恒有定义**(穷尽枚举 [`IntervalOp`]).
///
/// 新增区间算子时这个 `match` 会编译失败,强制在这里表态是"全域"还是
/// "定义域受限" -- 这是防止"加了新函数却忘了标 partial"的编译期保险.
fn unary_is_total(op: IntervalOp) -> bool {
    match op {
        // 定义域受限:tan 有极点,sign 在 0 处无定义,
        // 其余见各自在 [`apply_unary`] 里的定义域检查.
        IntervalOp::Tan
        | IntervalOp::Asin
        | IntervalOp::Acos
        | IntervalOp::Ln
        | IntervalOp::Log10
        | IntervalOp::Log2
        | IntervalOp::Sqrt
        | IntervalOp::Sign => false,
        // 全实轴有定义(是否溢出 f64 是另一回事,由采样侧闸门管).
        IntervalOp::Sin
        | IntervalOp::Cos
        | IntervalOp::Atan
        | IntervalOp::Sinh
        | IntervalOp::Cosh
        | IntervalOp::Tanh
        | IntervalOp::Exp
        | IntervalOp::Cbrt
        | IntervalOp::Abs => true,
    }
}

/// 是否"字面量正整指数"(`x^2` 这种,`x^0.5`/`x^(-2)`/`x^y` 都不算).
fn is_positive_integer_literal(node: &BoundExpr) -> bool {
    matches!(
        node,
        BoundExpr::Num(value) if value.is_finite() && *value > 0.0 && value.fract() == 0.0
    )
}

/// 表达式在**整个 ℝ²** 上是否恒有定义(结构判定,不看数值).
///
/// 用途:恒有定义的表达式没有任何奇异点,[`certify_surface_cells`] 里逐格
/// 做区间证明就是空转.短路在数学上与逐格证明**等价**(逐格证明的结论也全是
/// `true`),只是把常见光滑曲面的认证代价降到 O(1).
///
/// 判定必须**保守**:拿不准就返回 `false`,让它走逐格证明.唯一的"松"处是
/// `x ^ 正整数`(整数指数幂对负底也有定义),这是 `real_pow` 的既有语义.
fn is_total(node: &BoundExpr) -> bool {
    match node {
        BoundExpr::Num(_) => true,
        BoundExpr::Sym(binding) => match binding {
            SymBinding::Unbound(_) => false,
            // 曲面(2D)不覆写 z 槽:求值层会报"变量未定义",认证必须走慢路径
            // 把这个错误报出来,不能在短路里当成"恒有定义".
            SymBinding::CoordOrUnbound(slot, _) => *slot < 2,
            _ => true,
        },
        BoundExpr::Neg(operand) => is_total(operand),
        BoundExpr::Binary(op, left, right) => {
            let operands_total = is_total(left) && is_total(right);
            match op {
                BinOp::Add | BinOp::Sub | BinOp::Mul => operands_total,
                // 分母可能为 0.
                BinOp::Div => false,
                // 幂:只有正整数字面量指数才恒有定义.
                BinOp::Pow => operands_total && is_positive_integer_literal(right),
            }
        }
        BoundExpr::Call(_function, op, arg) => is_total(arg) && unary_is_total(*op),
        // 这两个在求值层就是错误:不在短路里下结论,交给 evaluate_box 报错.
        BoundExpr::UnsupportedCall(_) | BoundExpr::ListNotEvaluable => false,
    }
}

/// 按**盒**解释预绑定表达式树(与 `evaluate_bound` 的按点解释同构).
///
/// 错误文案与逐点求值保持一致:`Err` 只用于"表达式本身不合法"(未绑定变量,
/// 元数错误),与"定义域外"这种正常数值结论分开.
fn evaluate_box(
    node: &BoundExpr,
    coefficients: &[f64],
    x: Interval,
    y: Interval,
) -> Result<Interval, String> {
    Ok(match node {
        BoundExpr::Num(value) => Interval::point(*value),
        BoundExpr::Sym(binding) => match binding {
            SymBinding::Constant(value) => Interval::point(*value),
            SymBinding::Coord(slot) => coordinate_interval(*slot, x, y),
            SymBinding::Coefficient(index) => Interval::point(coefficients[*index]),
            SymBinding::CoordOrCoefficient(slot, index) => {
                if *slot < 2 {
                    coordinate_interval(*slot, x, y)
                } else {
                    Interval::point(coefficients[*index])
                }
            }
            SymBinding::CoordOrUnbound(slot, name) => {
                if *slot < 2 {
                    coordinate_interval(*slot, x, y)
                } else {
                    return Err(format!("变量 '{name}' 未定义"));
                }
            }
            SymBinding::Unbound(name) => return Err(format!("变量 '{name}' 未定义")),
        },
        BoundExpr::Neg(operand) => evaluate_box(operand, coefficients, x, y)?.neg(),
        BoundExpr::Binary(op, left, right) => {
            let left = evaluate_box(left, coefficients, x, y)?;
            let right = evaluate_box(right, coefficients, x, y)?;
            match op {
                BinOp::Add => left.add(right),
                BinOp::Sub => left.sub(right),
                BinOp::Mul => left.mul(right),
                BinOp::Div => left.div(right),
                BinOp::Pow => pow_interval(left, right),
            }
        }
        BoundExpr::Call(_function, interval_op, arg) => {
            apply_unary(*interval_op, evaluate_box(arg, coefficients, x, y)?)
        }
        BoundExpr::UnsupportedCall(name) => {
            return Err(format!("函数 {name} 只接受 1 个参数,当前收到 0 个"));
        }
        BoundExpr::ListNotEvaluable => return Err("不能直接对数组表达式求值".to_string()),
    })
}

/// 递归判定一个闭盒是否处处有定义.
///
/// `Partial` 时按四分细分;任一子盒判否立即返回(短路),因此真实边界/极点
/// 附近的代价是"几次求值"而不是 `4^depth` -- 只有区间算术自身的 dependency
/// 问题才会真正走到细分深处.
fn certify_box(
    node: &BoundExpr,
    coefficients: &[f64],
    x_lo: f64,
    x_hi: f64,
    y_lo: f64,
    y_hi: f64,
    depth: u32,
) -> Result<bool, String> {
    let verdict = evaluate_box(
        node,
        coefficients,
        Interval::bounded(x_lo, x_hi),
        Interval::bounded(y_lo, y_hi),
    )?;
    match verdict.certainty {
        Certainty::Everywhere => Ok(true),
        Certainty::Nowhere => Ok(false),
        Certainty::Partial => {
            if depth == 0 {
                return Ok(false);
            }
            let x_mid = (x_lo + x_hi) / 2.0;
            let y_mid = (y_lo + y_hi) / 2.0;
            let quadrants = [
                (x_lo, x_mid, y_lo, y_mid),
                (x_mid, x_hi, y_lo, y_mid),
                (x_lo, x_mid, y_mid, y_hi),
                (x_mid, x_hi, y_mid, y_hi),
            ];
            for (xa, xb, ya, yb) in quadrants {
                if !certify_box(node, coefficients, xa, xb, ya, yb, depth - 1)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
    }
}

/// 逐单元认证 `z = f(x, y)` 在闭合单元上是否**处处有定义**.
///
/// 返回长度 `nx * ny` 的行优先掩码(外层 y,内层 x,与
/// [`crate::sampling_core::sample_surface_values`] 的单元切片同序):
/// `true` 表示已证明该单元不含任何无定义点,可以安全出三角形.
///
/// 非有限值不会出现在结论里:值域溢出 `f64` 的盒子仍然算"有定义"
/// (数学上 `exp` 处处有定义),它由采样侧的有限性闸门另行处理.
#[allow(clippy::too_many_arguments)]
pub fn certify_surface_cells(
    expr: &str,
    coeff_names: &[String],
    coeff_values: &[f64],
    x_min: f64,
    x_max: f64,
    y_min: f64,
    y_max: f64,
    nx: usize,
    ny: usize,
) -> Result<Vec<bool>, String> {
    validate_2d_interval((x_min, x_max), (y_min, y_max))?;
    if nx == 0 || ny == 0 {
        return Err("曲面认证需要 nx/ny 均大于 0".to_string());
    }
    if nx > MAX_GRID_N || ny > MAX_GRID_N {
        return Err(format!("采样网格每轴步数超过上限 {MAX_GRID_N}"));
    }

    // 与采样层共用同一套"编译 + 绑定系数"逻辑,只是解释方式从点换成盒.
    let evaluator = CompiledEvaluator::new(expr, coeff_names, coeff_values)?;
    let node = evaluator.bound_node();
    let coefficients = evaluator.coefficient_values();

    // 恒有定义的表达式没有奇异点:逐格证明是空转,直接全通过.
    if is_total(node) {
        return Ok(vec![true; nx * ny]);
    }

    let mut cells = Vec::with_capacity(nx * ny);
    for j in 0..ny {
        let y_lo = cell_end_at(CellEnd::MinCorner, y_min, y_max, ny, j);
        let y_hi = cell_end_at(CellEnd::MaxCorner, y_min, y_max, ny, j);
        for i in 0..nx {
            let x_lo = cell_end_at(CellEnd::MinCorner, x_min, x_max, nx, i);
            let x_hi = cell_end_at(CellEnd::MaxCorner, x_min, x_max, nx, i);
            cells.push(certify_box(
                node,
                coefficients,
                x_lo,
                x_hi,
                y_lo,
                y_hi,
                CERTIFY_SUBDIVISION_DEPTH,
            )?);
        }
    }
    Ok(cells)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 对单个盒求区间结论(测试用).
    fn certify(expr: &str, x: (f64, f64), y: (f64, f64)) -> bool {
        certify_surface_cells(expr, &[], &[], x.0, x.1, y.0, y.1, 1, 1)
            .unwrap()
            .pop()
            .unwrap()
    }

    #[test]
    fn total_expressions_certify_immediately() {
        // 处处有定义的表达式:一次判定就通过,与区间宽窄无关.
        for expr in [
            "x + y",
            "x * x + y * y",
            "x ^ 3",
            "sin(x) * cos(y)",
            "exp(-(x^2 + y^2))",
        ] {
            assert!(certify(expr, (-3.0, 5.0), (-1.0, 2.0)), "{expr} 应整盒认证");
        }
    }

    #[test]
    fn division_by_zero_interval_is_not_certified() {
        // 分母区间含 0 -> 盒内有极点 -> 不可认证.
        assert!(!certify("1 / x", (-1.0, 1.0), (0.0, 1.0)));
        // 分母区间不含 0 -> 可认证.
        assert!(certify("1 / x", (0.5, 1.5), (0.0, 1.0)));
        // 分母恒为 0 -> 整盒无定义.
        assert!(!certify("1 / (x - x)", (0.5, 1.5), (0.0, 1.0)));
    }

    #[test]
    fn square_root_domain_is_respected() {
        assert!(certify("sqrt(x)", (0.0, 2.0), (0.0, 1.0)));
        assert!(!certify("sqrt(x)", (-2.0, -1.0), (0.0, 1.0)));
        // 跨越定义域边界:不可认证(细分到深度上限仍是 Partial).
        assert!(!certify("sqrt(x)", (-0.5, 0.5), (0.0, 1.0)));
    }

    #[test]
    fn logarithm_domain_is_respected() {
        assert!(certify("ln(x)", (0.5, 2.0), (0.0, 1.0)));
        assert!(!certify("ln(x)", (-2.0, -1.0), (0.0, 1.0)));
        assert!(!certify("ln(x)", (0.0, 1.0), (0.0, 1.0)));
        assert!(certify("log10(x) + log2(y)", (0.5, 2.0), (0.5, 2.0)));
    }

    #[test]
    fn tangent_pole_is_detected_by_cosine_interval() {
        // tan 的极点:cos 区间含 0.π/2 ≈ 1.5708.
        assert!(!certify("tan(x)", (1.5, 1.6), (0.0, 1.0)));
        // 同一支内的正常区间可认证.
        assert!(certify("tan(x)", (0.0, 1.0), (0.0, 1.0)));
        assert!(certify("tan(x)", (2.0, 3.0), (0.0, 1.0)));
    }

    #[test]
    fn integer_powers_accept_negative_bases() {
        // `x^2` 在负底上当然有定义:整数指数不能被当成"非整数指数"误杀.
        assert!(certify("x ^ 2", (-2.0, 3.0), (0.0, 1.0)));
        assert!(certify("x ^ 3", (-2.0, 3.0), (0.0, 1.0)));
        // 负整数指数在含 0 的盒上发散.
        assert!(!certify("x ^ (-2)", (-1.0, 1.0), (0.0, 1.0)));
        assert!(certify("x ^ (-2)", (1.0, 2.0), (0.0, 1.0)));
    }

    #[test]
    fn odd_rational_powers_accept_negative_bases() {
        // (-8)^(1/3) = -2:real_pow 对负底给实值,认证必须与之一致.
        assert!(certify("x ^ (1 / 3)", (-8.0, 8.0), (0.0, 1.0)));
        // 1/2 是偶分母:负底无实值,跨越 0 的盒不可认证.
        assert!(!certify("x ^ (1 / 2)", (-1.0, 4.0), (0.0, 1.0)));
        assert!(certify("x ^ (1 / 2)", (0.0, 4.0), (0.0, 1.0)));
    }

    #[test]
    fn dependency_problem_is_resolved_by_subdivision() {
        // `x - x + 1` 恒为 1,但朴素区间扩张给出 [1-h, 1+h]:细分裂到
        // h < 1 之后必须能证明它处处有定义(否则自适应细分就白做了).
        assert!(certify("sqrt(x - x + 1)", (0.0, 8.0), (0.0, 0.25)));
    }

    #[test]
    fn sign_is_undefined_at_zero_but_fine_away_from_it() {
        assert!(certify("sign(x)", (0.5, 1.0), (0.0, 1.0)));
        assert!(certify("sign(x)", (-1.0, -0.5), (0.0, 1.0)));
        assert!(!certify("sign(x)", (-0.5, 0.5), (0.0, 1.0)));
    }

    #[test]
    fn inverse_trig_domain_is_respected() {
        assert!(certify("asin(x)", (-1.0, 1.0), (0.0, 1.0)));
        assert!(!certify("asin(x)", (-2.0, 2.0), (0.0, 1.0)));
        assert!(!certify("asin(x)", (-3.0, -2.0), (0.0, 1.0)));
        assert!(certify("acos(y)", (-1.0, 1.0), (-1.0, 1.0)));
    }

    #[test]
    fn grid_mask_is_row_major_and_shaped_like_cell_slice() {
        // 2×1 网格:x 轴上一半在 sqrt 定义域外.
        let mask = certify_surface_cells("sqrt(x)", &[], &[], -2.0, 2.0, 0.0, 1.0, 2, 1).unwrap();
        assert_eq!(mask.len(), 2);
        assert!(!mask[0], "x ∈ [-2,0] 该被拒");
        assert!(mask[1], "x ∈ [0,2] 该通过");
    }

    /// 结构判定必须保守:任何"可能无定义"的运算都不许被当成全域.
    #[test]
    fn totality_analysis_is_conservative() {
        fn total_of(expr: &str) -> bool {
            let evaluator = CompiledEvaluator::new(expr, &[], &[]).unwrap();
            is_total(evaluator.bound_node())
        }

        for expr in [
            "x + y",
            "x ^ 3",
            "x ^ 2 + y ^ 2",
            "sin(x) * cos(y)",
            "exp(-(x ^ 2 + y ^ 2))",
            "atan(x) + cbrt(y) + abs(x)",
            "sinh(x) - tanh(y) + cosh(x)",
        ] {
            assert!(total_of(expr), "{expr} 应判为恒有定义");
        }

        for expr in [
            "1 / x",
            "sqrt(x)",
            "ln(x)",
            "log10(x)",
            "asin(x)",
            "acos(x)",
            "tan(x)",
            "sign(x)",
            "x ^ 0.5",
            "x ^ (-2)",
            "x ^ y",
            "x ^ (1 / 3)",
            "2.718281828459045 ^ (-(x ^ 2))",
        ] {
            assert!(!total_of(expr), "{expr} 不应被判为恒有定义");
        }
    }

    /// 短路与逐格证明必须给出同一个结论:恒有定义的表达式在全网格上全通过.
    #[test]
    fn total_shortcut_matches_full_certification() {
        let mask = certify_surface_cells(
            "sin(x) * cos(y) + x ^ 2",
            &[],
            &[],
            -3.0,
            3.0,
            -3.0,
            3.0,
            8,
            8,
        )
        .unwrap();
        assert_eq!(mask, vec![true; 64]);
    }

    #[test]
    fn invalid_intervals_and_sizes_are_reported() {
        assert!(certify_surface_cells("x", &[], &[], 1.0, 1.0, 0.0, 1.0, 4, 4).is_err());
        assert!(certify_surface_cells("x", &[], &[], 0.0, 1.0, 0.0, 1.0, 0, 4).is_err());
        assert!(certify_surface_cells("y + 1", &[], &[], 0.0, 1.0, 0.0, 1.0, 2, 2).is_ok());
    }
}
