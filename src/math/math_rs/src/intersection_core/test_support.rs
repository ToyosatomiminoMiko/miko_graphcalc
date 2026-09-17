//! `#[cfg(test)]` 共享测试夹具:描述符构造与输出解码.
//!
//! 从 `intersection_core` 拆出(202609 结构整理):各子模块的测试都要造
//! `ObjectDescriptor`,也都要把扁平输出还原成点集,集中在这里,避免每个
//! 测试模块各抄一份.

use super::{parse_object_descriptor, IntersectionCoreOutput, ObjectDescriptor};

pub(crate) fn curve_descriptor(expr: &str, range: [f64; 2]) -> ObjectDescriptor {
    parse_object_descriptor(
        "curve",
        expr,
        vec![],
        vec![],
        range.to_vec(),
        vec![],
        vec![],
    )
    .unwrap()
}

pub(crate) fn surface_descriptor(expr: &str, range: [f64; 4]) -> ObjectDescriptor {
    parse_object_descriptor(
        "surface",
        expr,
        vec![],
        vec![],
        range.to_vec(),
        vec![],
        vec![],
    )
    .unwrap()
}

pub(crate) fn sphere_descriptor(center: [f64; 3], radius: f64) -> ObjectDescriptor {
    let params = [center[0], center[1], center[2], radius];
    parse_object_descriptor(
        "sphere",
        "",
        vec![],
        vec![],
        params.to_vec(),
        vec![],
        vec![],
    )
    .unwrap()
}

pub(crate) fn box_descriptor(center: [f64; 3], size: [f64; 3]) -> ObjectDescriptor {
    let params = [center[0], center[1], center[2], size[0], size[1], size[2]];
    parse_object_descriptor("box", "", vec![], vec![], params.to_vec(), vec![], vec![]).unwrap()
}

pub(crate) fn points_of(output: &IntersectionCoreOutput) -> Vec<[f64; 3]> {
    output
        .points
        .as_chunks::<3>()
        .0
        .iter()
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect()
}

pub(crate) fn conic_descriptor(base: f64, top: f64, height: f64) -> ObjectDescriptor {
    let params = [0.0, 0.0, 0.0, base, top, height];
    parse_object_descriptor("conic", "", vec![], vec![], params.to_vec(), vec![], vec![]).unwrap()
}
