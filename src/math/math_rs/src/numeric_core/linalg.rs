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
//! - 列主元部分选主元;**主元绝对值小于 `1e-12` 判为奇异**并返回 `None`
//!   (调用方据此回退,不抛错);
//! - 消元后第 `i` 行第 `unknowns` 列即未知量 `i` 的解;行数多于未知量时
//!   忽略多余行(调用方只喂方阵,这里不做最小二乘).

/// 高斯消元(部分选主元)解 `unknowns` 元线性方程组.
///
/// `matrix` 是**增广矩阵**:每行 `unknowns + 1` 个元素,最后一列是右端项.
/// 无解/奇异(某列主元近似为 0)返回 `None`.
pub(crate) fn solve_system(mut matrix: Vec<Vec<f64>>, unknowns: usize) -> Option<Vec<f64>> {
    let rows = matrix.len();
    for column in 0..unknowns {
        let mut pivot = column;
        for row in column + 1..rows {
            if matrix[row][column].abs() > matrix[pivot][column].abs() {
                pivot = row;
            }
        }
        if matrix[pivot][column].abs() < 1e-12 {
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
            if factor.abs() < 1e-15 {
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
}
