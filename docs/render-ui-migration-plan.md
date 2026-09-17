# 渲染精度,双目标架构与桌面端(Linux)分离方案

本文回答:**性能是卖点,three.js 的 WebGPU 不稳定,WebGL 不接受;如何分离一个桌面端出去?**

**已拍板:**

| # | 决定 | 内容 |
| --- | --- | --- |
| C1 | Web 端保留 | 整项目保留在 repo 与 GitHub Pages 上,现状"相对完整" |
| C2 | 桌面端只做 Linux | Wayland + Vulkan + KDE Plasma. Windows / macOS **不做**(无测试设备) |
| C3 | 桌面优先,Web 滞后 | 桌面是开发主场,Web 接收回移 |
| C4 | 滞后差距由作者人工控制 | 不设回移粒度制度 |
| C5 | **编译器能共享是最好** | 目标方向:语言语义单源(不强求,但按目标设计接口) |
| C6 | 强制共享的只有数学核心 | 即便编译器暂不共享,`math_rs` / `render_rs` 也是硬共享 |
| C7 | **精度参照 = matplotlib 绘出图片的精度** | 具体指标与优先级实现时再定 |
| C8 | 计划阶段不动代码 | 所有分期待立项;本文件是唯一交付物 |

证据来源分三类,文中标注:

- **[实测]** 项目自己的文档与代码;
- **[一手]** 在本机已下载的依赖源码上直接核对(winit 0.30.13 / egui 0.31.1 /
  egui-winit 0.31.1 / egui-wgpu 0.31.1 / wgpu 24.0.5 / epaint 0.31.1 /
  epaint_default_fonts 0.31.1);
- **[外部]** matplotlib 官方文档与源码,给出链接.

---

## 一/结论摘要

1. **C7 选得很好,因为 matplotlib 能当"可执行的判据"用,而不只是一个形容词**(§2):
   它开源,可脚本化,输出确定性,并且**自带图像对比测试体系**(`image_comparison` /
   pytest-mpl). 同一场景可以真的生成一张对照图来比,而不是靠人眼看.
2. **三维不能用它当参照,而且这是 matplotlib 自己的结论**(§2.3):
   mplot3d 把三维降成"二维 + z-order 标量",官方 FAQ 原话是"相交的三维物体**无法**
   正确渲染",并说这类问题要等"OpenGL 支持加进所有后端". **本项目的核心图形
   (实体积分体 + 区域面 + 曲面相交)正好是它明确做不到的那一类.** 所以精度目标要
   拆开:二维与输出品质照 matplotlib,三维另立.
3. **公式排版的"第一否决项"可以降级了**(§3):matplotlib 自带 `mathtext` --
   "轻量 TeX 子集解析器与排版引擎",官方说**不需要装 TeX**,且"排版引擎是对 Knuth
   TeX 布局算法的直接改编". 它支持的子集**覆盖**本项目用到的全部宏,输出**字形**,还
   内置 `cm`(Computer Modern)/ `stix` 等数学字体集. 于是 R1 从"要造一个排版器"
   变成"要对齐一个已知算法".
4. **egui 侧的"画布"是齐的,缺的只是布局引擎**(§3.6):`Painter` 有
   `line`/`circle`/`rect_filled`/`text`/`image`/裁剪,`epaint::Shape` 有 11 个变体含
   **`Mesh`**,`QuadraticBezier`,`CubicBezier`,还有 **`Callback`** 逃生口可接自己的
   wgpu 管线;`Context::load_texture` 可上传自建图集. **唯一硬边界**:`PathShape.fill`
   文档原话"**只支持凸多边形**",而字形轮廓是凹的且带洞 -- 所以必须走
   **图集 / 带洞三角化 / 离屏光栅 / 自绘管线** 四条路线之一,不能照 Agg 那样直接填轮廓.
5. **编译器共享比预想的干净**(§4):TS 语义层今天本来就是"Rust 原语之上的编排层"
   -- `CompileController` 只做 `parseMiko`(wasm)+ `compileScene(...)`,而后者内部
   已经在调 wasm 的矩阵运算与 `symbolic_derivative`. 共享不是新增耦合,而是把已经
   在 Rust 里的能力收拢回 Rust.
6. **但"共享编译器"与上一版那条更正互为对称面**(§4.3),必须现在选定:
   不共享 -> IR 只是"未回移",生成器可选;共享 -> IR 是运行时共享产物,字段只在一侧
   就是真错,生成器/校验**必需**. 这条会影响阶段 1 的**接口形状**,不能拖到切换时再定.
7. **性能杠杆(§6.1):多核 CPU 4-8x > GPU compute(数量级) > 去 wasm 边界
   1.2-3x**,而现状是单核. Web 端的天花板是部署级的(GitHub Pages 发不出
   COOP/COEP 头 -> 拿不到 wasm 线程;WASM 无硬件 `sin/cos`).
8. **共享边界核实结果**(§7.1):`math_rs` 是 7 个 `*_core.rs` 纯逻辑 + 29 个薄的
   `#[wasm_bindgen]` 入口皮,**已有 189 个原生测试**;`render_rs` 8 个原生测试,
   0 处浏览器 API. 桌面端还顺带省掉 541 行只为边界存在的编解码器(§8.1).
9. **Wayland 中文输入法链路已核实为通**(§7.3),剩三个具体待验点.

---

## 二/精度口径:matplotlib

### 2.1 参照目标的可测分解

"matplotlib 成图的精度"落到可判定的性质上是这些:

| 性质 | matplotlib 的做法 | 本项目的现状 |
| --- | --- | --- |
| **线宽是物理尺度** | linewidth 以 **point**(1/72 inch)计,随 dpi 缩放 | `Line2` 像素线宽,"线宽 3"无物理含义 |
| **解析覆盖率抗锯齿** | Agg 由解析路径算覆盖率 | 只有 `antialias: true` 的 MSAA 采样 |
| **文字是矢量文本** | FreeType 在目标 dpi 栅格化/矢量输出 | 64x64 canvas 位图精灵,`pixelRatio` 夹在 2 |
| **矢量后端精确坐标** | SVG / PDF / PS 导出精确路径 | 无此输出 |
| **确定性** | 同输入 + 同版本 -> 同输出 | 可作为对比前提 |

### 2.2 一个容易搞错的点:snap

matplotlib 有 `path.snap`(以及 `Artist.set_snap`):对**直线类**路径(轴,网格,
刻度线)做像素对齐,让它们"清晰";对**数据曲线**不做,保留亚像素位置.
所以"matplotlib 的精度"不等于"全部亚像素精确",而是**按元素类型区分策略**:

- 网格/轴/边框 -> 像素对齐(允许/鼓励 snap)
- 数据曲线/曲面 -> 亚像素精确

本项目照搬这条策略即可,不必二选一. 这是 C7 落地时最容易做错的地方.

### 2.3 三维不能用它当参照(matplotlib 自己的原话)

mplot3d 官方 FAQ [[外部]](https://matplotlib.org/stable/api/toolkits/mplot3d/faq.html):

> "from some viewing angles a 3D object would appear in front of another object,
> even though it is physically behind it ... it is currently an **intractable
> problem**, and cannot be fully solved until matplotlib supports 3D graphics
> rendering at its core. The problem occurs due to the reduction of 3D data down
> to **2D + z-order scalar** ... the intersection of two 3D objects (such as
> polygons or patches) **cannot be rendered properly** in matplotlib's 2D
> rendering engine. This problem will likely not be solved until **OpenGL support
> is added to all of the backends**."

三条结论:

1. mplot3d 是画家算法 + 逐 collection 的 z-order,没有深度缓冲.
2. **相交曲面的正确渲染是它明确做不到的** -- 而 `intersection(s1, s2)` 正是本项目
   的核心示例.
3. 它自己指出的出路("给后端加 GPU 三维渲染")正是桌面端在做的事(Vulkan/wgpu).

所以 C7 的正确切分是:

| 维度 | 参照 |
| --- | --- |
| 二维绘图(曲线/区域/刻度/文字)与输出品质 | **matplotlib** |
| 三维(曲面/实体/相交/透明) | 另立:深度缓冲 + OIT 这类正规做法;**目标是明确优于 mplot3d**,而不是对齐它 |

### 2.4 参照实现是可执行判据

可以真正落地的用法(实现时挑一种即可):

1. **矢量对照(最强)**:matplotlib 出 SVG,取其中路径坐标;本项目导出同一场景的投影
   坐标;比几何.
2. **图像对照**:matplotlib 出 PNG,与本项目渲染同场景同 dpi 的 PNG 比(需要先对齐
   相机/坐标变换与样式,只比几何与边缘品质,不比配色与默认字体).
3. **借它的测试方法**:matplotlib 自己的 `image_comparison` 装饰器与 `pytest-mpl`
   就是做这件事的,方法可直接照搬,不必自创.

前置条件:本机当前**没有安装 matplotlib**(只读文件系统也装不了),所以这一套要在你的
开发环境里跑.

---

## 三/公式排版:mathtext 就是现成参照

### 3.1 它是什么

matplotlib 官方文档 [[外部]](https://matplotlib.org/stable/users/explain/text/mathtext.html):

> "Matplotlib implements a **lightweight TeX expression parser and layout engine**
> and Mathtext is the subset of Tex markup that this engine supports."
> "TeX does **not** need to be installed to use Mathtext because Matplotlib ships
> with the Mathtext parser and engine. The Mathtext layout engine is a fairly
> direct adaptation of the **layout algorithms in Donald Knuth's TeX**."

即:**一个自带,自洽,有文档的 TeX 子集排版引擎**,不是"调用外部 TeX".

### 3.2 它支持的子集覆盖本项目全部用法

| mathtext 支持 | 本项目是否用到 |
| --- | --- |
| `\frac{}{}`, `\genfrac`, `\binom`(任意嵌套) | 用到 `\frac` |
| `\sqrt[]{}`(可带根指数) | 用到 `\sqrt` |
| `\left...\right` 自动伸缩定界符 | 用到 `\left` `\right` |
| `\mathrm` `\mathit` `\mathtt` `\mathcal` `\mathbb` `\mathfrak` `\mathsf` `\mathbfit` | 用到 `\mathrm` `\mathbf` |
| `\text{...}`(保留空格) | 用到 `\text` |
| 重音 `\hat` `\bar` `\vec` `\overline` `\widehat` `\widetilde` ... | 未用(但白得) |
| 大符号表(含 `\int` `\sum` `\infty`,希腊字母,`\nabla` `\partial` 等) | 用到 `\nabla` `\partial` `\int` `\iint` `\iiint` `\theta` `\pm` `\le` `\times` `\cdot` `\cap` `\ln` `\cos` |
| 上下标与运算符上下限 | 用到(积分限) |

**是超集,不是差集.** 本项目用到的宏(去重共约 20 个)全在覆盖范围内.

### 3.3 为什么正好合用

- **输出是字形**,不是 HTML/MathML -- 与 GPU 侧的绘制模型相容(具体怎么画见 §3.6).
- **内置数学字体集**:`dejavusans` / `dejavuserif` / **`cm`(Computer Modern)** /
  `stix` / `stixsans`,还支持自定义字体 + `mathtext.fallback` 回退. 这直接解决
  §7.4 里"egui 自带字体缺 `∇ ∬ ∭`"的那一半问题(数学字体部分;CJK 仍要自带).
- 布局算法有权威出处(Knuth TeX),不是某个库的私有做法.

### 3.4 许可

- matplotlib **只收 BSD 兼容代码**,自身是 BSD 兼容许可(基于 PSF 许可);其许可页
  [[外部]](https://matplotlib.org/stable/devel/license.html)写明 BSD 类"基本可以随意
  使用,包括并入专有产品".
- 本项目是 **AGPL-3.0**,方向兼容(宽松 -> copyleft 可以并入),**需保留原许可与
  归属声明**.
- 字体各自许可需单独登记(DejaVu / STIX / Computer Modern 都是宽松类,但要逐个写明).

### 3.5 V1 判据随之改写

原来是"自己排出来看能不能看",现在可以变成**可判定**:

> 取本项目实际产生的 LaTeX 串(含 `\frac`,带上下限的 `\int`,`\iiint`,`\nabla`,
> `\sqrt`),分别交给 mathtext 与本项目排版器,**比较字形位置与基线**(矢量对照),
> 给出最大偏差数字.

风险描述也跟着变:R1 不再是"要不要自研排版器",而是"能把 mathtext 的布局算法对齐到
什么程度".

### 3.6 渲染底座:egui 有画布等价物,但路径填充只支持凸多边形

**画布是齐的 [一手]**(`epaint 0.31.1`):

| 层 | 内容 |
| --- | --- |
| `egui::Painter` | `line_segment` / `line`(折线)/ `hline` / `vline` / `circle` / `circle_filled` / `circle_stroke` / `rect` / `rect_filled` / `rect_stroke` / `image` / `text` / `galley` / `add(Shape)`,外加 `with_clip_rect` / `set_clip_rect`(canvas 的裁剪等价物) |
| `epaint::Shape` | 11 个变体:`Noop` / `Vec` / `Circle` / `Ellipse` / `LineSegment` / `Path` / `Rect` / `Text` / **`Mesh`** / `QuadraticBezier` / `CubicBezier`,另有 **`Callback(PaintCallback)`** |
| 纹理 | `Context::load_texture(..)` 可上传自建纹理(例如自制字形图集) |
| 逃生口 | `Shape::Callback` + `egui_wgpu::CallbackTrait`(`prepare` / `finish_prepare` / `paint`),可在 UI 矩形里跑自己的 wgpu/Vulkan 管线 |

**一条硬边界 [一手]**:`PathShape.fill` 的文档原话是

> "Fill is only supported for convex polygons."

填充走 `fill_closed_path`(扇形三角化),**凹多边形与带洞轮廓会画错**;而字形轮廓恰恰
是凹的且带洞(`o` `∂` `∫` `√` 都是). 所以**不能像 Agg 那样直接填字形轮廓**.
(描边 `PathStroke` 没有这个限制,但描边得到的是空心轮廓,不是实心字形.)

**因此字形有四条绘制路线**:

| 路线 | 做法 | 质量 | 工作量 |
| --- | --- | --- | --- |
| **A 图集(推荐)** | mathtext 布局 -> `ab_glyph` 光栅化字形到自建纹理图集 -> 发 `Shape::Mesh` | 与 egui 自身文字同级 | 中.**egui 自己的文字就是这么做的**,可照抄 |
| B 自己三角化轮廓 | 取字形轮廓 -> **带洞三角化** -> `Shape::Mesh` | 高(真矢量,任意缩放不糊) | 高 |
| C 离屏光栅 -> 贴图 | 数学 -> 路径/SVG -> 光栅器 -> 纹理,按 LaTeX 串缓存 | 中(缩放会糊,除非按需重光栅) | 低. 可复用现有 512 条模板缓存模式 |
| D 自绘管线 | `Shape::Callback` 里跑自己的管线(如 SDF 字形) | **最高,可超过 Agg** | 高 |

**两个有利条件 [一手]**:

1. **`ab_glyph` 已经是 epaint 的依赖** -- egui 的文字就是 `ab_glyph::FontArc` 解析 +
   按像素尺寸光栅化 + 纹理图集(`text/font.rs` / `texture_atlas.rs`). 所以 A 路线
   **不需要新增字体栈**.
2. 分数横线/根号横线这类"规则线"就是 `Shape::Rect`;mathtext 的输出阶段是"在 (x, y)
   以尺寸 s 画字形" + "画一条横线",这两件事分别落到 A/B/D 与 `Rect` -- **没有阻抗
   失配**.

**质量上的诚实提醒**:epaint 的抗锯齿是 **feathering**(屏幕空间 1px 渐变),不是 Agg
那种解析覆盖率. 所以 C7 里"解析覆盖率抗锯齿"这一条,用 A 路线只能在字形级逼近;要真
做到 Agg 同级得上 B 或 D. 这条差距应当在 V1 里被量化,而不是被假设不存在.

**结论**:egui 缺的从来不是"画布",而是"数学布局引擎";而布局引擎的参照(mathtext)已
有.**需要选的是上面哪条绘制路线** -- V1 的判据因此再加一条:定下路线,并给出该路线下
的质量对照.

---

## 四/编译器共享

### 4.1 现状:TS 语义层已经是"Rust 原语之上的编排层"

**[实测]**:

```
CompileController.ts(165 行)
  └─ parseMiko(source)                    # wasm(compiler_rs)
  └─ compileScene(ast, params, matrixOps) # TS 语义层
        ├─ matrixOps = createWasmMatrixOps()        # wasm(math_rs)
        └─ expression.ts: symbolic_derivative 等    # wasm(math_rs)
```

也就是说:今天 TS 的 7,346 行语义层**本身就在反复调用 Rust**. 共享编译器不是增加
耦合,而是**把已经在 Rust 里的能力收拢回 Rust**.

### 4.2 收益与代价

| | 内容 |
| --- | --- |
| **收益 1** | 语言语义单源:语言/编译类新功能 **Web 端零移植**,滞后问题在最大的一块上消失 |
| **收益 2** | Web 编译期少穿边界:每次 `symbolic_derivative` / 矩阵运算都是一次跨边界调用(固定 1.3-2.8 µs/次,已有实测),共享后 Web 侧只剩"source + params -> IR"一次调用 |
| **收益 3** | 桌面端直接调用,无边界,无 JSON |
| **代价 1** | Web 侧要改成一次调用,并**删除 `src/compiler/dsl` 的 7,346 行 TS 语义**(你已定 Web 要保持在 github.io 可用,所以这一步必须在对拍通过之后) |
| **代价 2** | IR 契约变成**运行时共享产物**,于是生成/校验从"可选"变"必需"(见 4.3) |
| 不变 | 渲染器与 UI 仍各写各的:Web 端 three.js 的新对象类型仍要回移 |

### 4.3 与上一版那条更正互为对称面

本文上一版有一条更正:"在不共享编译器的前提下,IR 生成器不是防漂移必需品". 那条
在**它的前提下**依然成立. 现在 C5 把目标改成"共享",前提翻转,结论也随之翻转:

| 前提 | IR 的性质 | 生成器/校验 |
| --- | --- | --- |
| 不共享(各写各的) | 两份**独立产物** | 可选,只省手写 35 条类型 |
| **共享(单源)** | 一份产物,**两个消费者** | **必需**:字段只在一侧就是真错 |

所以这不是前后矛盾,而是同一个决定的两种后果. **必须先定 C5 的落地方式,才能定
IR 契约要不要生成器.**

### 4.4 路径

1. **阶段 1**:在 native 建 Rust 编译器,**Web 完全不动**(符合 C8). 交付物按"将来要
   被 Web 消费"的形状设计(接口:source + paramOverrides -> SceneIR;错误:类型化 +
   span;IR:有单一真相源).
2. **对拍**:24 个 `example/*.miko` + `DslCompiler.test.ts`(2,615 行)作为一致性语料库,
   两端产出逐字段等价 IR.
3. **阶段 1.5(切换)**:Web 侧改为消费 wasm 编译器,删除 TS 语义. 这一步动 Web 代码,
   需要你单独放行.
4. 切换后 Web 只保留三块:DOM UI,three.js 渲染器,边界适配(§8.1).

### 4.5 为什么现在就要定口径

因为**接口形状**取决于它:如果目标是共享,阶段 1 就必须把"可被 wasm 侧消费"当成硬
约束(错误表示,IR 序列化,增量/缓存边界);否则很可能做成一个只能桌面自用的形状,
到阶段 1.5 再返工. 这就是 C5 写进已拍板表而不是"以后再说"的原因.

---

## 五/双目标架构

```text
Cargo.toml (workspace)
  src/math/math_rs          # 硬共享:7 个 *_core.rs 纯逻辑 + 29 个 wasm 入口皮
                            #          189 个原生测试
  src/render/render_rs      # 硬共享:曲面采样与后处理(8 个原生测试,0 浏览器 API)
  src/compiler/compiler_rs  # 已有 pest 解析;<-- 阶段 1 补语义,目标是两端共用
  src/render/render_gpu     # 新增:wgpu 渲染器,仅 native
  src/app/app_egui          # 新增:egui 外壳,仅 native

  # Web:保留在 repo + GitHub Pages,滞后跟进
  index.html / css / src/ui / src/app(DOM 外壳)
  src/compiler/dsl(TS 语义,<-- 阶段 1.5 之后删除)
  src/render(three.js)/ src/compute(Worker)
  src/wasm + src/math/adapters + rowMajorMatrix   # 仅 Web 需要的边界编解码层
```

桌面端不做 wasm 目标(C2):`render_gpu` 与 `app_egui` 不需要 `wasm-bindgen`,不需要
`web-sys`,不需要处理浏览器沙箱与配额.

---

## 六/为什么桌面优先,Web 滞后

### 6.1 Web 端的天花板与性能杠杆

| 能力 | 原生 | Web(WebGPU) | 差距性质 |
| --- | --- | --- | --- |
| **CPU 多核并行** | `rayon`,stable Rust | wasm 线程需 nightly + `-Z build-std` + atomics,且**必须跨域隔离**;GitHub Pages 不支持自定义响应头 | **结构性(部署级)** |
| **硬件 `sin/cos`** | 有 | **无**(已实测,是 wasm 放大的主因) | **结构性** |
| **GPU compute** | Vulkan compute 全能力 | 可用但受沙箱与配额限制 | 部分 |
| **内存与边界** | 共享内存 | 1.3-2.8 µs/次 + 0.8 ms/MiB + Worker 一跳 | 结构性 |
| 深度 / 透明 / 线宽 / 文字 | 自定 | **同样可以自定** | **无差距** |
| 浏览器覆盖 | 自己分发 | WebGPU 87.35%;Firefox 仍默认关闭;Safari 26 还需 macOS Tahoe | 结构性 |

| 杠杆 | 量级 | 现状 |
| --- | --- | --- |
| **多核 CPU(rayon)** | 8-16 核取 **4-8x** | **完全没有**,单核 |
| **GPU compute** | solid n=96 344/743 ms,向量场 46^3 40/67 ms,全可并行 | 未开采 |
| 去 wasm 边界 | **1.2-3x** | 已基本吃尽 |

### 6.2 两个目标的分工

| | Web(repo + GitHub Pages) | 桌面(新) |
| --- | --- | --- |
| 入口 | 零安装,一个链接 | 需安装 |
| 平台 | 任何现代浏览器 | **仅 Linux / Wayland / Vulkan** |
| 性能 | 单核 + three.js | 多核 + GPU compute |
| 三维 | 现状 | 深度缓冲 + OIT(优于 mplot3d) |
| 演进角色 | 滞后:接收回移,差距由作者控制 | 主场 |

---

## 七/事实基线

### 7.1 共享集的纯净度

| crate | 结构 | 原生可测性 | 浏览器 API |
| --- | --- | --- | --- |
| `math_rs` | 7 个 `*_core.rs` 纯逻辑(`eval` / `field` / `geometry` / `integral` / `intersection` / `sampling` / `transform`)+ `symbolic/` + `lib.rs` 的 29 个 `#[wasm_bindgen]` 入口皮 | **189 个 `#[test]`**;文档写明 `cargo test -p math_rs --release` 可复现原生数字 | 0 处 |
| `render_rs` | `surface_utils.rs` + `config.rs` + 薄 `lib.rs` | **8 个 `#[test]`** | **0 处** |

29 个入口里只有 5 个返回 JSON `String`,其余返回类型化结构体或数值. **JSON 边界只存在
于 Web 那一侧.**

### 7.2 代码规模与耦合

| 层 | 行数(非测试) | 备注 |
| --- | --- | --- |
| `src/ui` | 7,004 | 84% 落在引用 DOM 的文件里;只有 15 个文件 / 1,116 行是纯逻辑 |
| `src/render` | 5,449 | 30 个文件 `import three` |
| `src/compiler` | 7,346 | 语义全在 TS;`compiler_rs` 只做 pest 解析 -> JSON AST |
| `src/app` | 1,410 | 编排层(`CompileController` 仅 165 行) |
| `src/compute` | 1,429 | Worker + 调度 |
| `src/contract` | 1,156 | IR;**`ir.ts` 是 35 条纯类型声明,0 处运行期代码** |
| `src/config` | 652 | 含 `renderConfig.ts` / `numericConfig.ts` |
| `src/math`(TS) | 665 | 大量是边界编解码适配器(§8.1) |
| **TS 非测试合计** | **26,294** | 另有测试 13,521 行 / 72 个文件 |
| Rust(现有) | 19,686 | 数学与渲染核心已是原生可测的纯逻辑 |

另外 `#viewport` 是 `position: absolute; inset: 0`,而 `SceneManager.resize()` 取整个
窗口尺寸,所以三维按整窗居中,被面板遮挡 **[实测]**. egui 的 `SidePanel` +
`CentralPanel` 天生修好这一类问题.

### 7.3 Wayland 中文输入法:已核实为通

| 层 | 事实 |
| --- | --- |
| winit 0.30.13 | `linux/wayland/seat/text_input/mod.rs` 绑定 `zwp_text_input_manager_v3` / `zwp_text_input_v3`(经 sctk);处理 `Preedit{cursor_begin, cursor_end}` / `Commit` / `enable` / `disable`,并按 `ime_purpose` 设 content type |
| egui-winit 0.31.1 | 把 `WindowEvent::Ime` 映射为 `ImeEvent::{Enabled, Preedit, Commit, Disabled}`;调用 `set_ime_allowed` 与 `set_ime_cursor_area`(候选窗定位) |
| egui 0.31.1 | `TextEdit` 的 `ImeEvent::Preedit` 分支把组字文本插入缓冲区并标为选区(**内联显示组字**);`Commit` 时替换 |

三个待验点:

1. **fcitx5 是否走 `text-input-v3`**(winit 未实现旧的 `input-method-v1/v2`).
2. **`Ime::Preedit(_, None)` 被当 disable**:`egui-winit/src/lib.rs:371` 把"preedit 但
   不带 cursor"归入 disable,某些合成器不送 cursor 时会误判.
3. **组字期间会写文本缓冲区**,会触发 `changed` 并进 undo 栈;需确认"组字期间不触发
   编译/不打断撤销粒度",与现有 `EditorHighlight` 的口径对齐.

### 7.4 egui 侧其余一手数据

| 事项 | 事实 |
| --- | --- |
| 自带字体 | Ubuntu-Light(比例)/ Hack(等宽)/ NotoEmoji / emoji-icon-font |
| CJK | **四个字体全无** `U+4E00`/`U+6587`/`U+4E2D` -> 必须自带 CJK 字体 |
| 数学字形 | 比例字体 Ubuntu-Light **缺** `U+2207 ∇`,`U+222C ∬`,`U+222D ∭`;Hack 全有. (**数学字体可由 mathtext 的 `cm`/`stix` 方案补**,见 §3.3) |
| `TextEdit` 能力 | `layouter`(自定义高亮)/ `code_editor()` / `desired_rows` / `lock_focus`;撤销重做内建 |
| `TextEdit` 缺口 | 游标只有一个 `CursorRange`,**无多光标**;**无查找/替换 UI** |
| 无障碍 | `accesskit` 可选 feature,Linux 走 AT-SPI,可用性待验证 |
| 编辑器 crate | [`egui_code_editor` 0.2.15](https://docs.rs/egui_code_editor/0.2.15/egui_code_editor/)(依赖 egui 0.32,**该版本已被 yank**)= 行号 + 关键字着色,水平约等于本仓库的 `dslHighlight`,换它买不到东西 |
| 字体栈 | epaint 用 **`ab_glyph`** 解析并光栅化字形进纹理图集(§3.6 路线 A 可直接复用) |
| 环境 | 本机 Wayland + Vulkan 1.4.341 可用;所需 crate 已在本地 registry(无 eframe);兄弟项目 `xxx_electric_arc` 已用同栈 |

### 7.5 three.js 的四类不精确(Web 侧现状记录)

**(1) f32 贯穿 GPU 路径**:顶点全是 `Float32Array`,three.js `Matrix4` 也是 f32;
CPU 侧是 f64. **精度断点在渲染层**.
**(2) 线宽是屏幕像素**:`SceneManager.ts:88` 注释原文"支持像素线宽".
**(3) 透明逐对象排序**:`depthWrite: false` + 手写 `renderOrder = 2/3` +
`polygonOffset = -1`. 半透明面片嵌套时合成结果依赖遍历顺序.
**(4) 刻度是 64px 位图精灵**:`labelCanvasSize: 64`,`labelFont: 'Bold 36px Arial'`,
`setPixelRatio` 夹在 2.

以上四类与 UI 框架无关;桌面端怎么改,按 C7 的参照来定,细节实现时再排.

### 7.6 wgpu 的成熟度

- `wgpu` 24.0.5 **[一手]**:features 含 `webgpu` 与 `webgl`(本方案只需 native).
- **Firefox 的 WebGPU 就建在 `wgpu`(wgpu_core)+ Naga 上** [[外部:Mozilla wiki](https://wiki.mozilla.org/Platform/GFX/WebGPU)].
- 不稳定的是 three.js 的 `WebGPURenderer` 抽象层,例如缓存管线在 `matrixWorld` 行列式
  变号后保留旧 `frontFace` [[外部:three.js#33779](https://github.com/mrdoob/three.js/issues/33779)]
  -- `scale([1.5, 1, 1])` 一旦出现负号就可能踩到.

---

## 八/重复与差距

### 8.1 重复的三层,以及顺带省掉的一层

| 重复项 | Web 侧 | 桌面侧 | 性质 |
| --- | --- | --- | --- |
| **UI** | DOM/CSS 7,004 行 | egui | 静态重复 |
| **渲染器** | three.js 5,449 行 | `render_gpu`(wgpu) | 是"换渲染器"而非复制 |
| **编译器语义** | TS 7,346 行 | Rust | **C5 的目标就是消掉这一项** |

以下三处共 **541 行**只为 wasm/JSON/扁平数组边界存在,**桌面端没有对应物**:

| 文件 | 行数 |
| --- | --- |
| `src/wasm/init.ts` / `matrixOps.ts` / `workerRuntime.ts` | 152 |
| `src/math/adapters/IntersectionMath.ts` / `coefficientUtils.ts` | 272 |
| `src/math/matrix/rowMajorMatrix.ts` | 117 |

### 8.2 差距大小由人控制,但"移错了"要能判定

落后量由作者控制(C4),不是机制问题. 真正需要工具的是**移植做错了却看不出来**,而
工具只有一个且很便宜:**一致性语料库** -- `example/*.miko`(24 个)+
`DslCompiler.test.ts`(2,615 行),两端对同一语料产出逐字段等价 IR. 它在 C5 共享方案
下同时充当**切换 Web 的验收**(§4.4 第 2 步).

### 8.3 考虑过并否决:在桌面端嵌 JS 引擎复用 TS 编译器

`quickjs` / `deno_core` 能让编译器零重复,但 IR 结构体在 Rust 侧**无论如何都要存在**
(渲染器要用),省下的只有语义层,代价是给性能优先的原生程序加一层永久 JS 运行期依赖.
**否决.**

---

## 九/第一个里程碑(基本 Vulkan)

| 项 | 内容 |
| --- | --- |
| 目标 | 窗口(Wayland)+ Vulkan 交换链 + 清屏 + 画一条 `curve` + 相机投影与 three.js **亚像素对照** |
| 范围 | 只做坐标轴/网格/刻度 + 曲线;不做透明/OIT/reversed-Z/字形图集(那些按 C7 的参照,实现时再排) |
| 验收 | 同场景同相机下,抽样顶点投影到屏幕的坐标与 three.js 一致(给出最大偏差数字);`cargo test` 覆盖投影与刻度生成 |
| 风险 | three.js 的相机/视口约定(NDC,Y 轴方向,像素比)容易对不上. **先写投影断言再写渲染** |
| 降级 | 若编译器还没搬完,可先用现有 JSON AST 作输入 |

这一步同时验证 three.js 退场时序:它与 three.js 版并存,可切换,随时回退.

---

## 十/后续分期(待立项)

工作量口径与 `docs/teaching-roadmap.md` 一致:`0.5d` / `3-5d` / `1w+`.

| 阶段 | 内容 | 验收要点 |
| --- | --- | --- |
| **1 语言语义搬 Rust** | 用 2,615 行测试 + 24 个示例把 TS 既有行为在 Rust 复现(bootstrap);**接口按"将来被 Web 消费"设计**(§4.5);附 `ir.ts` -> Rust 结构生成 | 两端逐字段等价 IR;`cargo test` 全绿 |
| **1.5 切换 Web 到 Rust 编译器** | Web 侧改为一次调用,删除 TS 语义;需单独放行(动 Web 代码) | 语料库在 Web 侧同样通过;页面行为不变 |
| **2 第一个里程碑** | 见 §9 | 投影亚像素一致 |
| **3 多核与 GPU compute** | ① 采样与求积上 `rayon` ② 向量场/solid 采样搬 compute shader | 与单核逐位或给定容差内一致;GPU 与 CPU 对拍给容差 |
| **4 精度专项** | 按 C7 的参照:二维与输出品质对齐 matplotlib;三维另立(深度缓冲 + OIT);文字按 §3.6 选定的路线 | 细节与优先级实现时再定 |
| **5 egui 外壳** | 面板占位,参数/视图/对象列表/过程页/编辑器/诊断 | 先过 §14 验证;24 个示例能加载运行 |
| **6 Web 回移** | 作者按自己的节奏(C3/C4) | 每次回移跑一次 §8.2 语料库 |

阶段 3 的风险:GPU 无 f64,积分累加需补偿求和(Kahan/成对求和)才能与 CPU f64 对上;
`rayon` 引入后 `CompiledEvaluator` 要每线程一份 context.

---

## 十一/风险登记

| # | 风险 | 说明 | 缓解 |
| --- | --- | --- | --- |
| R1 | 公式排版(**已降级**) | 有 mathtext 作参照(§3);**具体形态是 §3.6 的凸多边形限制** -- epaint 不能直接填凹的带洞字形轮廓 | 按 §3.5 做矢量对照;在 §3.6 四条路线里选一条;子集外输入**报错** |
| R2 | 中文 IME | 链路已核实为通(§7.3),剩三个待验点 | 先做 §14 V2 |
| R3 | CJK 字体 | egui 自带字体全无 CJK(§7.4) | 子集化 Noto Sans CJK 之类的正文字体;**数学字体走 mathtext 的 `cm`/`stix` 方案** |
| R4 | 无障碍 | `accesskit` Linux 走 AT-SPI,不等同现有 ARIA 工作 | 显式接受降级,不要假装等价 |
| R5 | 移植做错却看不出来 | 落后量由作者控制,但"移错了"是静默的 | §8.2 语料库 |
| R6 | 分发 | 仅 Linux/Wayland/Vulkan | 确认目标发行版 Vulkan 驱动与 Plasma 版本;`xxx_electric_arc` 已证明本机可行 |
| R7 | three.js 退场时序 | 阶段 2 之前 `src/render` 仍是桌面端唯一渲染器 | 并存可切换,保留 A/B 对照 |
| R8 | 无人测试的平台 | Windows/macOS 明确不做 | 文档写明"仅 Linux" |
| R9 | 共享编译器带来的 Web 改造 | 阶段 1.5 要删 7,346 行 TS 语义并改 Web 调用路径,而 Web 现在是"相对完整,不动"的 | 对拍通过再切;切换本身单独放行;保留 `dist` 可回退 |
| R10 | 精度对照的**前置不可用** | 本机没有 matplotlib(只读文件系统),判据暂时跑不起来 | 在你的开发环境装 matplotlib;或先用矢量对照(不需要渲染) |
| **R11** | **文字质量上限**(新增) | epaint 的抗锯齿是 feathering,不是解析覆盖率;走 A 路线只能在字形级逼近 Agg | 在 V1 里量化这条差距;要 Agg 同级则选 §3.6 的 B 或 D |

---

## 十二/明确不要做的事

| 项 | 理由 |
| --- | --- |
| 不要在计划阶段动代码(C8) | 所有分期待立项 |
| 不要用 mplot3d 当三维精度参照 | matplotlib 自己说相交三维物体渲染不正确(§2.3) |
| **不要试图用 `PathShape.fill` 画字形轮廓** | 只支持凸多边形,字形是凹的且带洞(§3.6) |
| 不要给桌面端的 crate 加 wasm 目标 | C2 之后没必要;`render_gpu`/`app_egui` 保持 native |
| 不要用 three.js 的 `WebGPURenderer` 作为"上 wgpu"的捷径 | 它是抽象层且有自己的正确性问题(§7.6) |
| 不要为了"跨平台"选 egui-wasm | 已在做 native;Web 端已有完整实现 |
| 不要在桌面端嵌 JS 引擎复用 TS 编译器 | §8.3 |
| 不要手改 IR 的两份副本(**若确定共享**) | 共享时 IR 是运行时产物,漂移即真错(§4.3) |
| 不要期待换语言带来"游戏级顺滑" | 去边界上限 1.2-3x;顺滑靠多核 + GPU compute + 拖动期质量分级 |
| 不要为省 1-6 ms 的拷贝去改 Rust 返回结构 | 已实测为 1% 量级 |
| 不要自研超出 mathtext 子集的 LaTeX | 超出即报错,不做静默退化 |
| 不要在阶段 2 之前删 three.js 或改 Web 外壳 | A/B 对照基线;Web 要保持可用 |

---

## 十三/待拍板点

| # | 问题 | 状态 |
| --- | --- | --- |
| P1 | Web 端处置 | **已定:保留在 repo + GitHub Pages** |
| P2 | 桌面端平台 | **已定:仅 Linux / Wayland / Vulkan / KDE Plasma** |
| P3 | 演进节奏 | **已定:桌面优先,Web 滞后,差距人工控制** |
| P4 | 精度参照 | **已定:matplotlib 成图质量(二维与输出品质);三维另立** |
| P5 | 数学核心共享 | **已定:硬共享(`math_rs` + `render_rs`)** |
| P6 | 编译器共享 | **已定方向:共享为最好**;落地方式见 P7/P8 |
| P7 | 编译器共享的**时机** | 待定:阶段 1 就按"可被 Web 消费"设计(推荐),还是先做桌面自用形状,以后再返工 |
| P8 | 阶段 1.5(切换 Web 并删 TS 语义)是否做 | 待定,依赖 P7 与对拍结果 |
| **P9** | **字形绘制路线(§3.6 的 A/B/C/D)** | 待定. 建议 A(图集),理由:egui 自己的文字就是这条路,`ab_glyph` 已在依赖里 |
| **P10** | 何时开工 §9(基本 Vulkan) | **唯一待定的行动项** |

---

## 十四/验证清单

进入阶段 5(egui)之前必须过;V4-V6 可与 §9 并行:

| # | 验证项 | 判据 |
| --- | --- | --- |
| V1 | **公式排版(已降级为"对齐")** | 取实际产生的 LaTeX(含 `\frac`,带上下限的 `\int`,`\iiint`,`\nabla`,`\sqrt`),与 **mathtext** 做矢量对照(字形位置与基线),给出最大偏差;并**定下 §3.6 的绘制路线**(A 图集 / B 带洞三角化 / C 离屏光栅 / D 自绘管线)与该路线下的质量对照(含 feathering vs 解析覆盖率这条差距的实测) |
| V2 | **编辑器与 Wayland 中文 IME** | `TextEdit` + 移植后的高亮 `layouter`;在 KDE Plasma Wayland 上用 fcitx5 输入中文注释(覆盖 §7.3 三个待验点);撤销重做;500 行滚动 |
| V3 | **三维与布局** | `CentralPanel` 内用 `egui_wgpu::CallbackTrait` 画一条曲线,确认面板真的占位(相机宽高比 = 可见区),并与 three.js 做像素对照 |
| V4 | **多核收益** | 给 `integrate_solid` n=96 与向量场 46^3 加 `rayon`,测真实倍率与核数关系 |
| V5 | **直接调用共享核心** | native 下绕过 `#[wasm_bindgen]` 皮直接调 `*_core`,确认不需要任何 JSON/扁平数组编解码;189 个原生测试可复用 |
| V6 | **matplotlib 判据跑通** | 在装有 matplotlib 的环境生成对照图/SVG,并证明"同一场景 -> 可比较"这条链能跑;顺带定下比什么(几何/边缘品质)不比什么(配色/默认字体) |

配套通用验收(沿用 `docs/teaching-roadmap.md` §7.3):`cargo fmt` /
`cargo clippy -D warnings` / `npm test` / `npm run typecheck` 全绿;Web 侧保持可构建,
可部署到 GitHub Pages.
