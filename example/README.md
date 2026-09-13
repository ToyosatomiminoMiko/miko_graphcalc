# GraphCalc 示例集

所有示例都是可直接粘贴到 GraphCalc 左侧"源码"编辑框,点"运行"的完整
DSL(`.miko` 语法)源码片段.文件扩展名沿用 `.scad`(项目里没有示例加载
器,复制文件文本即可运行).文件名按主题命名(不使用序号),并在文件头
注释说明所演示的功能与可调参数.

## 求导 / 偏导

| 文件 | 覆盖功能 |
| --- | --- |
| `derivative_graph.scad` | 导数函数图像:`derivative` 语句把 f′(x) 画成整条新曲线(继承源曲线 range/segments);旁带 `gradient` 点分析作对照 |
| `derivative_curve.scad` | 一元函数求导:`gradient` 作用于 `curve`,在 `at [px, 0]` 处求 f′(x),画分析点 / 切线 / 法向;展示缺省 `show = [point, normal, tangent]` |
| `derivative_rules.scad` | 求导法则对照:同一条竖直线 x = px 上对照积法则 / 商法则 / 幂+链式 / 对数链式 / 三角复合;显式 `show = [point, tangent]` 的用法 |
| `partial_derivative_surface.scad` | 二元函数偏导:`gradient` 作用于 `surface` 求 ∂f/∂x,∂f/∂y,画法向与切平面(`tangent_plane`);含鞍面 fx=fy=0 处切平面水平的演示 |
| `divergence_vector_field.scad` | 散度 `div(F)`:线性源/汇场 div = a+b+c 与刚体旋转场 div ≡ 0 的对照 |
| `curl_vector_field.scad` | 旋度 `curl(F)`:刚体旋转场 curl = (0,0,2w) 与保守梯度场 curl = (0,0,0) 的对照 |
| `sphere_gradient.scad` | 隐式场:球体 `derivative` -> ∇f 向量场,`gradient` 在空间点取 ∇f 并沿梯度投影到球面画点/法向/切平面;`at spherical(θ, φ)` 球坐标写法与 `in cyclic [...]` 循环类系数(φ 越界回绕转圈);`implicit f(x,y,z)=0` 的通用写法 |

> 说明:DSL 层求导有两种形态--`derivative` 语句把符号导数画成整条函数
> 曲线/曲面;`gradient` / `divergence` / `curl` 在指定点做点分析(切线/
> 法向/切平面/散度/旋度),符号引擎都在编译期完成求导;
> `jacobian` / `laplacian` 语法可解析但编译期报"暂未实现".
> 详见 `../docs/derivatives-guide.md`.
>
> 第三种形态是"隐式场":`sphere`(球体)与 `implicit` 对象没有解出因变量,
> `derivative` 对它们求的是梯度 ∇f(产物是 `vector_field`),`gradient` 的
> `at` 给空间点并先投影到等值面.示例见 `sphere_gradient.scad`.

## 其他主题

| 文件 | 覆盖功能 |
| --- | --- |
| `intersection_line_curves.scad` | 曲线 ∩ 曲线 -> 离散交点 |
| `intersection_surfaces.scad` | 曲面 ∩ 曲面(平面)-> 三维交线 |
| `double_integral_region.scad` | `region` 面积图形作域的二重积分(辛普森法) |
| `animation_box_rotations.scad` | 动画片段 `rotate` 列表按顺序播放 |
