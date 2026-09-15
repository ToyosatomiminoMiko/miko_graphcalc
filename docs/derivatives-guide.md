# 求导与偏导(微分分析)使用指南

求导与偏导有两种形态:

- **导数函数图像**(本站恢复的"出导后的图像"):用 `derivative` 语句新建
  一个对象,其表达式是源对象的符号导数(`curve` 求 x 导 -> `curve`,
  `surface` 求 x/y 偏导 -> `surface`),绘制成整条导数曲线/曲面.见 §1.
- **指定点的分析**(切线/法向/切平面):由"微分分析"算子承载,符号引擎在
  编译期求导,运行时在 `at` 指定的点求值.一元导数 = `curve` 上的
  `gradient` 分析,偏导 = `surface` 上的 `gradient` 分析,向量场的导数
  组合 = `divergence` / `curl` 分析,标量场的二阶组合 = `laplacian`.
  见 §2 起.

实现层面的讨论见 [derivatives-impl.md](derivatives-impl.md).

## 1. 导数函数图像:derivative 语句

要"出导后的图像"(画出整条导数函数曲线/曲面),用 `derivative` 语句新建
一个对象:

```text
derivative 名称 = derivative(源对象 [, 变量]);
```

- 源对象是 `curve` -> 生成一条 `curve`,`变量` 缺省为 `x`(只对 x 求导);
- 源对象是 `surface` -> 生成一个 `surface`,`变量` 必须写 `x` 或 `y`
  (求 ∂f/∂x 或 ∂f/∂y 的偏导曲面);
- 函数名遵循项目全名习惯,不缩写(不做 `deriv`).

生成的导数对象与手写的 `curve`/`surface` 完全同构:走同一条归一化/采样/
渲染管线,`range` 与 `segments` 缺省继承源对象(导数画在同一区间),颜色
缺省取自调色板;源对象表达式的自由参数(如 `a`)同样成为导数对象的系数,
拖动滑块会实时重画导数图像.它也进入对象列表与公式区,公式同时保留微分
算子与求导结果:curve 写作
$y=\frac{\mathrm{d}}{\mathrm{d}x}(\text{源函数})=f'(x)$,surface 偏导写作
$z=\frac{\partial}{\partial y}(\text{源函数})=\frac{\partial f}{\partial y}$.
算子括号里是**源函数**而不是已求出的导函数(高阶导数每一步都读作"对上一
式再求一次导"),等号右侧才是符号引擎算出的导函数;两者缺一不可--只留算子
就看不出求导结果,只留结果又看不出这是求导对象.导数对象可被再次引用
(链式求导得到更高阶导数).

示例:

```text
param a = 1 in [0.2, 4, 0.1];
curve c = sin(a * x) { range = [-8, 8]; };
derivative dc = derivative(c);      // dc = a * cos(a * x),一条新曲线
derivative d2c = derivative(dc);    // (可选)二阶导数 -a²·sin(a·x)
```

示例文件 `example/derivative_graph.scad`.若只想在某一点看切线/法向,
用下面的微分分析(`gradient`)而不是 `derivative`(§2).

## 2. 一元函数求导:curve 上的 gradient

语法:

```text
gradient 名称 = grad(曲线名) at [px, 0] {
    show = [point, normal, tangent];   // 可选,见 §6
};
```

对曲线 `y = f(x)` 求 x = px 处的一阶导数 f′(px):

- **point**:曲面/曲线上的分析点 (px, f(px), 0)(黄色圆点);
- **tangent**:过分析点的切线(绿色直线),方向 = (1, f′, 0),其斜率
  就是 f′(px);
- **normal**:切线法向(红色箭矢),方向 = (−f′, 1, 0) 归一化.这正是
  隐式曲线 `y − f(x) = 0` 的梯度方向:f′ > 0 时斜向左上,f′ < 0 时斜
  向右上,f′ = 0 时竖直向上.

`at` 在语法上至少要两个数;曲线求导只需 x 坐标,惯例写 `[px, 0]`
(第二个数对曲线不参与求值).

示例:`example/derivative_curve.scad`
(`f(x) = sin(a*x)`,f′ = a·cos(a·x));求导法则对照(积/商/幂/对数/
三角复合)见 `example/derivative_rules.scad`.

## 3. 二元函数偏导:surface 上的 gradient

语法:

```text
gradient 名称 = grad(曲面名) at [px, py] {
    show = [point, normal, tangent_plane];  // 可选
};
```

对曲面 `z = f(x, y)` 求 (px, py) 处的两个一阶偏导:

```text
fx = ∂f/∂x ,  fy = ∂f/∂y
```

- **point**:曲面上的点 (px, py, f(px, py));
- **normal**:曲面法向(红色箭矢),方向 = (−fx, −fy, 1) 归一化;
- **tangent_plane**:过分析点的切平面(半透明蓝色四边形),法向即上面的
  曲面法向.当 fx = fy = 0(如鞍面/极值点处)时法向竖直向上,切平面水平.

示例:`example/partial_derivative_surface.scad`(正弦波面 +
鞍面,并演示 fx=fy=0 时切平面水平的直观情形).

## 3.1 隐式场:球体与 implicit 对象的梯度

`curve`(`y=f(x)`)与 `surface`(`z=f(x,y)`)都已经解出因变量,`at` 给的是
自变量.球体与 `implicit` 对象没有因变量,它们的方程是隐式的:

```text
sphere s = [cx, cy, cz] { radius = r; };   // f = |p − c|² − r² = 0
implicit H = f 表达式 { level = c; };       // f = c,缺省 c = 0
```

`implicit` 的维度由表达式里出现的坐标变量推断:含 z 是三维等值面,只含
x/y 是二维等值线.

- `derivative(s)` / `derivative(H)`:**对隐式场求导 = 梯度 ∇f**,产物是
  一个 `vector_field`(不是 curve/surface),分量是 f 对 x/y/z 的偏导;
  公式区写成 `∇(f) = (f_x, f_y, f_z)`;
- `gradient g = grad(s) at [x, y, z]` / `grad(H) at [...]`:在空间点取
  ∇f.该点一般不在等值面上,因此编译期沿 ∇f 做牛顿投影,把它落到
  `f = level` 上再画:
  - **point**:投影到等值面上的点;
  - **normal**:该点单位法向 `∇f/|∇f|`;
  - **tangent_plane**:过该点,以法向为法线的切平面(三维);
  - **tangent**:二维隐式曲线的平面内切线 `(−f_y, f_x, 0)`.

`at` 语法上至少两个坐标,三维场的第三个缺省按 0 补全(建议写全
`[x, y, z]`).若点落在 ∇f = 0 的临界点(例如球心),法向没有定义,编译期
直接报错,而不是画一个错误方向.

示例:`example/sphere_gradient.scad`.

### 球坐标写法:`at spherical(...)`

球体这类"点天然用 `[r, θ, φ]` 描述"的对象,分析点可以显式用球坐标给出:

```text
gradient gs = grad(s) at spherical(θ, φ);      // r 省略,取球体半径
gradient gs = grad(s) at spherical(r, θ, φ);   // 写全
```

- `spherical(...)` 是**显式声明**,不会隐式改变 `at [x, y, z]` 的笛卡尔
  语义;参数允许嵌套括号(`at spherical(asin(0.5), pi / 4)`);
- 省略 `r` 时源对象必须是 `sphere`(球坐标只有两个角度需要给);
- θ/φ 的约定由 `src/config/numericConfig.ts` 的
  `analysis.sphericalAngleConvention` **全局配置**(两个约定都已实现并单测
  覆盖,改这一处即可切换):

  | 约定 | θ | φ |
  | --- | --- | --- |
  | `physics`(默认,物理/ISO) | 从 +Z 轴量起的极角 ∈ [0, π] | xy 平面内从 +X 轴起的方位角 ∈ (−π, π] |
  | `math`(部分教材) | 方位角 | 从 +Z 轴量起的极角 |

- 球坐标相对**世界原点**(不是"以球心为原点");球心不在原点时,换出的点
  仍会由 ∇f 投影落到球面上;
- 结果列表会把分析点换算回 `[r, θ, φ]` 一并显示,用的是同一份约定配置;
- 结果列表的求值条目默认折叠,只排一行 KaTeX(如 `∇f(1, 2, 3)`);点该行
  (浏览器原生 `<details>` 行为)展开后才给完整过程:先给算子的**符号展开**
  `∇f = (f_x, f_y, f_z)`(与 `derivative` 对象一样先保留算子,系数保持
  符号),再给该点的数值结果 `∇f(P)`,最后是 `P`,球坐标回显,`f(P)` 与
  切线 `T`.

### 循环类系数:`in cyclic [...]`

球坐标的两个角度在**圆周**上取值:φ 的 `-π` 与 `π` 是同一个方向,θ 扫到底
再转一圈也回到起点.普通参数在区间两端是"夹住",拖到端点就停;要让角度
从 `-3.14159` 跳到 `3.14159`,继续转圈,需要在声明处显式写成循环类系数:

```text
param theta = 0.9 in cyclic [0, 3.14159, 0.01];
param phi = 0.6 in cyclic [-3.14159, 3.14159, 0.01];

gradient gs = grad(s) at spherical(theta, phi) {
    show = [point, normal, tangent_plane];
};
```

- **必须显式声明**:`cyclic` 写在 `in` 与 `[...]` 之间.不写 `cyclic` 的
  参数即使区间恰好是 `[-π, π]` 也照旧夹取,编译器不从范围或名字猜周期;
- 语义:越界值按区间长度取模回绕到 `[min, max)`(半开区间,因为 `min` 与
  `max` 是圆周上的同一点).`φ = 7` 回绕成 `7 − 2π ≈ 0.7168`,参数面板的
  数字输入同样回绕;初始值写在域外也会被回绕,不再报"初始值不在区间内";
- 回绕只实现一处(`src/math/paramValue.ts`),编译期(系数物化 / 求值 scope)
  与参数面板共用同一口径,所以滑块位置,表达式求值,结果列表三者一致;
- 参数面板里循环参数的名字后带 `↻`;
- 每条参数行末端的 `↺` 把该参数退回 `in` 前的声明值:循环参数退的是回绕后的
  主值(`param φ = 7 in cyclic [...]` 的声明值在编译期就成了 `7 − 2π`),
  已经停在该值上时按钮置灰;
- 典型用途就是球坐标角度(见上)与任何周期量;`at spherical(...)` 的坐标
  形式本身不受影响,循环参数只是让滑块能转圈.

V1 边界:`box`/`cone`/`cylinder`/`frustum` 的隐式函数是 max 型分段函数,
暂不支持(报"暂不支持 ... 体积对象");隐式场/球体的梯度分析在对象局部
坐标里进行,不套用静态 `transform`(与 curve/surface 的既有分析一致).

## 4. 向量场的散度与旋度:div / curl

语法(`vector_field F = [P, Q, R]`,变量为 x/y/z):

```text
divergence 名称 = div(F) at [px, py, pz];
curl      名称 = curl(F) at [px, py, pz];
```

- **散度**(标量,结果面板打印数字):
  `div F = ∂P/∂x + ∂Q/∂y + ∂R/∂z`;
- **旋度**(向量,结果面板打印向量;为零时只保留测量点,不画箭矢):
  `curl F = (∂R/∂y − ∂Q/∂z, ∂P/∂z − ∂R/∂x, ∂Q/∂x − ∂P/∂y)`.

示例:`example/divergence_vector_field.scad`(有源场与无源
旋转场对照),`example/curl_vector_field.scad`(有旋旋转场
与无旋梯度场对照).注意"无旋"与"无散"是彼此独立的两个性质:线性
源/汇场 `[a*x, b*y, c*z]` 无旋但有散.

## 5. 标量场的拉普拉斯算子:laplacian

语法(`curve` / `surface` / `implicit` / `sphere` 这些**标量场**源):

```text
laplacian 名称 = laplacian(源对象) at [px, py, pz] {
    show = [point];   // 可选,见 §6
};
```

拉普拉斯算子是"梯度的散度",也是标量算子:标量场进,标量出,

```text
∇²f = ∇·(∇f) = f_xx + f_yy + f_zz
```

- **point**:源图形上的分析点(黄色圆点).与 `gradient` 的曲面点口径
  一致:curve 上是 `(px, f(px), 0)`,surface 上是 `(px, py, f(px,py))`,
  隐式场/球体上是沿 `∇f` 投影到等值面后的点(并回显球坐标);
- 数值 `∇²f(P)` 直接排进结果列表的摘要行,展开细节里先给二阶导的
  符号展开 `∇²f = f_xx + f_yy + f_zz`(系数保持符号),再给该点的数值.

**维度口径与 `gradient` 一致**--哪几个方向算作"独立变量"由源对象决定:

| 源 | 独立变量 | `∇²f` |
| --- | --- | --- |
| `curve` | 只有 x | `f''(x)` |
| `surface` | x, y(不含 z) | `f_xx + f_yy` |
| `implicit`(二维) | x, y | `f_xx + f_yy` |
| `implicit`(三维)/`sphere` | x, y, z | `f_xx + f_yy + f_zz` |

`∇²f = 0` 的函数叫**调和函数**:它既没有"源"也没有"汇".经典例子是
`f = x² − y²`(双曲抛物面)与线性函数;而 `f = x² + y²` 的 `∇²f = 4`
处处为正,是"处处有源"的场(注意:水平集 `x² + y² = R²` 本身是圆,
但水平集函数并不调和,两者不要混为一谈).

示例:`example/laplacian_scalar_field.scad`(抛物面 `z = a*x² + b*y²`,
`∇²f = 2a + 2b` 处处常数,拖动滑块直接改变数值),
`example/laplacian_harmonic.scad`(curve / surface / 二维与三维 implicit
四类源对照,含调和场数值恒为 0).

**暂不实现**:向量场的**逐分量拉普拉斯**
`∇²F = (∇²P, ∇²Q, ∇²R)`(结果仍是向量)当前不提供;对
`vector_field` 写 `laplacian` 会在编译期报
"逐分量拉普拉斯 ∇²F 暂不实现"而不是被当成标量场静默处理.`jacobian`
同样未实现(报"暂未实现").

## 6. 算子 × 对象可用矩阵与校验

| 算子 | 对象 | 结果 | `at` 至少 |
| --- | --- | --- | --- |
| `gradient grad(...)` | `curve`(一元求导) | 点/切线/法向 | 1 个数(语法上写 2 个,如 `[px, 0]`) |
| `gradient grad(...)` | `surface`(偏导) | 点/法向/切平面 | 2 个数 |
| `gradient grad(...)` | `implicit`(二维) | 点/切线/法向 | 2 个数 |
| `gradient grad(...)` | `implicit`(三维)/`sphere` | 点/法向/切平面 | 2 个数(第三个缺省 0) |
| `laplacian laplacian(...)` | `curve` / `surface` / `implicit` / `sphere` | 标量 | 与同源的 `gradient` 相同 |
| `divergence div(...)` | `vector_field` | 标量 | 3 个数 |
| `curl curl(...)` | `vector_field` | 向量 | 3 个数 |
| `derivative` | `implicit`/`sphere` | ∇f 向量场(`vector_field`) | - |
| `derivative` | `box`/`conic` | 暂未支持(报错) | - |

编译期会做全套声明级校验并给出语句级错误(定位到行/列):

- 引用的对象必须存在;算子不能用于 `point`/`vector`/体积/`region` 等;
- 等号右侧函数名必须与算子匹配(`gradient g = curl(s1)` 会报错,
  不会静默当作 gradient 处理);函数名一律全名,无缩写;
- `at` 坐标必须可求值(参数/数字/四则运算);
- `laplacian` 只接受标量场源,对 `vector_field` 给出"逐分量暂不实现"的
  明确诊断(见 §5);`jacobian` 语法可解析,但编译期抛出"暂未实现";
- 除 `show` 外不接受其他选项;`show` 拼写错误直接报错.

## 7. show 元素与默认值

四种可画元素:`point`,`normal`,`tangent`(仅 curve 求导),
`tangent_plane`(仅 surface 偏导).默认值按源对象分派:

| 分析 | 缺省 show |
| --- | --- |
| curve 的 gradient(一元求导) | `[point, normal, tangent]` |
| surface 的 gradient(偏导) | `[point, normal]` |
| `implicit`(二维)的 gradient | `[point, normal, tangent]` |
| `implicit`(三维)/`sphere` 的 gradient | `[point, normal]` |
| divergence / curl | `[point, normal]` |
| laplacian(标量算子) | `[point]` |

`laplacian` 的 IR 里向量恒为零向量(标量算子没有方向),渲染层据此不会
画出箭矢,因此缺省只给 `point`;显式写 `show = [point, normal]` 也不会
画出任何东西,`normal` 对标量算子没有意义.

其中 `point` 测量点(黄色圆点)与场景 `point` 对象**共用同一个点的
定义**(`PointRenderer`):半径/全局可见跟随右侧"点"面板
("设定大小 / 按比例缩放 / 全局可见"),默认半径 0.2,不另设独立尺寸.

显式写 `show` 即精确指定(例如 `show = [point, tangent]` 省略法向).
切线方向存于 IR 的 `tangent = (1, f′, 0)`(未归一化,Δx 半长由
`renderConfig.analysis.tangentHalfLength` 控制),曲面分析该项为 null.

## 8. 符号求导支持范围

curve/surface/向量场的表达式在编译期由 Rust 符号引擎求导,支持:

- 运算法则:和/差,**积法则**,**商法则**,**幂法则**与一般底数
  `f^g`(含链式法则自动展开);
- 内置函数(sin cos tan asin acos atan sinh cosh tanh exp ln log10
  log2 sqrt cbrt abs sign)及别名(sec csc cot pow log 等);
- 只对"自由变量"求导(x / y / z),`param` 声明的系数当作常数;
  常量 `pi`/`e` 与纯数字照常折叠.
- abs/sign:符号结果用 sign 语义;在 0 处导数不存在,数值求值返回 NaN.

`derivative` 语句把符号求导结果做成新对象,直接画出导数函数曲线/曲面
(§1).`laplacian` 复用同一套符号引擎:对一阶偏导再求一次偏导得到
`f_xx`/`f_yy`/`f_zz`,不新增任何微分规则(§5).未支持:`jacobian`
(报"暂未实现");向量场的逐分量拉普拉斯 `∇²F`(报"暂不实现",见 §5);
数组/向量表达式直接求导(报错);混合偏导(fxy)暂无 DSL 入口(可用
`derivative` 链式求导得到 f″ 等仅含单个自由变量的高阶导).

## 9. 参数联动

曲线/曲面/向量场表达式里出现 `param`,求导在编译期完成一次,求值随
滑块刷新,因此拖动 `a`/`px`/`py` 等参数时,切线/法向/切平面以及
div/curl/laplacian 数值都会实时更新(相关示例文件头都注明了每个
滑块的作用).
