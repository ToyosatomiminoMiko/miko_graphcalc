//! 小规模稠密线性代数:高斯消元解线性方程组.
//!
//! 这一层从 `integral.rs` 提出(原先只有部分分式分解在用),目的是让"解一次
//! 线性方程组"这件事全项目只有一个实现:
//! - 不定积分的部分分式定系数(`integral.rs::decompose`);
//! - 后续**联立方程**的线性精确解(消元/克拉默之前的底层求解).
//!
//! 与 `derivative` / `poly` 同级:纯数值,不引用 `Expr`,不碰 WASM 边界,
//! 可以在 `cargo test` 里直接验证.
//!
//! 行为契约(从原实现原样搬来,不改判据):
//! - 增广矩阵布局:`matrix[row][column]`,最后一列(`[unknowns]`)是右端项;
//! - 列主元部分选主元;**主元非有限,或绝对值小于 [`SINGULAR_THRESHOLD`],
//!   判为奇异**并返回 `None`(调用方据此回退,不抛错);
//! - 消元后第 `i` 行第 `unknowns` 列即未知量 `i` 的解;行数多于未知量时
//!   忽略多余行(调用方只喂方阵,这里不做最小二乘).
//!
//! 奇异判据只有这一份([`SINGULAR_THRESHOLD`]):[`upper_triangle`] 与
//! [`solve_system`] 共用它,免得两处主元策略漂移.

/// 奇异判据:主元绝对值小于它就当矩阵奇异.
///
/// `NaN` 必须单独拦:`NaN < 阈值` 恒为 false,只判绝对值的话非有限系数会
/// 一路算到"解"里(见 `solve_exact` 的有限性校验).
pub(crate) const SINGULAR_THRESHOLD: f64 = 1e-12;

/// 消元时小于它的行倍数直接跳过(数值上是空操作,跳过省一次整行乘法).
const ELIMINATION_SKIP: f64 = 1e-15;

/// 主元是否可用(有限且不为 0).
fn is_usable_pivot(value: f64) -> bool {
    value.is_finite() && value.abs() >= SINGULAR_THRESHOLD
}

/// 高斯消元(部分选主元)解 `unknowns` 元线性方程组.
///
/// `matrix` 是**增广矩阵**:每行 `unknowns + 1` 个元素,最后一列是右端项.
/// 无解/奇异(某列主元非有限或近似为 0)返回 `None`.
pub(crate) fn solve_system(mut matrix: Vec<Vec<f64>>, unknowns: usize) -> Option<Vec<f64>> {
    let rows = matrix.len();
    for column in 0..unknowns {
        let mut pivot = column;
        for row in column + 1..rows {
            if matrix[row][column].abs() > matrix[pivot][column].abs() {
                pivot = row;
            }
        }
        if !is_usable_pivot(matrix[pivot][column]) {
            return None;
        }
        matrix.swap(column, pivot);
        let divisor = matrix[column][column];
        for value in matrix[column].iter_mut().skip(column) {
            *value /= divisor;
        }
        for row in 0..rows {
            if row == column {
                continue;
            }
            let factor = matrix[row][column];
            if factor.abs() < ELIMINATION_SKIP {
                continue;
            }
            let pivot_row = matrix[column].clone();
            for (cell, pivot_cell) in matrix[row][column..=unknowns]
                .iter_mut()
                .zip(pivot_row[column..=unknowns].iter())
            {
                *cell -= factor * pivot_cell;
            }
        }
    }
    Some((0..unknowns).map(|index| matrix[index][unknowns]).collect())
}

/// 增广矩阵的上三角化(**只用于板书展示**).
///
/// 与 [`solve_system`] 同一套主元策略与奇异判据:消元后第 `i` 行在 `0..i`
/// 列上为 0,`columns` 列是右端项.返回 `None` 表示中途遇到不可用主元 --
/// 调用方(联立板书)此时不该展示"消元结果",因为那既不是等价变形也不代表
/// 方程组可解.
///
/// 不归一化主元行(板书展示的是"加减消元"后的原样矩阵,不是行最简形),
/// 也不做回代:回代由调用方按自己的口径给出.
pub(crate) fn upper_triangle(mut matrix: Vec<Vec<f64>>, columns: usize) -> Option<Vec<Vec<f64>>> {
    let rows = matrix.len();
    for column in 0..columns {
        let mut pivot = column;
        for row in column + 1..rows {
            if matrix[row][column].abs() > matrix[pivot][column].abs() {
                pivot = row;
            }
        }
        if !is_usable_pivot(matrix[pivot][column]) {
            return None;
        }
        matrix.swap(column, pivot);
        for row in column + 1..rows {
            let factor = matrix[row][column] / matrix[column][column];
            if factor.abs() < ELIMINATION_SKIP {
                continue;
            }
            // 先把主元行拷出来:同一矩阵的两行不能同时可变借用.
            let pivot_row: Vec<f64> = matrix[column][column..=columns].to_vec();
            for (offset, cell) in matrix[row][column..=columns].iter_mut().enumerate() {
                *cell -= factor * pivot_row[offset];
            }
        }
    }
    Some(matrix)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 唯一解:2x2 方阵(与联立方程要走的路径同形状).
    #[test]
    fn solves_unique_two_by_two_system() {
        // x + y = 3, x - y = 1 -> x = 2, y = 1.
        let matrix = vec![vec![1.0, 1.0, 3.0], vec![1.0, -1.0, 1.0]];
        let solution = solve_system(matrix, 2).expect("应当有唯一解");
        assert!((solution[0] - 2.0).abs() < 1e-12, "{solution:?}");
        assert!((solution[1] - 1.0).abs() < 1e-12, "{solution:?}");
    }

    /// 主元为 0 的列要靠换行救回来:不选主元会直接判奇异.
    #[test]
    fn pivots_when_first_column_starts_with_zero() {
        // 0x + y = 2, x + y = 3 -> x = 1, y = 2.
        let matrix = vec![vec![0.0, 1.0, 2.0], vec![1.0, 1.0, 3.0]];
        let solution = solve_system(matrix, 2).expect("换行后应当可解");
        assert!((solution[0] - 1.0).abs() < 1e-12, "{solution:?}");
        assert!((solution[1] - 2.0).abs() < 1e-12, "{solution:?}");
    }

    /// 奇异矩阵返回 `None`(调用方据此回退,不 panic).
    #[test]
    fn singular_system_returns_none() {
        // 两行线性相关:x + y = 1 与 2x + 2y = 2.
        let matrix = vec![vec![1.0, 1.0, 1.0], vec![2.0, 2.0, 2.0]];
        assert!(solve_system(matrix, 2).is_none());
    }

    /// NaN 主元必须判奇异:`NaN < 阈值` 恒为 false,只判绝对值会漏过去.
    #[test]
    fn non_finite_pivot_is_singular_not_a_solution() {
        let matrix = vec![vec![f64::NAN, 1.0, 1.0], vec![1.0, 1.0, 2.0]];
        assert!(solve_system(matrix, 2).is_none());

        let infinite = vec![vec![f64::INFINITY, 1.0, 1.0], vec![1.0, 1.0, 2.0]];
        assert!(solve_system(infinite, 2).is_none());
    }

    /// 板书用上三角化与求解走同一套主元判据:非有限矩阵给 `None`.
    #[test]
    fn upper_triangle_reports_unusable_pivots() {
        let matrix = vec![vec![1.0, 1.0, 3.0], vec![1.0, -1.0, 1.0]];
        let triangular = upper_triangle(matrix, 2).expect("非奇异矩阵应当可上三角化");
        // 第二行第一列必须被消掉.
        assert!(triangular[1][0].abs() < 1e-12, "{triangular:?}");
        // 右端项仍是原方程 `x - y = 1` 消元后的结果,不是被跳过的.
        assert!((triangular[1][2] + 2.0).abs() < 1e-12, "{triangular:?}");

        assert!(upper_triangle(vec![vec![f64::NAN, 1.0, 1.0]], 1).is_none());
    }
}
