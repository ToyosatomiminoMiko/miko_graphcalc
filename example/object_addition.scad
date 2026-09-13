// 对象相加:curve/surface 的表达式可以按名引用同类对象.
//
// 一个 curve/surface 声明就是一个函数对象(curve 是 y = f(x),surface 是
// z = f(x, y)),所以"曲线 + 曲线"就是普通的表达式运算:
//
//   curve c3 = c1 + c2;     // y = f1(x) + f2(x)
//   surface s3 = s1 + s2;   // z = g1(x, y) + g2(x, y)
//
// 编译器在归一化**之前**把对象名替换成它自己的表达式,因此:
// - 链式相加(curve c4 = c3 + c1)与任意声明顺序都成立,只有成环才报错;
// - 加减乘除都按普通表达式优先级生效,不限于加法;
// - 没有显式 range 时,结果的 x 区间 / x-y 矩形取被引用对象区间的**交集**
//   (交集为空直接报错),显式 range 仍然优先;
// - curve 只能引用 curve,surface 只能引用 surface;引用体积/点/向量对象
//   或 derivative 产物会报错,而不是悄悄多出一个同名滑块.

param a = 1 in [-5, 5, 0.1];
param b = 1 in [-5, 5, 0.1];

// 两条基函数曲线:区间故意不同,用来看"交集"口径
curve c1 = sin(x * a) {
    color = "#6dd5ff";
    range = [-8, 8];
    segments = 256;
}

curve c2 = cos(x * b) {
    color = "#ff6b8a";
    range = [-4, 4];
    segments = 256;
}

// 相加:定义域自动取 c1 ∩ c2 = [-4, 4]
curve c3 = c1 + c2 {
    color = "#ffd93d";
    segments = 256;
}

// 链式相加 + 前向引用:c4 写在 c3 之前也能解析;显式 range 覆盖交集
curve c4 = c3 * 0.5 {
    color = "#6bffb8";
    range = [-3, 3];
    segments = 256;
}

// 相加得到的曲线照常参与其它语句:region 的边界,integral 的积分域,
// derivative 的求导源都用同一份展开后的表达式与区间
region R = region(c3, c1) {
    color = "#6bffb8";
    opacity = 0.25;
}

derivative d = derivative(c3) {
    color = "#ffffff";
}

// 曲面同理:x/y 两个方向分别取交集
surface s1 = sin(x * a) * cos(y * b) {
    color = "#6dd5ff";
    range = [-6, 6, -6, 6];
    segments = 64;
}

surface s2 = x * y * 0.2 {
    color = "#ff6b8a";
    range = [-2, 2, -3, 3];
    segments = 64;
}

surface s3 = s1 + s2 {
    color = "#ffd93d";
    segments = 64;
}
