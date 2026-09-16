// =============================================================
// 隐式场:球体与 f(x,y,z)=0 的梯度 ∇f
//
// curve 是 y=f(x),surface 是 z=f(x,y)--它们的因变量都已经解出来了,
// 所以 grad 只要给 x/y 就能定位分析点.球体和一般隐式曲面没有因变量:
// 球面是隐式方程
//     f(x,y,z) = |p − c|² − r² = 0
// 的分析,因此:
//   - `derivative(s)` 对隐式场求导 = 梯度 ∇f(整体导数),产物是一个
//     vector_field,复用向量场的采样/渲染管线;
//   - `gradient g = grad(s) at [x, y, z]` 在空间点上取 ∇f.空间点一般
//     不在球面上,编译期会沿 ∇f 做牛顿投影,把分析点落到等值面上,再画
//     法向(normal)与切平面(tangent_plane).球体的 ∇f = 2(p − c) 是径向
//     的,所以投影就是"从球心沿半径方向推到球面".
//
// `at` 语法上至少两个坐标;三维场的第三个缺省按 0 补全,但建议写全
// [x, y, z].若点恰好落在 ∇f = 0 的地方(球心),法向没有定义,编译期
// 直接报错而不是画一个错误的方向.
//
// 球坐标写法:对球体这种"点天然用 [r, θ, φ] 描述"的对象,可以显式写
//     gradient gs = grad(s) at spherical(θ, φ);
// (r 省略时取球体半径;也可写全 `at spherical(r, θ, φ)`).这是显式声明,
// 不会隐式改变 `at [x, y, z]` 的笛卡尔语义.θ/φ 的约定由
// `numericConfig.analysis.sphericalAngleConvention` 全局配置:
// 默认 'physics'(θ 从 +Z 量起的极角,φ 是 xy 平面方位角),可选 'math'
// (θ/φ 互换).结果列表会把分析点换算回 [r, θ, φ] 一并显示:条目默认折叠,只
// 有一行 KaTeX(∇f(点)),点这一行(原生 details 行为)展开后依次给算子符号
// 展开 ∇f=(f_x,f_y,f_z),该点数值结果与 P,球坐标回显,f(P),切线.
//
// 隐式对象 `implicit`:直接声明 f(x,y)=0(二维等值线)或 f(x,y,z)=0
// (三维等值面),维度由表达式里出现的坐标变量推断.它自己不画网格
// (本体采网渲染留到后续),但同样可以 gradient / derivative.
//
// 拖动 j/k/l 或 θ/φ 观察:球体不动,分析点沿 ∇f 在等值面上移动,切平面
// 随之转动;灰色箭头是整片 ∇f 向量场.
// =============================================================

// 可调参数:分析点 (j, k, l)
param j = 1 in [-2.5, 2.5, 0.05];
param k = 1 in [-2.5, 2.5, 0.05];
param l = 0 in [-2.5, 2.5, 0.05];

// 可调参数:球坐标分析点(θ, φ),r 缺省取球体半径 2
// 角度约定由 numericConfig.analysis.sphericalAngleConvention 全局配置:
// 默认 physics(θ 从 +Z 量起的极角,φ 是 xy 平面方位角);改成 math 则 θ/φ 互换.
//
// `in cyclic` 把角度声明成**循环类系数**:φ 的 -3.14159 与 3.14159 是同一个
// 方位,拖到端点后继续转圈(越界值按 2π 回绕,而不是像普通参数一样夹住);
// 面板里名字后带 ↻,数字框输入 7 会回绕成 7 − 2π ≈ 0.7168.θ ∈ [0, π] 是
// 极角,单向取值,保持普通参数.
param theta = 0.9 in [0, 3.14159, 0.01];
param phi = 0.6 in cyclic [-3.14159, 3.14159, 0.01];

// 球体:半径 2,半透明;它同时是下面 derivative / gradient 的隐式场来源
sphere s = [0, 0, 0] {
    radius = 2;
    color = "#6dd5ff";
    opacity = 0.25;
};

// derivative(球体)= ∇f = 2(p − c),一个指向径向外的向量场
derivative ds = derivative(s) {
    range = [-3, 3, -3, 3, -3, 3];
    grid = [5, 5, 5];
    scale = 0.3;
};

// gradient(球体)在空间点 (j,k,l) 处求 ∇f,并投影到球面:
// point = 投影点(黄色),normal = 单位外法向(红色箭头),
// tangent_plane = 该点切平面(半透明蓝色)
gradient g = grad(s) at [j, k, l] {
    show = [point, normal, tangent_plane];
};

// 同一件事的球坐标写法:at spherical(θ, φ) 显式声明按球坐标解释,
// r 省略时取球体半径,点直接落在球面上(不需要投影来纠偏).
// 结果列表会同时回显 [r, θ, φ].
gradient gs = grad(s) at spherical(theta, phi) {
    show = [point, normal, tangent_plane];
};

// 一般隐式场:单叶双曲面 x² + y² − z² − 1 = 0(dim=3,含 z)
implicit H = x^2 + y^2 - z^2 - 1 {
    color = "#ff6b8a";
};

// 同一套 gradient / derivative 直接作用于 implicit 对象
gradient gh = grad(H) at [1.5, 1.5, 1] {
    show = [point, normal, tangent_plane];
};

derivative dH = derivative(H) {
    range = [-3, 3, -3, 3, -3, 3];
    grid = [5, 5, 5];
    scale = 0.15;
};
