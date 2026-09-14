# miko_graphcalc

入口:`https://toyosatomiminomiko.github.io/miko_graphcalc/`

GraphCalc 的当前入口是 `index.html`,它加载 `src/main.ts`,再由
`DslApp` 驱动 `.miko` DSL.

这是符号计算引擎(Symbolic Computation Engine)和Plotter,
作为计算机代数系统(Computer Algebra System, CAS)是不完全的.

## 数据流

```text
源码 textarea
  -> Rust/WASM 解析器 parse_miko()
  -> AstProgram
  -> DslCompiler.compileScene()
  -> SceneIR
  -> Plotter / CameraManager / DslIntegralRenderer
  -> Three.js 场景
```

## 当前支持范围

- 内置示例菜单:左侧「源码」面板标题栏的"示例"按钮打开分组清单
  (求导 / 偏导 与 其他主题),选中即整段替换编辑器源码并立即运行.
  示例文本在构建期由 `import.meta.glob(..., { query: '?raw' })` 从
  `example/*.scad` 内联进 bundle(运行时不 fetch,离线可用),`example/`
  仍是唯一真相源;清单与文件集的一一对应由
  `src/ui/examples/exampleCatalog.test.ts` 守住.载入走"全选 +
  `execCommand('insertText')`"覆盖而不是直接赋值,浏览器原生撤销栈得以
  保留,一次 Ctrl+Z 就能退回载入前手写的代码(Chromium 152 / Firefox 155
  实测;撤销环节的取舍见 `src/ui/examples/replaceEditorSource.ts`)
- `param`:参数面板与实时刷新;`param φ = 0 in cyclic [-3.14159, 3.14159, 0.01]`
  显式声明**循环类系数**(球坐标方位角这类圆周量),越界值按区间长度回绕到
  `[min, max)` 而不是夹到端点;不写 `cyclic` 的参数一律按普通参数处理.
  每条滑块行末端的 `↺` 把该参数退回 `in` 前的声明值(`param a = 1 in [...]`
  里的 `1`),单项复位不必重按"运行";已经停在该值上时按钮置灰
- `curve` / `surface` / `vector_field` / `point` / `vector`:基础几何对象
- 对象相加:`curve`/`surface` 的表达式可以按名引用同类对象,`+` 就是逐点
  函数相加(`curve c3 = c1 + c2` 即 y = f1(x) + f2(x),`surface s3 = s1 + s2`
  即 z = f1(x,y) + f2(x,y));加减乘除按普通表达式优先级生效,链式相加
  (`curve c4 = c3 + c1`)与任意声明顺序都成立,成环报错.引用在归一化**之前**
  展开成被引用对象自己的表达式与区间:没有显式 `range` 时定义域取被引用
  对象区间的交集(x 区间 / x-y 矩形,交集为空报错),显式 `range` 优先;
  curve 只能引用 curve,surface 只能引用 surface,引用体积/点/向量/implicit
  对象或 `derivative` 等产物会报错而不是悄悄变成自由参数.相加结果照常参与
  `region` / `integral` / `derivative`;示例 `example/object_addition.scad`
- `region`:面积图形(两条曲线围成的 x 型带状区域,绘制在 z=0 平面),可
  作为二重积分的积分域;边界曲线只允许不带静态变换/动画的纯函数曲线
- `matrix` / `transform`:对象场景变换
- `animation`:单矩阵动画片段,可通过对象 `animation = [...]` 绑定并顺序播放
- `derivative`:求导语句,把符号求导结果做成一个新对象并画出整条导数
  函数曲线/曲面(curve -> curve 求 x 导,surface -> surface 求 x/y 偏导);
  语法 `derivative 名称 = derivative(源对象 [, 变量])`,函数名用全名不缩写;
  示例 `example/derivative_graph.scad`
- `implicit`:`f(x,y)=0`(二维等值线)或 `f(x,y,z)=0`(三维等值面)的隐式
  标量场,dim 由表达式里出现的坐标变量推断,`level` 选项给出方程右端
  (缺省 0).V1 只有方程本体参与 `gradient` / `derivative` 分析,本体的
  marching squares/cubes 采网渲染留到后续
- 隐式场求导:体积对象(`sphere`)与 `implicit` 对象没有解出因变量,
  `derivative(sphere|implicit)` 求的是梯度 ∇f,产物是一个 `vector_field`
  (复用向量场的采样/渲染管线);`gradient g = grad(sphere|implicit) at
  [x, y, z]` 在空间点取 ∇f,先沿梯度牛顿投影到等值面再画点/法向/切平面
  (3D `at` 语法上至少两个坐标,第三个缺省按 0 补;∇f=0 处报错).
  分析点也可显式写球坐标 `at spherical(θ, φ)`(r 取球体半径)或
  `at spherical(r, θ, φ)`;θ/φ 约定由 `numericConfig.analysis.
  sphericalAngleConvention` 全局配置(默认 physics:θ 从 +Z 量起;可切
  math),结果列表同时回显 `[r, θ, φ]`.示例 `example/sphere_gradient.scad`
- `gradient` / `divergence` / `curl`:点分析(求导/偏导经这些微分分析
  算子暴露:一元求导 = curve 的 gradient,偏导 = surface 的 gradient,
  div/curl = 向量场的一阶偏导组合;用户文档见 `docs/derivatives-guide.md`)
- `gradient` 的 `show` 元素:通用 `point`/`normal`;曲面(偏导)与三维
  隐式场/球体可加 `tangent_plane` 画切平面,一元曲线与二维隐式曲线可加
  `tangent` 画切线;曲线求导与二维隐式曲线不写 `show` 时默认画
  `[point, normal, tangent]`,让切线始终可见,其余分析默认
  `[point, normal]`.示例集见 `example/README.md`:
  一元求导 `example/derivative_curve.scad` 与求导法则对照
  `example/derivative_rules.scad`,偏导 `example/partial_derivative_surface.scad`,
  散度/旋度 `example/divergence_vector_field.scad` 与 `example/curl_vector_field.scad`
- `integral`:数值积分 + 黎曼/梯形/辛普森/勒贝格可视化,方法为
  `trapezoid`/`simpson`/`lebesgue`,以及黎曼系列 `riemann:left`/
  `riemann:right`/`riemann:mid`;裸写 `riemann` 等价于 `riemann:left`.
  被积函数缺省是源对象表达式(curve 的 y=f(x),surface 的 z=f(x,y));
  region/solid 源可用选项 `integrand` 指定任意被积函数(缺省 `"1"`,
  即求区域面积/体积),变量一律为世界坐标 x/y/z
- 积分域:1D `curve` 区间,2D `surface` 矩形,2D `region` 面积图形,
  3D 体积实体(`sphere`/`box`/`cylinder`/`cone`/`frustum`);IR 用显式
  `dim`/`domainKind` 描述域,不再用 range 长度推断维度
- 2D 黎曼端点方法(right/mid)已在二维曲面矩形域放开,采样端 = 方法端,
  数值与可视化同源;region 域二重积分(累次 B1 / 网格指示 B2),体积域
  三重积分(世界网格 C1 / 轴向切片 C2),解析式对拍见 math_rs 单元测试
- `sphere` / `box` / `cylinder` / `cone` / `frustum`:透明体积图形;
  `cylinder`/`cone`/`frustum` 统一映射为同一个 `conic` IR 类型
- `intersection`:求交.曲线参与的求交得到离散交点,曲面/体积参与的求交得到空间交线;
  支持 曲线∩曲线,曲线∩曲面,曲线∩体积,曲面∩曲面,曲面∩体积,体积∩体积

相机状态不进入 DSL:透视/正交与旋转锁定由右侧 UI 开关控制,
`camera:view` 按钮只负责预设视角.

## 界面样式配置

代码区字体,KaTeX 字号与面板几何**不做运行时设置界面**,也不落 localStorage:
唯一真相源是 `src/config/uiConfig.ts`,启动时由 `src/ui/applyUiConfig.ts`
写成 `:root` 上的 CSS 变量,再由 `css/editor.css`(源码编辑区),
`css/panels.css`(面板与对象列表),`css/controls.css` 与 `css/base.css`
的 `var()` 消费.

- `UI_CONFIG.editor`:`fontFamily`/`fontSize`/`lineHeight`/`tabSize`,
  作用于左面板源码编辑区(textarea,行号栏与源码高亮层共用同一组值);
  `gutterMinWidth` 是行号槽宽下限;
- `UI_CONFIG.formula.katexFontSize`:底部对象列表里 KaTeX 公式的字号,
  单位 em,基准是 `.object-expr` 的 16px;
- `UI_CONFIG.panel`:三个面板的尺寸与右侧"参数区 / 视图区"的分割比例.
  拖拽的夹取上下限(`sideMin/MaxWidth`,`footerMin/MaxHeight`,
  `splitMin/MaxRatio`)CSS 用不到,只活在这里;默认尺寸,折叠尺寸,
  两个最小高度与默认分割比例 CSS 首帧要消费,因此在 `css/base.css` 的
  `:root` 有一份同名兜底,而 `#app` 的 `--left/right-panel-width` 与
  `--footer-height` 只是 `var()` 派生,不再重复数字.

改完刷新页面即可.`css/base.css` 的 `:root` 兜底只负责脚本执行前的首帧,
必须与 `UI_CONFIG` 保持一致--这条约定由 `applyUiConfig.test.ts` 逐字断言,
只改 `uiConfig.ts` 或只改 CSS 都会先失败在测试上,不会静默闪一帧旧样式.
行号槽宽不写死:`EditorLineNumbers` 按当前字体与最大行号位数动态写入
`--code-gutter-width`.

源码高亮不引入编辑器组件:着色后的源码渲染在 textarea 背后的
`#dsl-editor-highlight` 层里,textarea 只把文字设为透明(光标/选区/撤销/IME
仍由原生 textarea 负责).透明与显示由 `EditorHighlight` 在首次渲染成功后加上的
`is-highlighted` 类同时开关,脚本没跑时它就是一个普通输入框.高亮层的滚动偏移
写在内容元素的 `transform` 上(`EditorHighlight.sync`),不让高亮层自己滚动:
textarea 的滚动条要占位而高亮层不占,两者的最大滚动偏移差一个滚动条厚度,
抄 `scrollTop` 会在靠近底部/右端时被浏览器夹住,高亮最多滞后约 0.8 行.
分词与配色见 `src/ui/dslHighlight.ts` 与 `css/editor.css`;关键字表由
`dslHighlight.test.ts` 直接读 `src/compiler/compiler_rs/src/miko.pest` 校验,
语法文件新增枚举值不会漏.

## 求交

语法:

```text
intersection 名称 = intersection(对象A, 对象B) {
    color = "#ffffff";   // 可选,默认取调色板
    segments = 96;       // 可选,采样分辨率,最大 256
};
```

求交结果自动按组合区分:

- 曲线参与的求交(`intersection(c1, s1)`,`intersection(c1, c2)`,
  `intersection(c1, S)`)渲染为交点;
- 曲面/体积参与的求交(`intersection(s1, s2)`,`intersection(s1, S)`,
  `intersection(S, B)`)渲染为三维交线.

体积对象包括球体,方块和旋转体(圆柱/圆锥/圆台).旋转体的交线包含
侧面与上下底面,和它的数学体积定义一致.求交坐标会计入对象的静态
`transform`,但暂不支持带动画的对象,也不支持 `point` / `vector` /
`vector_field` 参与求交.

示例:

```text
intersection X = intersection(s1, s2) {
    color = "#ffffff";
    segments = 96;
};
```

点对象(例如默认源码开头的 `point P = [0, 0, 0]`)的全局样式由
右侧"视图"面板的"点"区域控制:可在"设定大小"与"按比例缩放"
两种模式间切换(二者是同一控制量的不同表达,切换时保持当前实际
大小不变),并可切换为不可见;设置作用于场景中的所有点对象.

XYZ 坐标轴使用 Three.js Line2 绘制,线宽以像素为单位,
可在右侧"视图"面板中调整(最小 1px).

"坐标轴向上"可在 X / Y / Z 三个轴间切换,决定哪个轴的正方向
在视口中朝上,默认 Z(数学/工程习惯);习惯 Y 向上(图形工具)的
用户可自行切换,ViewCube 的上/前/右预设视角会随该设置调整.

网格与坐标轴刻度同样使用 Line2 系列绘制:大刻度线粗而亮,
小刻度线细而暗;右侧"视图"面板可分别开关网格/刻度,
并调整大/小刻度线宽.刻度默认按整数步长排布,显示普通数值;
打开"π 单位"开关后,网格与刻度整体改按 π/2 间隔重排,大刻度落在
π 的整数倍上,刻度数字相应显示为 π/2,π,3π/2 ...(刻度位置与
数字始终一致,不是给整数刻度换标签).刻度数字与 XYZ 轴标签共用同一字体与
缩放设置,随刻度开关一起显隐;"坐标轴"面板的 X/Y/Z 标签开关
可单独隐藏某条轴的标签,并同时隐藏该轴的刻度数字.网格包含
XZ/XY/YZ 三个坐标平面,各有独立开关,同一行排列.

系数名不限于 `a`/`b`/`c`.只要不是 `sin`/`pi`/`e` 等内置符号,
`k`/`omega`/`theta` 这类标识符都会被识别为自由参数.

角度默认使用弧度,和 `rotate(pi / 4)` 保持一致.需要普通角度时可写
`rotate(deg(180))`;`deg()` 在 Rust 符号归一化阶段展开为 `x * pi / 180`.

## 明确不支持但会报错

- `jacobian`/`laplacian`:解析器接受,编译器会抛出"暂未实现"
- `scalar`/`vector` 张量声明:编译器会抛出"暂未实现"
- 积分源必须引用已存在的 `curve`/`surface`/`region` 或体积对象;
  体积域 `integral(S)` 不接受 `range` 选项(域 = 渲染出的世界实体)
- `region` 边界曲线带静态 `transform` 或 `animation`:编译期报错
- `region` 区域本体 V1 不支持变换/动画,不接受未知选项
- 对象相加(按名引用同类对象)的目标必须是**已声明的 `curve`/`surface`
  对象语句**:`derivative` 产出的曲线/曲面暂不能被引用(它是语句产物而不是
  对象声明),`intersection`/`integral`/`gradient` 等产物同理,引用会编译期
  报错并说明是哪种产物
- `box`/`cone`/`cylinder`/`frustum` 的 `gradient`/`derivative`:隐式函数是
  max 型分段函数,暂未支持(报"暂不支持 ... 体积对象");当前隐式场源只有
  `sphere` 与 `implicit`
- `implicit` 对象不接受 `transform`/`animation`(方程写在世界坐标里),
  本体也不参与求交/积分(V1 只有方程,没有自己的网格)
- 隐式场梯度分析里的静态 `transform`:与 curve/surface 的既有分析一致,
  分析在对象局部坐标里进行,不套用对象的静态变换

## 构建

项目根目录执行:

```sh
npm run build
```

该命令会依次执行:

一. `npm run clean`:清空旧的 `dist/` 与 `src/wasm/`

二. `npm run build:wasm`:分别重建 `src/math/math_rs`/
`src/compiler/compiler_rs`/`src/render/render_rs`
三个 Rust crate,并把产物输出到对应的 `src/wasm/*` 目录

> **源码 vs 产物的对应关系**:`src/*/{math_rs,compiler_rs,render_rs}` 是 Rust
> **源码**(唯一权威,含数值/编译/渲染内核);`src/wasm/*` 是它们 `wasm-pack`
> 构建后生成的 JS/TS 绑定与 `.wasm` **产物**,且整个目录在 `.gitignore` 中
> 被忽略(`*`),不提交进仓库.两者同名同树,但**不要手工修改或直接搜索/导入
> `src/wasm/*` 里的生成文件**;改内核只改 `src/*_rs`,再跑 `npm run build:wasm`
> 重新生成.前端代码统一从 `wasm/*` 的绑定入口导入.

`npm run typecheck`:执行 `tsc --noEmit`
`vite build`

三. 生产/CI 统一入口是根目录的 `bash ./build.sh`:依次执行
`npm ci`,Rust lint,清理旧产物与 WASM 构建,前端/Rust 测试,
前端类型检查与打包,每个阶段都有日志输出;GitHub Actions 只调用这一个
脚本,不再重复编排各步骤.

四. 重新生成wasm

```sh
npm run build:wasm
npm run typecheck
```

## 架构

先说结论:GraphCalc 目前是有架构的,只是它被拆成了四条并行的线--**编译/渲染/异步计算/UI 控制**,最后由一个比较胖的编排器 [DslApp.ts](src/app/DslApp.ts) 缝在一起.你觉得"看不懂",通常是因为同步编译和异步计算/渲染这两条时间线混在一个文件里.

rust部分使用 WASM bindings generator 绑定生成器 (wasm_bindgen)

## 一/核心模型

源码是唯一真相源.数据从 `textarea` 开始,经过一次编译变成纯数据 `SceneIR`,渲染层只消费这份数据,不反向修改 DSL.

```text
源码 textarea
   │ run()
   ▼
parseMiko()  -> Rust pest 解析 -> AstProgram
   │
   ▼
DslCompiler.compileScene()
   ├─ getOrBuildStaticScene()   // 缓存:params / matrix / transform / animation / blueprint
   ├─ materializeObject()       // 用当前参数生成 SceneObject
   ├─ compileAnalyses()         // gradient / divergence / curl
   ├─ compileIntegralTask()     // integral 任务
   └─ compileIntersections()    // intersection 任务(数值交给 Worker)
   │
   ▼
SceneIR(纯数据,不含 three.js/DOM)
   │
   ├─ Plotter -> 各种 Renderer -> THREE 场景
   ├─ AnalysisRenderer -> 分析可视化
   ├─ DslIntegralRenderer -> 积分计算与可视化
   ├─ IntersectionRenderer -> 求交 Worker 调度与交线渲染
   └─ ParamPanel / ObjectList / Diagnostics
```

关键边界文件:

- [compiler/ast/types.ts](src/compiler/ast/types.ts):解析结果 `AstProgram`
- [ir/types.ts](src/ir/types.ts):编译结果 `SceneIR`
- [DslCompiler.ts](src/compiler/dsl/DslCompiler.ts):AST 到 SceneIR 的编排入口
- [SceneStore.ts](src/app/SceneStore.ts):当前会话的 AST/显隐/动画起点等状态
- [CompileController.ts](src/app/CompileController.ts):解析与重新编译的调度
- [RenderController.ts](src/app/RenderController.ts):场景/相机/异步采样编排
- [DslApp.ts](src/app/DslApp.ts):装配层 + rAF 主循环 + 参数刷新入口
- [Plotter.ts](src/render/core/Plotter.ts):对象 id 到渲染器的路由门面
- [ComputeFacade.ts](src/math/compute/ComputeFacade.ts):数值计算门面
  (曲线采样/积分);`math/compute/index.ts` 是 compute 层统一入口

### 目录分层(202609 重构后)

按 `prompt/refactor-and-rust-migration.md` 执行完的四批重构(1c IR 切文件与
3c 统一 client 按建议砍掉):

```text
src/ir/             零依赖叶子:SceneIR 等纯数据契约(index.ts 统一入口)
src/config/         零依赖叶子:数值/渲染/UI 默认值(含 SphericalAngleConvention)
src/compiler/       AST -> IR;矩阵后端 matrixOps.ts
src/math/
  adapters/         系数/求交的纯数据转换
  matrix/           行主序 Mat4 与矩阵运算接口(原 tensor/,无张量)
  compute/
    scheduling/     与领域无关的调度原语(ComputeWorkerClient/LatestRequestExecutor)
    wasm/           WASM 粘合(wasmWorkerRuntime)
    domain/         curve / surface / vectorField / integral / intersection 编组
    ComputeFacade   曲线采样 + 积分门面;dispose() 收口 5 个领域 dispose*
  math_rs/          Rust 数值内核(表达式求值/采样/积分/求交)
src/render/         只消费 IR;渲染层不再自行解析表达式
src/ui/ src/app/    控制与编排
```

数值求值链路(`math_rs::eval_core::CompiledEvaluator`)在构造期把符号解析成
槽位(`symbolic::eval::SymBinding`),求值期零字符串/零哈希/零分配;旧
`HashMap<String, f64>` 查表版保留为测试参照物并用逐点对拍守住语义.

## 二/一次"运行"的完整过程

`index.html` 加载 `src/main.ts`,后者只做:

```ts
new DslApp().start()
```

`DslApp.start()` 会先搭建场景/相机/渲染器/控制器,然后进入每帧渲染循环,最后调用一次 `run()`.

`run()` 做的事情是:

1. DslApp 清空诊断,取消待刷新的参数帧,然后交给 CompileController.
2. CompileController 增加运行序号并异步调用 `parseMiko(editor.value)`
   (Rust pest 解析成 AST);返回后若序号过期或已销毁则直接丢弃.
3. 提交 AST 与 WASM 矩阵后端到 SceneStore.
4. 调用 `compileScene(ast, {}, matrixOps)` 生成 SceneIR.
5. 用 SceneIR 更新参数面板,并交给 RenderController 触发绘制/异步采样.

一次完整运行只解析一次源码.之后拖参数滑块不会重新解析源码,而是复用同一个 `currentAst`.

## 三/参数变化为什么快

滑块变化路径在 [DslApp.ts](src/app/DslApp.ts) 里的 `_scheduleRefresh` / `_refreshObjects`:

```text
滑块 input
   -> requestAnimationFrame 合并多个变化
   -> compileScene(currentAst, paramPanelController.getValues())
   -> renderController.applyScene(scene, changedParams)
   -> 只重绘依赖了这些参数的对象
```

这里有个很重要的机制:对象会携带 `coefficients`,说明它引用了哪些参数.`_objectDependsOnParams` 据此判断哪些对象需要真正重采样;不相关的对象只更新引用,不重新生成几何体.

积分和曲面等重计算也遵循这个规则:只有依赖了变化参数的对象,其关联积分才重新算.

## 四/异步计算链路

这是最容易看漏的部分.编译器产出的是表达式字符串和系数,真正的数值采样在 Web Worker + Rust/WASM 里完成.

| 内容 | 渲染/调用入口 | Worker | Rust/WASM | 返回 |
| --- | --- | --- | --- | --- |
| 曲线采样 | `CurveRenderer` | `CurveWorker` | `math_rs.sample_curve` | 顶点数组 |
| 曲面采样 | `SurfaceRenderer` -> `SurfaceMesh` | `SurfaceWorker` | `render_rs.sample_and_process_surface` | 位置/颜色/法线/索引 |
| 向量场采样 | `VectorFieldRenderer` | `VectorFieldWorker` | `math_rs.sample_vector_field` | 向量数组 |
| 数值积分 | `DslIntegralRenderer` -> `ComputeFacade` | `IntegralWorker` | `math_rs.integrate1d/2d`,带域 `integrate_region`(2D 区域)/`integrate_solid`(3D 实体) | 积分值/样本 |
| 求交 | `IntersectionRenderer` | `IntersectionWorker` | `math_rs.intersect_pair` | 交点/交线折线 |

这些链路都使用 `LatestRequestExecutor`:同一时间最多一个请求真正在跑,高频拖动滑块时,旧请求会被标记为 `superseded`,只保留最新请求.这是防止 Worker 积压的关键.

求交编译只产出 `IntersectionTask`(引用对象,颜色,segments),数值内核在
`math_rs::intersection_core`;IntersectionRenderer 用任务输入指纹做增量缓存,
参数无关的刷新不重算,只有隐藏求交本身才移除,结果回来后只重建对应任务的
geometry.求交结果按独立求值对象处理:隐藏某个参与面并不会隐藏交线.

## 五/UI 通信:两种方式各有明确边界

- **业务数据(参数/对象列表/诊断/积分结果)**:DslApp 与 RenderController
  直接注入回调,不走 EventBus;调用链在编译/应用代码里就能看清.
- **视图控件(相机/坐标轴/网格/点样式)**:控件 emit `EventBus` 事件,
  RenderController 统一订阅并落到 SceneManager/CameraManager/Plotter.

`service/events.ts` 只保留有真实 emit 点的视图事件键,不再允许
"先声明后接线"的 dead event keys.

另外,曲线/曲面/向量场的 Worker 采样失败现在统一经
`render/core/samplingErrors.ts` 上报,RenderController 转成诊断区错误;
没有"曲线悄悄走主线程兜底,曲面直接消失"的不一致路径.

## meta

**GraphCalc** 于 2026.09.13.20:15:00 正式立项
