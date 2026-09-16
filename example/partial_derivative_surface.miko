// =============================================================
// 二元函数的偏导数:z = f(x, y) 的法向与切平面
//
// 曲面 partial derivative 走 gradient 分析:
//     gradient g = grad(s) at [px, py];
// surface 的表达式在编译期被符号引擎分别对 x,y 求偏导得到
//     fx = ∂f/∂x ,  fy = ∂f/∂y
// 分析在 (px, py) 处画:
//   - point         :曲面上的点 (px, py, f(px, py))(黄色圆点);
//   - normal        :曲面法向(红色箭矢),方向 = (-fx, -fy, 1) 归一化;
//   - tangent_plane :过分析点的切平面(半透明蓝色四边形),法向即上面
//                    的曲面法向(需要 show = tangent_plane 才会画).
// 曲面(与向量场)不写 show 时默认画 [point, normal];只有一元 curve
// 求导默认多画一条 tangent.
//
// 场景里放两个曲面:
//   1) s1 = sin(a*x)*cos(b*y)(绿色)--典型"山包+鞍"曲面:
//        ∂z/∂x =  a*cos(a*x)*cos(b*y)
//        ∂z/∂y = -b*sin(a*x)*sin(b*y)
//      默认 show(点 + 法向),观察法向随坡度摆动;
//   2) s2 = k*x*y(紫色)--鞍面:
//        ∂z/∂x = k*y ,  ∂z/∂y = k*x
//      显示点 + 法向 + 切平面:在 (px, py) 处切平面沿 x/y 两个方向
//      分别以斜率 k*py,k*px 倾斜;把 px/py 拖到 0 时 fx = fy = 0,
//      法向竖直向上 (0, 0, 1),切平面呈水平,直观看到"一阶偏导全为
//      零时切平面水平"(极值/鞍点的必要条件).
// =============================================================

// 可调参数:x/y 向频率 a/b,鞍面陡度 k,观察点 (px, py)
param a = 1 in [0.2, 4, 0.1];
param b = 1 in [0.2, 4, 0.1];
param k = 0.3 in [0.05, 1, 0.05];
param px = 0.8 in [-6, 6, 0.1];
param py = 0.6 in [-6, 6, 0.1];

// 曲面 1:z = sin(a*x) * cos(b*y)
surface s1 = sin(a * x) * cos(b * y) {
    color = "#6bffb8";
    range = [-6, 6, -6, 6];
    segments = 96;
};

// 曲面 2(鞍面):z = k*x*y;在原点附近是马鞍形
surface s2 = k * x * y {
    color = "#b388ff";
    range = [-6, 6, -6, 6];
    segments = 96;
};

// s1 的偏导分析:不写 show,曲面默认 [point, normal]
gradient g1 = grad(s1) at [px, py];

// s2 的偏导分析:点 + 法向 + 切平面
gradient g2 = grad(s2) at [px, py] {
    show = [point, normal, tangent_plane];
};
