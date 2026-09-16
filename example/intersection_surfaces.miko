// =============================================================
// 曲面求交示例:intersection 对曲面(或曲面与平面)求空间交线
// 采样严重错误
// =============================================================

// 定义系数
param a = 1 in [-5, 5, 0.1];
param b = 1 in [-5, 5, 0.1];
param j = 0 in [-5, 5, 0.1];

// 曲面 z = sin(a*x) * cos(b*y)
surface s1 = sin(x * a) * cos(y * b) {
    color = "#ff6b8a";
    range = [-6, 6, -6, 6];
    segments = 96;
}

// 水平平面 z = j
surface s2 = j {
    color = "#ffd93d";
    range = [-5, 5, -5, 5];
    segments = 64;
}

// 求交:得到三维交线(白色);拖动 j 改变截平面高度,
// 交线随之在曲面上上下移动
intersection X = intersection(s1, s2) {
    color = "#ffffff";
    segments = 256;
};
