# GraphCalc 示例集

所有示例都是完整的 DSL(`.miko` 语法)源码,下面两张表同时也是应用内
**示例**菜单的内容:打开左侧「源码」面板标题栏的"示例"按钮,选中一项即可
载入并立即运行,不必手工复制文本.载入会整段替换编辑器内容,但用的是
编辑管线的插入命令而非直接赋值,所以浏览器原生撤销栈是保留的--一次
Ctrl+Z 就能退回载入前的代码.文件扩展名沿用 `.scad`,文件名按主题命名
(不使用序号),并在文件头注释说明所演示的功能与可调参数.

> **新增示例**:在 `example/` 放 `.scad` 文件,并在
> `src/ui/examples/exampleCatalog.ts` 里登记一行(标题 + 分组).
> 两边对不上会被 `src/ui/examples/exampleCatalog.test.ts` 挡住;示例本身
> 能否编译由 `src/compiler/dsl/exampleScenes.test.ts` 全量跑一遍.

## 求导 / 偏导

| 文件 | 覆盖功能 |
| --- | --- |
| `derivative_graph.scad` | 导数函数图像:`derivative` 语句把 f′(x) 画成整条新曲线(继承源曲线 range/segments);旁带 `gradient` 点分析作对照 |
| `derivative_curve.scad` | 一元函数求导:`gradient` 作用于 `curve`,在 `at [px, 0]` 处求 f′(x),画分析点 / 切线 / 法向;展示缺省 `show = [point, normal, tangent]` |
| `derivative_rules.scad` | 求导法则对照:同一条竖直线 x = px 上对照积法则 / 商法则 / 幂+链式 / 对数链式 / 三角复合;显式 `show = [point, tangent]` 的用法 |
| `partial_derivative_surface.scad` | 二元函数偏导:`gradient` 作用于 `surface` 求 ∂f/∂x,∂f/∂y,画法向与切平面(`tangent_plane`);含鞍面 fx=fy=0 处切平面水平的演示 |
| `divergence_vector_field.scad` | 散度 `div(F)`:线性源/汇场 div = a+b+c 与刚体旋转场 div ≡ 0 的对照 |
| `curl_vector_field.scad` | 旋度 `curl(F)`:刚体旋转场 curl = (0,0,2w) 与保守梯度场 curl = (0,0,0) 的对照 |
| `laplacian_scalar_field.scad` | 拉普拉斯 `laplacian(s)`:抛物面 `z = a*x² + b*y²` 的 `∇²f = 2a + 2b`(处处常数,拖滑块直接改数值) |
| `laplacian_harmonic.scad` | 拉普拉斯四类源对照(curve/surface/二维与三维 implicit)与调和场 `∇²f = 0`;球体/隐式场先投影到等值面再取值 |
| `sphere_gradient.scad` | 隐式场:球体 `derivative` -> ∇f 向量场,`gradient` 在空间点取 ∇f 并沿梯度投影到球面画点/法向/切平面;`at spherical(θ, φ)` 球坐标写法与 `in cyclic [...]` 循环类系数(φ 越界回绕转圈);`implicit f(x,y,z)=0` 的通用写法 |

> 说明:DSL 层求导有两种形态--`derivative` 语句把符号导数画成整条函数
> 曲线/曲面;`gradient` / `divergence` / `curl` / `laplacian` 在指定点做
> 点分析(切线/法向/切平面/散度/旋度/二阶标量),符号引擎都在编译期完成
> 求导;`jacobian` 语法可解析但编译期报"暂未实现",向量场的逐分量
> 拉普拉斯 `∇²F` 也会报"暂不实现".
> 详见 `../docs/derivatives-guide.md`.
>
> 第三种形态是"隐式场":`sphere`(球体)与 `implicit` 对象没有解出因变量,
> `derivative` 对它们求的是梯度 ∇f(产物是 `vector_field`),`gradient` 的
> `at` 给空间点并先投影到等值面.示例见 `sphere_gradient.scad`.

## 其他主题

| 文件 | 覆盖功能 |
| --- | --- |
| `object_addition.scad` | 对象相加:`curve c3 = c1 + c2` / `surface s3 = s1 + s2` 按名引用同类对象;链式相加,前向引用,区间取交集,显式 `range` 优先,相加结果照常参与 `region` / `derivative` |
| `intersection_line_curves.scad` | 曲线 ∩ 曲线 -> 离散交点 |
| `intersection_surfaces.scad` | 曲面 ∩ 曲面(平面)-> 三维交线 |
| `double_integral_region.scad` | `region` 面积图形作域的二重积分(辛普森法) |
| `animation_box_rotations.scad` | 动画片段 `rotate` 列表按顺序播放 |
| `Zemlya.scad` | 地球与三星覆盖:3 颗同轨道面均布(相隔 120°)的卫星,各自一道切于地表的"覆盖波束"圆锥(底沿即覆盖圈);`param h` 拖动轨道高度,可看覆盖圈扩大,两极极冠缩小但**永不消失**--文件头给出"3 颗卫星不可能覆盖全球"的证明与各级高度的覆盖纬度表 |
