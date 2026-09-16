// =============================================================
// 二重积分示例:以区域 region 为积分域,数值求 ∬_D integrand dA
// =============================================================

// 定义系数
param a = 1 in [-5, 5, 0.1];
param b = 1 in [-5, 5, 0.1];

// 上边界曲线 y = sin(a*x)*cos(b*x)
curve c1 = sin(x * a) * cos(x * b) {
    color = "#6dd5ff";
    range = [-8, 8];
    segments = 256;
}

// 下边界曲线 y = 1
curve c2 = 1 {
    color = "#ffffff";
    range = [-8, 8];
    segments = 1;
}

// 区域:由两条曲线围成的 z=0 平面图形(面积图形),可被积分引用为域 D
region R = region(c1, c2) {
    range = [-4, 4];     // x 区间;缺省取两曲线 x-range 交集
    color = "#6bffb8";
    opacity = 0.35;
};

// 二重积分:∬_D integrand dA;缺省 integrand=1 即求区域面积
integral I = integral(R) {
    method = simpson;
    integrand = x * x + y * y;  // 缺省 "1"
    segments = 64;
};
