//! 参数化面片:把曲面 / 球面 / 盒面 / 旋转体统一成 (u, v) 平面上的可采样几何.
//!
//! 从 `intersection_core` 拆出(202609 结构整理):marching squares 只要求
//! "给定 (u, v) 得到世界坐标点",各几何体的参数化与边界处理(球面六面投影,
//! 盒面偏移,旋转体侧面与端盖)都收在这一层,和求交算法本身解耦.

use std::cmp::Ordering;

use crate::geometry_core::{check_conic_params, ObjectDescriptor, ObjectKind};
use crate::transform_core::Mat4;

use super::{clamp, finite, to_world, V3};

const TAU: f64 = std::f64::consts::TAU;

/// 旋转体端盖存在性判定:半径小于"旋转体自身尺度"的该比例时视为退化,
/// 不生成端盖.相对容差随几何缩放,不再用硬编码绝对 1e-9.
const CONIC_CAP_RELATIVE_EPSILON: f64 = 1e-9;

struct SurfaceGrid {
    z_values: Vec<f64>,
    nx: usize,
    ny: usize,
    range: [f64; 4],
    matrix: Option<Mat4>,
}

impl SurfaceGrid {
    fn new(descriptor: &ObjectDescriptor, nx: usize, ny: usize) -> Result<Self, String> {
        let [xa, xb, ya, yb] = [
            descriptor.params[0],
            descriptor.params[1],
            descriptor.params[2],
            descriptor.params[3],
        ];
        if !(xa < xb && ya < yb) {
            return Err("曲面 range 需要 min < max".to_string());
        }
        let z_values: Vec<f64> = crate::sampling_core::sample_surface_values(
            &descriptor.expr,
            &descriptor.coefficient_names,
            &descriptor.coefficient_values,
            xa,
            xb,
            ya,
            yb,
            nx,
            ny,
        )?;
        Ok(Self {
            z_values,
            nx,
            ny,
            range: [xa, xb, ya, yb],
            matrix: descriptor.matrix,
        })
    }

    fn bilinear_z(&self, u: f64, v: f64) -> Option<f64> {
        let [xa, xb, ya, yb] = self.range;
        let xf = ((u - xa) / (xb - xa)) * self.nx as f64;
        let yf = ((v - ya) / (yb - ya)) * self.ny as f64;
        let i0 = clamp(xf.floor(), 0.0, (self.nx - 1) as f64) as usize;
        let j0 = clamp(yf.floor(), 0.0, (self.ny - 1) as f64) as usize;
        let i1 = (i0 + 1).min(self.nx);
        let j1 = (j0 + 1).min(self.ny);
        let tx = clamp(xf - i0 as f64, 0.0, 1.0);
        let ty = clamp(yf - j0 as f64, 0.0, 1.0);
        let width = self.nx + 1;
        let z00 = self.z_values[j0 * width + i0];
        let z10 = self.z_values[j0 * width + i1];
        let z01 = self.z_values[j1 * width + i0];
        let z11 = self.z_values[j1 * width + i1];
        if !finite(z00) || !finite(z10) || !finite(z01) || !finite(z11) {
            return None;
        }
        let bottom = z00 + (z10 - z00) * tx;
        let top = z01 + (z11 - z01) * tx;
        Some(bottom + (top - bottom) * ty)
    }

    fn point(&self, u: f64, v: f64) -> Option<V3> {
        let z = self.bilinear_z(u, v)?;
        Some(to_world(self.matrix, [u, v, z]))
    }
}

const SPHERE_FACES: [([f64; 3], [f64; 3], [f64; 3]); 6] = [
    ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
    ([-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
    ([0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
    ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
    ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
    ([0.0, 0.0, -1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]),
];

enum PatchShape {
    Surface(SurfaceGrid),
    SphereFace {
        center: V3,
        radius: f64,
        direction: V3,
        axis_a: V3,
        axis_b: V3,
        matrix: Option<Mat4>,
    },
    BoxFace {
        center: V3,
        direction: V3,
        axis_a: V3,
        axis_b: V3,
        hd: f64,
        matrix: Option<Mat4>,
    },
    ConicSide {
        center: V3,
        base_radius: f64,
        top_radius: f64,
        height: f64,
        matrix: Option<Mat4>,
    },
    ConicCap {
        center: V3,
        radius: f64,
        y_offset: f64,
        matrix: Option<Mat4>,
    },
}

pub(crate) struct PatchEval {
    pub(crate) u0: f64,
    pub(crate) u1: f64,
    pub(crate) v0: f64,
    pub(crate) v1: f64,
    shape: PatchShape,
}

impl PatchEval {
    pub(crate) fn point_valid(&self, u: f64, v: f64) -> (Option<V3>, bool) {
        match &self.shape {
            PatchShape::Surface(grid) => {
                let point = grid.point(u, v);
                (point, point.is_some())
            }
            PatchShape::SphereFace {
                center,
                radius,
                direction,
                axis_a,
                axis_b,
                matrix,
            } => {
                let length = (radius * radius + u * u + v * v).sqrt();
                let scale = radius / length;
                let mut local = [0.0; 3];
                for i in 0..3 {
                    local[i] =
                        center[i] + (direction[i] * radius + axis_a[i] * u + axis_b[i] * v) * scale;
                }
                (Some(to_world(*matrix, local)), true)
            }
            PatchShape::BoxFace {
                center,
                direction,
                axis_a,
                axis_b,
                hd,
                matrix,
            } => {
                let mut local = [0.0; 3];
                for i in 0..3 {
                    local[i] = center[i] + direction[i] * hd + axis_a[i] * u + axis_b[i] * v;
                }
                (Some(to_world(*matrix, local)), true)
            }
            PatchShape::ConicSide {
                center,
                base_radius,
                top_radius,
                height,
                matrix,
            } => {
                let radius_at = base_radius + (top_radius - base_radius) * (v / height);
                let local = [
                    center[0] + radius_at * u.cos(),
                    center[1] + v - height * 0.5,
                    center[2] + radius_at * u.sin(),
                ];
                (Some(to_world(*matrix, local)), true)
            }
            PatchShape::ConicCap {
                center,
                radius,
                y_offset,
                matrix,
            } => {
                let valid = v >= 0.0 && v <= radius + 1e-9;
                if valid {
                    let local = [
                        center[0] + v * u.cos(),
                        center[1] + y_offset,
                        center[2] + v * u.sin(),
                    ];
                    (Some(to_world(*matrix, local)), true)
                } else {
                    (None, false)
                }
            }
        }
    }

    pub(crate) fn point(&self, u: f64, v: f64) -> Option<V3> {
        self.point_valid(u, v).0
    }
}

fn build_surface_patch(
    descriptor: &ObjectDescriptor,
    segments: usize,
) -> Result<PatchEval, String> {
    let grid = SurfaceGrid::new(descriptor, segments, segments)?;
    Ok(PatchEval {
        u0: grid.range[0],
        u1: grid.range[1],
        v0: grid.range[2],
        v1: grid.range[3],
        shape: PatchShape::Surface(grid),
    })
}

fn build_sphere_patches(descriptor: &ObjectDescriptor) -> Result<Vec<PatchEval>, String> {
    let center = [
        descriptor.params[0],
        descriptor.params[1],
        descriptor.params[2],
    ];
    let radius = descriptor.params[3];
    if radius.partial_cmp(&0.0) != Some(Ordering::Greater) {
        return Err("球体 radius 必须大于 0".to_string());
    }
    Ok(SPHERE_FACES
        .iter()
        .map(|(direction, axis_a, axis_b)| PatchEval {
            u0: -radius,
            u1: radius,
            v0: -radius,
            v1: radius,
            shape: PatchShape::SphereFace {
                center,
                radius,
                direction: *direction,
                axis_a: *axis_a,
                axis_b: *axis_b,
                matrix: descriptor.matrix,
            },
        })
        .collect())
}

fn build_box_patches(descriptor: &ObjectDescriptor) -> Result<Vec<PatchEval>, String> {
    let center = [
        descriptor.params[0],
        descriptor.params[1],
        descriptor.params[2],
    ];
    let half = [
        descriptor.params[3] * 0.5,
        descriptor.params[4] * 0.5,
        descriptor.params[5] * 0.5,
    ];
    if half.iter().any(|value| *value <= 0.0) {
        return Err("方块 size 每个分量都必须大于 0".to_string());
    }
    // 每项: 方向,u 轴,v 轴,u 半长,v 半长,法向偏移.
    let faces = [
        (
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            half[1],
            half[2],
            half[0],
        ),
        (
            [-1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 1.0, 0.0],
            half[2],
            half[1],
            half[0],
        ),
        (
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            half[2],
            half[0],
            half[1],
        ),
        (
            [0.0, -1.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            half[0],
            half[2],
            half[1],
        ),
        (
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            half[0],
            half[1],
            half[2],
        ),
        (
            [0.0, 0.0, -1.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
            half[1],
            half[0],
            half[2],
        ),
    ];
    Ok(faces
        .iter()
        .map(|(direction, axis_a, axis_b, ar, br, hd)| PatchEval {
            u0: -ar,
            u1: *ar,
            v0: -br,
            v1: *br,
            shape: PatchShape::BoxFace {
                center,
                direction: *direction,
                axis_a: *axis_a,
                axis_b: *axis_b,
                hd: *hd,
                matrix: descriptor.matrix,
            },
        })
        .collect())
}

fn build_conic_patches(descriptor: &ObjectDescriptor) -> Result<Vec<PatchEval>, String> {
    let center = [
        descriptor.params[0],
        descriptor.params[1],
        descriptor.params[2],
    ];
    let base_radius = descriptor.params[3];
    let top_radius = descriptor.params[4];
    let height = descriptor.params[5];
    check_conic_params(base_radius, top_radius, height)?;
    let cap_scale = base_radius.max(top_radius).max(height);

    let mut patches = vec![PatchEval {
        u0: 0.0,
        u1: TAU,
        v0: 0.0,
        v1: height,
        shape: PatchShape::ConicSide {
            center,
            base_radius,
            top_radius,
            height,
            matrix: descriptor.matrix,
        },
    }];

    if base_radius > CONIC_CAP_RELATIVE_EPSILON * cap_scale {
        patches.push(PatchEval {
            u0: 0.0,
            u1: TAU,
            v0: 0.0,
            v1: base_radius,
            shape: PatchShape::ConicCap {
                center,
                radius: base_radius,
                y_offset: -height * 0.5,
                matrix: descriptor.matrix,
            },
        });
    }
    if top_radius > CONIC_CAP_RELATIVE_EPSILON * cap_scale {
        patches.push(PatchEval {
            u0: 0.0,
            u1: TAU,
            v0: 0.0,
            v1: top_radius,
            shape: PatchShape::ConicCap {
                center,
                radius: top_radius,
                y_offset: height * 0.5,
                matrix: descriptor.matrix,
            },
        });
    }
    Ok(patches)
}

pub(crate) fn build_patches(
    descriptor: &ObjectDescriptor,
    segments: usize,
) -> Result<Vec<PatchEval>, String> {
    match descriptor.kind {
        ObjectKind::Surface => Ok(vec![build_surface_patch(descriptor, segments)?]),
        ObjectKind::Sphere => build_sphere_patches(descriptor),
        ObjectKind::Box => build_box_patches(descriptor),
        ObjectKind::Conic => build_conic_patches(descriptor),
        ObjectKind::Curve => Err("曲线不能作为参数化面片".to_string()),
    }
}
