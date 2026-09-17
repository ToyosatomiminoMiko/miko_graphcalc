# GraphCalc 文档

本项目最重要的两个指标:数学准确性与性能

- [求导与偏导(微分分析)使用指南](derivatives-guide.md) -- DSL 用户文档:
  在 GraphCalc 里如何求一元导数,偏导数,散度,旋度,以及 `show` /
  `at` / 参数联动等用法.
- [求导与偏导实现梳理](derivatives-impl.md) -- 面向维护者的实现与
  检查记录:功能现状,与 gradient 的耦合方式,代码路径,未实现项与
  未提交的工作区改动.
- [WASM 边界成本与求值迁移实测](wasm-boundary-cost.md) -- 回答"积分是否已迁到
  Rust""WASM↔JS 拷贝到底贵不贵";记录各场景单次耗时基线,把计算搬进 Rust/WASM 的
  **实测收益表**(边界固定开销 ~1.1 µs,`CompiledEvaluator` context 占求值成本
  94–99%),P0(求值器去 `HashMap<String, f64>`)的前后实测数字,以及明确不该
  迁移的项(P1 solid 可视化重复采样待设计).
- [渲染精度,双目标架构与桌面端(Linux)分离方案](render-ui-migration-plan.md) --
  评估文档:回答"性能是卖点,three.js 的 WebGPU 不稳定,WebGL 不接受,如何分离
  桌面端".**已拍板**:①Web 端保留在 repo + GitHub Pages;②桌面端只做
  Linux/Wayland/Vulkan/KDE Plasma(无设备测 Windows/macOS);③**桌面优先,Web
  滞后,差距由作者人工控制**;④**数学核心硬共享,编译器共享是目标方向**;⑤**精度
  参照定为 matplotlib 绘出图片的精度**.
  三个值得单记的结论:
  ①**精度参照是可执行判据**:matplotlib 开源,可脚本化,输出确定,自带
  `image_comparison`/pytest-mpl 图像对比体系,同一场景能真的生成对照图;而
  **三维不能用它当参照** -- mplot3d 官方 FAQ 明说三维被降成"二维 + z-order 标量",
  相交三维物体"无法正确渲染",出路是"给后端加 GPU 三维渲染". 本项目的核心图形
  (实体积分体 + 区域面 + 曲面相交)正是它做不到的那类,故精度目标拆成"二维与输出
  品质照 matplotlib,三维另立".
  ②**公式排版的否决项可降级**:matplotlib 自带 `mathtext`(轻量 TeX 子集解析器与
  排版引擎,官方称"不需要装 TeX"且"排版算法是对 Knuth TeX 的直接改编"),其支持
  子集**覆盖本项目用到的全部宏**,输出**字形**,内置 `cm`(Computer Modern)/`stix`
  等数学字体集,许可为 BSD 兼容(可并入本项目 AGPL-3.0,需保留归属). 验证判据随之
  从"能不能排出来"改为"与 mathtext 做矢量对照".
  ③**egui 侧的"画布"是齐的,缺的只是布局引擎**:`Painter` 有 `line`/`circle`/
  `rect_filled`/`text`/`image`/裁剪,`epaint::Shape` 有 11 个变体含 `Mesh`,
  `QuadraticBezier`,`CubicBezier`,还有 `Callback` 逃生口可接自己的 wgpu 管线.
  **唯一硬边界**:`PathShape.fill` 文档原话"**只支持凸多边形**",而字形轮廓是凹的且
  带洞,所以不能像 Agg 那样直接填轮廓 -- 字形须走**图集 / 带洞三角化 / 离屏光栅 /
  自绘管线** 四条路线之一(推荐图集:egui 自己的文字就是这么做的,`ab_glyph` 已在
  依赖里). 另记:epaint 的抗锯齿是 feathering,不是 Agg 的解析覆盖率,这条差距要在
  验证时量化.
  ④**编译器共享比预想干净**:TS 语义层今天本就是"Rust 原语之上的编排层"
  (`CompileController` 只做 `parseMiko`(wasm)+ `compileScene`,后者已在调 wasm 的
  矩阵运算与 `symbolic_derivative`),所以共享不是新增耦合而是收拢;但**它决定了 IR
  契约要不要生成器** -- 不共享则两份独立 IR(生成器可选),共享则一份产物两个消费者
  (生成器必需),这条会影响阶段 1 的接口形状,所以现在就要定口径.
  另含:Web 端四项结构性天花板与性能杠杆排序(**多核 4-8x > GPU compute > 去 wasm
  边界 1.2-3x**,现状是单线程),共享集核实(`math_rs` 189 个原生测试,`render_rs`
  8 个且 0 处浏览器 API),three.js 的四类不精确,**Wayland 中文输入法链路已核实为
  通**(三个待验点),第一个里程碑(基本 Vulkan 骨架),以及六项验证与十一项风险登记.
- [教学化改造路线图](teaching-roadmap.md) -- 规划文档:把 GraphCalc 从"能看
  结论的可视化器"做成**教学工具 + 自学教材**.含数学表达力与教学动线缺口
  清单,分阶段任务表(每项带依赖/工作量/验收/风险/降级),单课与习题设计
  模板,自学侧导读计划,以及"明确不要做的事"清单.
- [方程求解过程的展示设计](equation-solving-process.md) -- 设计文档:过程展示
  为什么要占"另一页"而不是"更大的盒子".含现有面板空间实测(底栏一屏约 14 行,
  右栏通高约 27 行),右栏改标签页的 DOM 结构与四个控制器耦合点,过程视图的
  递等式/依据分区(只读列表),三级披露阈值,以及"一期展示层,二期几何联动,
  三期求解内核"的分期口径,以及 §11 的**联立方程组 v1**(统一词汇,精确消元 /
  数值路径的能力边界).对应路线图的 `B5`.
- [不定积分与微分方程:设计计划](calculus-suite-plan.md) -- 设计文档:两个新
  功能复用既有"声明级符号内核 + 过程页"骨架;原函数走系统化初等积分(线性性 /
  查表 / 换元 / 分部 / 有理函数部分分式),微分方程走可解类型清单(可分离 /
  线性 / Bernoulli / 齐次 / 恰当 / 二阶常系数),所有产物一律回代求导验证;
  原函数作为可渲染对象下发,初值直接跟在方程后.含分期,验收与路线图 §7.1 的
  受控豁免口径.

- [三期完整规划与设置](plan3.md) -- 执行清单:微分方程(DSL 语法,导数记号归一,
  八类方程的判定与步法,解族/斜率场可视化,两层编译,IR 与展示,示例清单),
  四期收尾增强,测试计划,验收口径,以及三个待拍板的设计点(P1 解族怎么画 /
  P2 积分常数怎么处理 / P3 隐式解怎么办)的备选方案与推荐.
- [不定积分使用指南](antiderivative-guide.md) -- DSL 用户文档:怎么用
  `antiderivative` 求原函数(它同时是求值条目与可渲染对象),选项,参数与曲面
  积分,当前能算的范围与明确算不出来的形状,以及"回代验证"这条凭据怎么读.
- [微分方程使用指南](ode-guide.md) -- DSL 用户文档:怎么用 `ode` 解微分方程
  (斜率场/特解/解族的命名与引用),选项,可解类型清单与明确的能力边界,隐式解
  的标注口径,参数保持符号,过程页步骤链与回代验证,以及常见报错排查.

配套示例见 [`../example/README.md`](../example/README.md)(求导/偏导
示例为 `derivative_curve.miko`,`derivative_rules.miko`,
`partial_derivative_surface.miko`,`divergence_vector_field.miko`,
`curl_vector_field.miko`;隐式场梯度为 `sphere_gradient.miko`).
