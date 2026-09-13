// =============================================================
// 导数函数图像:derivative 语句
//
// DSL 用 `derivative 名称 = derivative(源对象)` 新建一个对象,其表达式
// 是源对象对 x 的符号导数,画成整条导数曲线(这就是旧的"出导后的图像"):
//     derivative dc = derivative(c);
// 等价于把 f'(x) 作为一条新曲线绘制,range/segments 缺省继承源对象.
//
// 函数名遵循项目全名习惯,不缩写(不写 deriv).
//
// 本例 f(x) = sin(a * x) 及其导数曲线 f'(x) = a * cos(a * x):
// 蓝色是原曲线,绿色是导数曲线;拖动 a 或 px 会同步刷新两者.
// =============================================================

// 可调参数:角频率 a(同时驱动原曲线与导数曲线)
param a = 1 in [0.2, 4, 0.1];
param j = 1 in [-8, 8, 0.01];

// 原曲线 y = sin(a * x)
curve c = sin(a * x) {
    color = "#6dd5ff";
    range = [-8, 8];
    segments = 256;
};

// 导数曲线 dc = f'(x) = a * cos(a * x);
// 继承 c 的 range 与 segments,颜色自动取自调色板
derivative dc = derivative(c);
derivative ddc = derivative(dc);
derivative dddc = derivative(ddc);
derivative ddddc = derivative(dddc);

// 曲线求导仍保留点分析(切线):只有切线/法向,不画整条导数曲线
gradient g = grad(c) at [j, 0];

// 曲面 偏导

surface s = sin(x) * cos(y) {
    color = "#6dd5ff";
    range = [-8, 8,-8,8];
    segments = 256;
};

// 曲面偏导需显式给变量:
derivative dx = derivative(s, x);   // ∂f/∂x
derivative dy = derivative(s, y);   // ∂f/∂y

