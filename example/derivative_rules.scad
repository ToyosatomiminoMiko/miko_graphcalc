// =============================================================
// 求导法则对照:在同一个 x = px 处比较多类函数的导数
//
// 与 derivative_curve.scad 相同的机制(curve + gradient 分析),这里
// 一次性放五类函数,验证符号引擎逐类应用的求导法则.每条曲线的
// gradient 都在同一竖直线 x = px 上取点,便于横向对照;本例每条
// 分析显式写 show = [point, tangent],只画分析点与切线(省略法向),
// 切线斜率就是该函数在 px 处的导数:
//
//   曲线                     函数                    导数(在 px 处;默认 a=1,b=1,c=2)
//   c_prod(蓝)  0.2*(x-a)*(x+b)       积法则     0.2*((x+b)+(x-a))           -> 0.4
//   c_quot(粉)  (x+a)/(x^2+b)         商法则     (b-x^2-2*a*x)/(x^2+b)^2     -> -0.5
//   c_pow(紫)   (x+a)^3/40            幂+链式    3*(x+a)^2/40                -> 0.3
//   c_log(黄)   ln(x^2+b)             对数+链式  2*x/(x^2+b)                 -> 1
//   c_trig(绿)  sin(a*x)*cos(c*x)     三角复合   a*cos(ax)cos(cx)-c*sin(ax)sin(cx)
//                                                                           -> 约 -1.755
// (拖动 px 会看到切线斜率随导数表达式连续变化;上表末列即缺省参数下
//  面板数值,可与切线目测斜率对照.)
//
// 符号引擎对和/差/积/商/幂(f^g),链式法则内置函数集可导,覆盖:
// sin cos tan asin acos atan sinh cosh tanh exp ln log10 log2 sqrt
// cbrt abs sign 以及别名 sec csc cot pow log;把上面任意一条曲线的
// 表达式换成这些函数(例如 atan(a*x),exp(a*x),tanh(a*x))即可求导.
// =============================================================

// 可调参数:公共观察点 px;各类曲线的系数 a/b/c
param a = 1 in [0.2, 4, 0.1];
param b = 1 in [0.5, 4, 0.1];
param c = 2 in [0.2, 4, 0.1];
param px = 1 in [-6, 6, 0.1];

// 1) 积法则:0.2*(x-1)*(x+1),f' = 0.2*(2x) = 0.4x
curve c_prod = 0.2 * (x - a) * (x + b) {
    color = "#6dd5ff";
    range = [-8, 8];
    segments = 256;
};

// 2) 商法则:(x+1)/(x^2+1),f' = (1 - x^2 - 2x)/(x^2+1)^2
curve c_quot = (x + a) / (x * x + b) {
    color = "#ff6b8a";
    range = [-8, 8];
    segments = 256;
};

// 3) 幂法则 + 平移链式:(x+1)^3/40,f' = 3*(x+1)^2/40
curve c_pow = (x + a) ^ 3 / 40 {
    color = "#b388ff";
    range = [-8, 8];
    segments = 256;
};

// 4) 对数链式:ln(x^2+1),f' = 2x/(x^2+1)
curve c_log = ln(x * x + b) {
    color = "#ffd93d";
    range = [-8, 8];
    segments = 256;
};

// 5) 三角复合(积 + 双链式):sin(x)*cos(2x)
//    f' = cos(x)cos(2x) - 2*sin(x)sin(2x)
curve c_trig = sin(a * x) * cos(c * x) {
    color = "#6bffb8";
    range = [-8, 8];
    segments = 256;
};

// 五条曲线都在 x = px 处做一元求导;show 显式只画点 + 切线
gradient g_prod = grad(c_prod) at [px, 0] {
    show = [point, tangent];
};

gradient g_quot = grad(c_quot) at [px, 0] {
    show = [point, tangent];
};

gradient g_pow = grad(c_pow) at [px, 0] {
    show = [point, tangent];
};

gradient g_log = grad(c_log) at [px, 0] {
    show = [point, tangent];
};

gradient g_trig = grad(c_trig) at [px, 0] {
    show = [point, tangent];
};
