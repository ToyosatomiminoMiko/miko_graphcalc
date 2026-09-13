// =============================================================
// 曲线求交示例:intersection 对两条平面曲线求离散交点
// =============================================================

// 定义系数(直线斜率与截距)
param j = 0.6 in [-5, 5, 0.1];
param k = -0.4 in [-5, 5, 0.1];

// 两条直线 y = j*x 与 y = k*x + j
curve l1 = x * j {
    color = "#00ffff";
    range = [-8, 8];
    segments = 256;
}

curve l2 = x * k + j {
    color = "#ffff00";
    range = [-8, 8];
    segments = 256;
}

// 求交:得到离散交点(白色点);拖动 j/k 观察交点沿直线移动
intersection X = intersection(l1, l2) {
    color = "#ffffff";
    segments = 96;
};
