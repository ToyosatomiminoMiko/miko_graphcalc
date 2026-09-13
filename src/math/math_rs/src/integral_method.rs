//! 积分方法语义表的唯一来源.
//!
//! 之前 `lib.rs`(IntegralMethod1D/IntegralMethod2D),`domain_integral.rs`
//! (DomainMethod)各写一份"方法字符串 -> 枚举"的 parse,`sampling_core.rs`
//! 又用裸字符串穿行采样形状--同一张"方法 -> 采样端"契约被复制了三次,
//! 二维 rectangle 的 lebesgue 就是这么坏的(采样侧与消费侧各说各话).
//!
//! 这里收口成一份共享枚举与一份共享"方法 -> 单元采样端"映射:
//! - 方法名 parse 只有一份,与 TS 侧名单 `INTEGRAL_METHOD_NAMES`
//!   (compiler/ir/types.ts)保持同一套语义名--Rust parse 表与 TS 名单是
//!   唯二的事实来源,加方法必须两处同步;
//! - `cell_end` 是方法在网格单元上的采样端语义(region/solid 网格,
//!   2D 端点黎曼,lebesgue 左端点格子都用它);
//! - `cell_end_at` 是"采样端 -> 坐标"的唯一映射(202609 审查收口,
//!   之前 region/solid 各自手写三份 match),各调用点一律复用;
//! - `SampleShape` 是采样层实际需要的"整格 / 单元端"形态,跨模块用枚举
//!   传递,不再用 `&str` 靠注释维持契约.

/// 每个网格单元的采样端位置(数值与可视化同源).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CellEnd {
    /// 单元左下/最小角(左端点/勒贝格左端点格子约定).
    MinCorner,
    /// 单元右上/最大角.
    MaxCorner,
    /// 单元中心.
    Center,
}

/// 第 `index`(0..n)个单元在该采样端语义下的代表坐标,区间为 [lo, hi].
///
/// region/solid 的网格采样与 2D 端点黎曼共用这一份"单元端 -> 坐标"映射;
/// 禁止在各调用点手写三份 match(历史上五处复制导致过一次端不一致).
/// 调用方需保证 n > 0 且 index < n(各入口已校验 n > 0).
pub(crate) fn cell_end_at(end: CellEnd, lo: f64, hi: f64, n: usize, index: usize) -> f64 {
    let h = (hi - lo) / n as f64;
    match end {
        CellEnd::MinCorner => lo + index as f64 * h,
        CellEnd::MaxCorner => lo + (index + 1) as f64 * h,
        CellEnd::Center => lo + (index as f64 + 0.5) * h,
    }
}

/// 采样函数实际产出哪种数组形态.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SampleShape {
    /// 含端点的整格:1D 取 n+1 个点;2D 取 (n+1)×(m+1) 个点.
    Grid,
    /// 每单元取最小角(2D 左下):n×m 个值.
    LeftCell,
    /// 每单元取最大角(2D 右上):n×m 个值.
    RightCell,
    /// 每单元取中心:1D n 个中点,2D n×m 个中点.
    MidCell,
}

impl SampleShape {
    /// 供 TS 渲染层识别的形状标签(见 IntegralWorker 的 sampleShape 名单).
    pub fn tag_1d(self) -> &'static str {
        match self {
            SampleShape::MidCell => "1d-mid",
            _ => "1d-grid",
        }
    }

    pub fn tag_2d(self) -> &'static str {
        match self {
            SampleShape::Grid => "2d-grid",
            SampleShape::LeftCell => "2d-corner",
            SampleShape::RightCell => "2d-corner-right",
            SampleShape::MidCell => "2d-mid2",
        }
    }
}

/// 域积分数值规则(语义名与 IR `IntegralMethod` 一致).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IntegralMethod {
    Trapz,
    Simpson,
    RiemannLeft,
    RiemannRight,
    RiemannMid,
    Lebesgue,
}

impl IntegralMethod {
    /// 方法字符串 -> 枚举.全站(1D/2D/region/solid)唯一 parse 入口.
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "trapezoid" => Ok(Self::Trapz),
            "simpson" => Ok(Self::Simpson),
            "riemann:left" => Ok(Self::RiemannLeft),
            "riemann:right" => Ok(Self::RiemannRight),
            "riemann:mid" => Ok(Self::RiemannMid),
            "lebesgue" => Ok(Self::Lebesgue),
            _ => Err(format!("未知积分方法: {raw}")),
        }
    }

    /// IR 语义名(与 TS `IntegralMethod` 字符串一致).
    pub fn semantic_name(self) -> &'static str {
        match self {
            Self::Trapz => "trapezoid",
            Self::Simpson => "simpson",
            Self::RiemannLeft => "riemann:left",
            Self::RiemannRight => "riemann:right",
            Self::RiemannMid => "riemann:mid",
            Self::Lebesgue => "lebesgue",
        }
    }

    /// 该方法的"网格单元采样端"语义.
    ///
    /// - 黎曼左端点与 lebesgue:单元最小角(勒贝格按"左端点代表格子"计测度);
    /// - 黎曼右端点:单元最大角;
    /// - 其余(中点黎曼 / 梯形 / 辛普森):单元中心.
    ///
    /// 2D rectangle 的端点黎曼与 lebesgue,region/solid 的网格法都从这张
    /// 表取端;1D 的 left/right/lebesgue 因 from-values 核只消费含端点整格,
    /// 另见 [`IntegralMethod::sample_shape_1d`].
    pub fn cell_end(self) -> CellEnd {
        match self {
            Self::RiemannLeft | Self::Lebesgue => CellEnd::MinCorner,
            Self::RiemannRight => CellEnd::MaxCorner,
            Self::RiemannMid | Self::Trapz | Self::Simpson => CellEnd::Center,
        }
    }

    /// 1D 采样形态:除中点黎曼取 n 个单元中点外,一律取含端点整格 n+1 个点
    /// (left/right/lebesgue 由 from-values 核按左/右端点消费).
    pub fn sample_shape_1d(self) -> SampleShape {
        match self {
            Self::RiemannMid => SampleShape::MidCell,
            _ => SampleShape::Grid,
        }
    }

    /// 2D(rectangle 域)采样形态:trapezoid/simpson 消费整格
    /// (n+1)×(m+1);黎曼家族与 lebesgue 消费 n×m 个"单元端"值,端由
    /// [`IntegralMethod::cell_end`] 决定.lebesgue 与左端点黎曼同取最小角,
    /// 与 1D/region/solid 的"左端点代表格子"约定一致.
    pub fn sample_shape_2d(self) -> SampleShape {
        match self {
            Self::Trapz | Self::Simpson => SampleShape::Grid,
            Self::RiemannLeft | Self::Lebesgue => SampleShape::LeftCell,
            Self::RiemannRight => SampleShape::RightCell,
            Self::RiemannMid => SampleShape::MidCell,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_semantic_method_names() {
        for (raw, expected) in [
            ("trapezoid", IntegralMethod::Trapz),
            ("simpson", IntegralMethod::Simpson),
            ("riemann:left", IntegralMethod::RiemannLeft),
            ("riemann:right", IntegralMethod::RiemannRight),
            ("riemann:mid", IntegralMethod::RiemannMid),
            ("lebesgue", IntegralMethod::Lebesgue),
        ] {
            assert_eq!(IntegralMethod::parse(raw).unwrap(), expected);
            assert_eq!(expected.semantic_name(), raw);
        }
        assert!(IntegralMethod::parse("riemann").is_err());
        assert!(IntegralMethod::parse("gauss").is_err());
    }

    #[test]
    fn lebesgue_2d_and_left_riemann_share_the_min_corner_cell_end() {
        assert_eq!(IntegralMethod::Lebesgue.cell_end(), CellEnd::MinCorner);
        assert_eq!(IntegralMethod::RiemannLeft.cell_end(), CellEnd::MinCorner);
        assert_eq!(
            IntegralMethod::Lebesgue.sample_shape_2d(),
            SampleShape::LeftCell
        );
        // 1D lebesgue 与 2D lebesgue 采样形态不同的原因必须在同一张表里
        // 能看出来:1D 消费含端点整格,由核取左端点;2D 直接消费 n×m 单元端.
        assert_eq!(
            IntegralMethod::Lebesgue.sample_shape_1d(),
            SampleShape::Grid
        );
        assert_eq!(
            IntegralMethod::Lebesgue.sample_shape_2d(),
            SampleShape::LeftCell
        );
    }
}
