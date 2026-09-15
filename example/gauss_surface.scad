// 定义系数
param a = 0.1 in [-5, 5, 0.05];
param b = 1 in [-5, 5, 0.1];
param j = 3 in [-5, 10, 0.05];
param k = 0 in [-5, 5, 0.1];


// 二维高斯钟形曲面
surface s1 = j*e^(-a*(x^2+y^2)) {
    range = [-8, 8, -8, 8];
    segments = 96;
}

derivative dx = derivative(s1, x);
// 曲面后处理问题:
// 在 y [-15/18,15/18]
// x [0,0.4]左右出现方形空洞
// 调整阈值