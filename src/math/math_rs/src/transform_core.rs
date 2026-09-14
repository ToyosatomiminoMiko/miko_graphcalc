/// 行主序 4x4 矩阵,元素顺序为:
/// [m00, m01, m02, m03,
///  m10, m11, m12, m13,
///  m20, m21, m22, m23,
///  m30, m31, m32, m33]
pub type Mat4 = [f64; 16];

#[rustfmt::skip]
pub fn identity4() -> Mat4 {
    [
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]
}

#[rustfmt::skip]
pub fn translate4(tx: f64, ty: f64, tz: f64) -> Mat4 {
    [
        1.0, 0.0, 0.0, tx,
        0.0, 1.0, 0.0, ty,
        0.0, 0.0, 1.0, tz,
        0.0, 0.0, 0.0, 1.0,
    ]
}

#[rustfmt::skip]
pub fn scale4(sx: f64, sy: f64, sz: f64) -> Mat4 {
    [
        sx, 0.0, 0.0, 0.0,
        0.0, sy, 0.0, 0.0,
        0.0, 0.0, sz, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]
}

#[rustfmt::skip]
pub fn rotate4(rx: f64, ry: f64, rz: f64) -> Mat4 {
    let cx = rx.cos();
    let sx = rx.sin();
    let cy = ry.cos();
    let sy = ry.sin();
    let cz = rz.cos();
    let sz = rz.sin();

    let rx_m: Mat4 = [
        1.0, 0.0, 0.0, 0.0,
        0.0, cx, -sx, 0.0,
        0.0, sx, cx, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ];
    let ry_m: Mat4 = [
        cy, 0.0, sy, 0.0,
        0.0, 1.0, 0.0, 0.0,
        -sy, 0.0, cy, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ];
    let rz_m: Mat4 = [
        cz, -sz, 0.0, 0.0,
        sz,  cz, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ];

    multiply4x4(multiply4x4(rz_m, ry_m), rx_m)
}

pub fn multiply4x4(a: Mat4, b: Mat4) -> Mat4 {
    let mut out = [0.0; 16];
    for row in 0..4 {
        for col in 0..4 {
            let mut sum = 0.0;
            for k in 0..4 {
                sum += a[row * 4 + k] * b[k * 4 + col];
            }
            out[row * 4 + col] = sum;
        }
    }
    out
}

pub fn apply_to_point(matrix: Mat4, x: f64, y: f64, z: f64) -> [f64; 3] {
    let v = [x, y, z, 1.0];
    let mut out = [0.0; 4];

    for row in 0..4 {
        out[row] = matrix[row * 4] * v[0]
            + matrix[row * 4 + 1] * v[1]
            + matrix[row * 4 + 2] * v[2]
            + matrix[row * 4 + 3] * v[3];
    }

    [out[0], out[1], out[2]]
}

/// 仿射变换的体积缩放因子 |det M|(体积积分/切片法使用).
///
/// 行主序 4x4 的线性块位于 m[0..3]/m[4..7]/m[8..11];无矩阵(恒等)时返回 1.
/// 旋转/平移的 det 为 ±1,缩放 (sx,sy,sz) 的 det 为 sx·sy·sz.
pub fn affine_volume_scale(matrix: Option<Mat4>) -> f64 {
    let Some(m) = matrix else {
        return 1.0;
    };
    let det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8])
        + m[2] * (m[4] * m[9] - m[5] * m[8]);
    det.abs()
}

pub fn from_flat(values: Vec<f64>) -> Result<Mat4, String> {
    if values.len() != 16 {
        return Err(format!("4x4 矩阵需要 16 个元素,实际为 {}", values.len()));
    }

    let mut matrix = [0.0; 16];
    matrix.copy_from_slice(&values);
    Ok(matrix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translate_then_apply_moves_point() {
        let matrix = translate4(2.0, -3.0, 5.0);
        let point = apply_to_point(matrix, 1.0, 2.0, 3.0);

        assert!((point[0] - 3.0).abs() < 1e-12);
        assert!((point[1] + 1.0).abs() < 1e-12);
        assert!((point[2] - 8.0).abs() < 1e-12);
    }

    #[test]
    fn rotation_preserves_vector_length() {
        let matrix = rotate4(0.3, -0.2, 0.7);
        let point = apply_to_point(matrix, 1.0, 2.0, 3.0);
        let length = (point[0] * point[0] + point[1] * point[1] + point[2] * point[2]).sqrt();

        assert!((length - (1.0f64 + 4.0 + 9.0).sqrt()).abs() < 1e-10);
    }

    #[test]
    fn translate_keeps_offset_in_fourth_column() {
        // 行主序:平移量落在每行的第 4 个元素(m03/m13/m23).
        assert_eq!(
            translate4(2.0, -3.0, 5.0),
            [
                1.0, 0.0, 0.0, 2.0, //
                0.0, 1.0, 0.0, -3.0, //
                0.0, 0.0, 1.0, 5.0, //
                0.0, 0.0, 0.0, 1.0,
            ]
        );
    }

    #[test]
    fn identity_is_neutral_for_multiply() {
        let matrix = translate4(1.0, 2.0, 3.0);
        assert_eq!(multiply4x4(identity4(), matrix), matrix);
        assert_eq!(multiply4x4(matrix, identity4()), matrix);
    }

    #[test]
    fn multiply_applies_right_hand_matrix_first() {
        // a * b 的语义是"先 b 后 a":对 (1,1,1) 先平移 (1,0,0),再放大 2 倍.
        // 这是 compileScene/AnimationPlayer 逐级累乘所依赖的顺序约定.
        let matrix = multiply4x4(scale4(2.0, 2.0, 2.0), translate4(1.0, 0.0, 0.0));
        let point = apply_to_point(matrix, 1.0, 1.0, 1.0);

        assert!((point[0] - 4.0).abs() < 1e-12, "先平移后缩放应得 x=4");
        assert!((point[1] - 2.0).abs() < 1e-12);
        assert!((point[2] - 2.0).abs() < 1e-12);
    }

    #[test]
    fn rotate_composes_as_rz_ry_rx_and_stays_affine() {
        // 单轴 90 度:绕 z 轴把 (1,0,0) 转到 (0,1,0).
        let quarter = rotate4(0.0, 0.0, std::f64::consts::FRAC_PI_2);
        let point = apply_to_point(quarter, 1.0, 0.0, 0.0);

        assert!(point[0].abs() < 1e-12);
        assert!((point[1] - 1.0).abs() < 1e-12);
        assert!(point[2].abs() < 1e-12);

        // 旋转是仿射变换:最后一行恒为 [0, 0, 0, 1].
        let matrix = rotate4(0.3, -0.2, 0.7);
        assert_eq!(&matrix[12..16], &[0.0, 0.0, 0.0, 1.0][..]);
    }

    #[test]
    fn from_flat_rejects_wrong_length_and_round_trips() {
        // WASM 边界收到的扁平数组长度必须正好 16,否则上游是坏数据.
        assert!(from_flat(vec![0.0; 15]).is_err());
        assert!(from_flat(vec![0.0; 17]).is_err());

        let matrix = translate4(1.0, 2.0, 3.0);
        assert_eq!(from_flat(matrix.to_vec()), Ok(matrix));
    }

    #[test]
    fn affine_volume_scale_matches_expected_determinants() {
        assert!((affine_volume_scale(None) - 1.0).abs() < 1e-12);
        assert!((affine_volume_scale(Some(translate4(1.0, 2.0, 3.0))) - 1.0).abs() < 1e-12);
        assert!(
            (affine_volume_scale(Some(rotate4(0.4, -0.3, 1.1))) - 1.0).abs() < 1e-12,
            "旋转矩阵体积缩放应为 1"
        );
        assert!((affine_volume_scale(Some(scale4(2.0, 1.5, 0.5))) - 1.5).abs() < 1e-12);
        // 负缩放(镜像)的 |det| 仍取正.
        assert!((affine_volume_scale(Some(scale4(-1.0, 2.0, 3.0))) - 6.0).abs() < 1e-12);
    }
}
