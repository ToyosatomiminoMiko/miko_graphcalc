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

- 内置示例菜单:`source code` 窗口标题栏的"示例"按钮打开分组清单
  (求导 / 偏导 与 其他主题),选中即整段替换编辑器源码并立即运行.
  示例文本在构建期由 `import.meta.glob(..., { query: '?raw' })` 从
  `example/*.miko` 内联进 bundle(运行时不 fetch,离线可用),`example/`
  仍是唯一真相源;清单与文件集的一一对应由
  `src/ui/examples/exampleCatalog.test.ts` 守住.载入走"全选 +
  `execCommand('insertText')`"覆盖而不是直接赋值,浏览器原生撤销栈得以
  保留,一次 Ctrl+Z 就能退回载入前手写的代码(Chromium 152 / Firefox 155
  实测;撤销环节的取舍见 `src/ui/examples/replaceEditorSource.ts`)
- `param`:参数面板与实时刷新;`param φ = 0 in cyclic [-3.14159, 3.14159, 0.01]`
  显式声明**循环类系数**(球坐标方位角这类圆周量),越界值按区间长度回绕到
  `[min, max)` 而不是夹到端点;不写 `cyclic` 的参数一律按普通参数处理.
  每条滑块行末端的 `reset` 把该参数退回 `in` 前的声明值(`param a = 1 in [...]`
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
  `region` / `integral` / `derivative`;示例 `example/object_addition.miko`
- `region`:面积图形(两条曲线围成的 x 型带状区域,绘制在 z=0 平面),可
  作为二重积分的积分域;边界曲线只允许不带静态变换/动画的纯函数曲线
- `matrix` / `transform`:对象场景变换
- `animation`:单矩阵动画片段,可通过对象 `animation = [...]` 绑定并顺序播放
- `derivative`:求导语句,把符号求导结果做成一个新对象并画出整条导数
  函数曲线/曲面(curve -> curve 求 x 导,surface -> surface 求 x/y 偏导);
  语法 `derivative 名称 = derivative(源对象 [, 变量])`,函数名用全名不缩写;
  示例 `example/derivative_graph.miko`
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
  math),结果列表同时回显 `[r, θ, φ]`.示例 `example/sphere_gradient.miko`
- `gradient` / `divergence` / `curl` / `laplacian`:点分析(求导/偏导经这些
  微分分析算子暴露:一元求导 = curve 的 gradient,偏导 = surface 的
  gradient,div/curl = 向量场的一阶偏导组合,laplacian = 标量场的
  `∇²f = f_xx + f_yy + f_zz`;用户文档见 `docs/derivatives-guide.md`)
- `gradient` 的 `show` 元素:通用 `point`/`normal`;曲面(偏导)与三维
  隐式场/球体可加 `tangent_plane` 画切平面,一元曲线与二维隐式曲线可加
  `tangent` 画切线;曲线求导与二维隐式曲线不写 `show` 时默认画
  `[point, normal, tangent]`,让切线始终可见,其余分析默认
  `[point, normal]`.示例集见 `example/README.md`:
  一元求导 `example/derivative_curve.miko` 与求导法则对照
  `example/derivative_rules.miko`,偏导 `example/partial_derivative_surface.miko`,
  散度/旋度 `example/divergence_vector_field.miko` 与 `example/curl_vector_field.miko`,
  拉普拉斯 `example/laplacian_scalar_field.miko` 与调和场对照
  `example/laplacian_harmonic.miko`
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

## 桌面窗口化

界面形态是"**3D 视口铺满 + 五个浮动窗口 + 顶部任务栏**":`#viewport`(Three.js
画布)仍然铺满 `#app`,五个窗口悬在它上面,桌面空白处照常可以转视角.任务栏是
紧贴 `#app` 上沿的一条通栏带,窗口几何被夹在它下面,所以它不会被任何窗口遮住.

```text
任务栏(顶部通栏):窗口按钮 ... 全部还原

source code(源码)  参数(参数滑块 + 诊断)  视图(视图控件)
过程(递等式)        对象(实体 / 求值两栏)
```

- 窗口外壳(`.window` / 标题栏 / 正文 / 八根缩放手柄)与任务栏**由库声明式装配**
  (库 `miko_ui` 的 `mountDesktop` / `WindowFrame` / `Dock`):`index.html`
  里只有一个空 `#app`,窗口层 / 吸附预览 / 任务栏 / 每个窗口的正文容器都由库建;
  加窗口只改 `UI_CONFIG.window.windows` 一处.
- 能力:拖动标题栏移动,八向缩放,最小化(再点任务栏按钮恢复),最大化(填满任务栏
  之下的工作区),边缘吸附(左/右半屏,拖到顶部任务栏附近最大化)与窗口间磁吸.
  **没有关闭与全屏**:没有真正的进程可关,关闭与最小化在观感上就是同一件事;
  全屏与最大化的差别也只剩"遮不遮任务栏",而任务栏不该被遮.
- 状态与写入点:`WindowManager` 持有 `geometry` / `state` / `restore` /
  `focused` / `zIndex`;**几何的唯一写入点**是 `_applyGeometry`(逐条
  `setProperty`,不碰 `z-index`),**状态的唯一写入点**是 `_applyState`
  (所有 `.window` 类名,`inert`/`aria-hidden`,任务栏按钮的激活态与淡化),
  `z-index` 只有 `focus()` 写.
- 隐藏态(最小化)用 `opacity: 0` + `inert` + `aria-hidden`,**不用**
  `display: none`:编辑器行号与高亮层在隐藏期间必须仍能量到尺寸,否则恢复后
  对齐会整体错乱.
- `#window-layer` 整层 `pointer-events: none`(只有 `.window` 自己 `auto`),
  这是"空桌面处仍能转 3D"的前提;任务栏那条带自己收指针--它占的是工作区
  之上的预留带,工作区里没有任何东西需要让路.
- 窗口外壳的两个尺寸(任务栏高度 `dockReserve`,标题栏高度 `headerHeight`)在
  挂载时由库从 `DesktopConfig` 写到 `#app` 的 CSS 变量上,是运行期唯一来源;
  `miko_ui` 的 `styles/tokens.css` 里的同名值只是没有 JS 时的兜底.
- **布局不落 localStorage**:刷新后回到默认几何,与"界面偏好不落本地存储"的
  既有约定一致;设计取舍与逐条理由见
  [面板窗口化设计计划](docs/windowing-plan.md).

## 界面样式配置

代码区字体,KaTeX 字号与窗口外壳常量**不做运行时设置界面**,也不落 localStorage:
唯一真相源是 `src/config/uiConfig.ts`,启动时由 `src/app/applyUiConfig.ts`
写成 `:root` 上的 CSS 变量,再由应用层的四份样式表(`css/base.css` /
`panels.css` / `editor.css` / `process.css`)与 `miko_ui` 的 `styles/` 下的库
样式表(控件 `widgets.css`,桌面窗口系统 `desktop.css`,编辑器外壳
`editor.css`,反馈条目 `feedback.css`)的 `var()` 消费.

**样式表按两层加载,顺序即层叠顺序**(入口在 `src/main.ts`):

1. **库层**:`import 'miko_ui/styles.css'` 一行拿到库的全部默认样式,内部顺序
   (token -> 控件 -> 桌面 -> 编辑器外壳)由库自己的 `styles.css` 决定,应用不
   插手;库以后加样式表,应用入口不用改;
2. **应用层**:`css/base.css` -> `panels.css` -> `editor.css` ->
   `process.css`,只写应用自己的类 / id / 页面级规则.

整层压而不是逐份交错:交错时"谁赢"由"文件排在第几位"决定,而不是"这块样式归谁
负责".踩过的坑是应用层的 `.row-visibility-btn` 被排在它后面的库 `widgets.css`
盖掉,在应用里改 `background` 完全无效而且不报错.所以应用层不许出现"只由库的类
构成"的选择器,也不许整组照抄库的按钮基线 `:where(.ui-button)` -- 要改外观就改库
(或给节点加一个应用自有的变体类,只写增量).这条界限由
`src/config/styleLayers.test.ts` 断言,配色纪律由
`src/config/cssPalette.test.ts` 断言.

- `UI_CONFIG.editor`:`fontFamily`/`fontSize`/`lineHeight`/`tabSize`,
  作用于左面板源码编辑区(textarea,行号栏与源码高亮层共用同一组值);
  `gutterMinWidth` 是行号槽宽下限;
- `UI_CONFIG.formula.katexFontSize`:底部对象列表里 KaTeX 公式的字号,
  单位 em,基准是 `.object-expr` 的 16px;
- `UI_CONFIG.panel`:只剩参数区与视图控件的**内容下限**
  (`paramsMinHeight` / `viewControlsMinHeight`),由 CSS 消费;
- `UI_CONFIG.window`:桌面窗口化的全部几何与常量--五个窗口的标题/宿主/
  默认几何锚点/最小尺寸,标题栏按钮清单(只有最小化与最大化),
  `edgeKeep`/`edgeGap`/`headerMinVisible`/`dockReserve`/`headerHeight`,
  三层容器的 `z-index` 与吸附阈值.**窗口几何不进 CSS**(窗口是 JS 建的,
  不存在"CSS 首帧"),默认几何由 `WindowGeometry.resolveDefaultGeometry()`
  按当前桌面尺寸算出 px,由 `WindowManager` 写成行内样式;两个外壳尺寸
  (`--window-header-height` 与 `--dock-reserve`)在挂载时由库从这份配置
  写到 `#app`,库样式表里的同名值只是没有 JS 时的兜底.

改完刷新页面即可.库样式表(`miko_ui` 的 `styles/tokens.css`)的 `:root`
兜底只负责脚本执行前的首帧,必须与 `UI_CONFIG` 保持一致--这条约定由
`applyUiConfig.test.ts` 逐字断言,
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
分词与配色见 `src/editor/dslHighlight.ts` 与 `css/editor.css`;关键字表由
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

- `jacobian`:解析器接受,编译器会抛出"暂未实现"
- 向量场的逐分量拉普拉斯 `∇²F`(`laplacian` 作用于 `vector_field`):
  编译器会抛出"逐分量拉普拉斯 ∇²F 暂不实现";标量场的 `laplacian`
  已支持(见 `docs/derivatives-guide.md` §5)
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

一. `npm run lint:rs` / `npm run clean`:Rust `fmt` + `clippy`,然后清空旧的
`dist/` 与 `src/generated/`

二. `npm run build:wasm`:分别重建 `src/math/math_rs`/
`src/compiler/compiler_rs`/`src/render/render_rs`
三个 Rust crate,并把产物输出到对应的 `src/generated/*` 目录

> **源码 vs 产物的对应关系**:`src/*/{math_rs,compiler_rs,render_rs}` 是 Rust
> **源码**(唯一权威,含数值/编译/渲染内核);`src/generated/*` 是它们
> `wasm-pack` 构建后生成的 JS/TS 绑定与 `.wasm` **产物**,且整个目录在
> `.gitignore` 中被忽略(`*`),不提交进仓库.两者同名同树,但**不要手工修改或
> 直接搜索/导入 `src/generated/*` 里的生成文件**(唯一例外是手写粘合层
> `src/wasm/`,见下节);改内核只改 `src/*_rs`,再跑 `npm run build:wasm`
> 重新生成.
>
> 手写代码统一从 `src/wasm/` 的粘合入口导入:`wasm/init.ts`(主线程
> 初始化),`wasm/workerRuntime.ts`(Worker 侧消息壳),`wasm/matrixOps.ts`
> (矩阵后端);生成产物只被这三个文件与各 `*Worker` 直接引用.

三. `npm run test`(vitest),最后 `npm run build:app`:先 `npm run typecheck`
(`tsc --noEmit`),再 `vite build`

四. 生产/CI 统一入口是根目录的 `bash ./build.sh`:依次执行 `npm ci`,把
`miko_ui` 对齐到 npm 的 `latest`(见下面的版本同步),再跑上面整条 `build:all`
(Rust lint,清理旧产物与 WASM 构建,前端/Rust 测试,前端类型检查与打包),
每个阶段都有日志输出;GitHub Actions 只调用这一个脚本,不再重复编排各步骤.

> **`miko_ui`(网页 UI 库)是 npm 依赖,不在这里.** 它是独立仓库
> [ToyosatomiminoMiko/miko_ui](https://github.com/ToyosatomiminoMiko/miko_ui),
> 发布在 npm registry 上.根 `package.json` 里一条 `"miko_ui": "^0.1.2"`,
> `npm ci` / `npm install` 直接从 registry 装好,和 `three` / `katex` 没有区别:
> **本仓库里没有取库的脚本,没有 `preinstall`,也没有 `.cache/` 缓存**.库的检查
> (边界守卫 / typecheck / vitest)与发布都在库自己的仓库里跑,本仓库不构建库;
> 源码里的 `import ... from 'miko_ui'` 解析到的是 npm 包里的 `dist/` 构建产物
> (纯 ESM,自带类型声明).库的运行时依赖只有 `@preact/signals-core`(必装)与
> `katex`(可选 peer),本应用在 `package.json` 里显式声明了这两个,并由
> `vite.config.ts` 的 `resolve.dedupe` 保证全程只有一份实例.
>
> **每次构建对齐最新版:** `build.sh` 在 `npm ci` 之后,流水线之前跑一步版本
> 同步 -- 拿 npm 的 `latest` 与已装版本比,不一致就 `npm install miko_ui@latest`
> 并更新 `package.json` / `package-lock.json`.所以 **GitHub Pages 每次部署用的
> 都是库的最新发布版**(`deploy.yml` 走的就是 `build.sh`);本地跑完
> `bash ./build.sh` 记得把这两个文件提交.策略由 `MIKO_UI_SYNC` 控制:
>
> - `auto`(默认):落后就更新;
> - `check`:落后就失败,不改文件(只校验);
> - `off`:完全按 lock 构建,跳过同步.
>
> 查不到 `latest`(断网 / npm 不可用)时本机警告并沿用 lock,CI(`CI=true`,或显式
> `MIKO_UI_REQUIRE_LATEST=1`)明确失败 -- 部署出去的不能是"说不清哪一版"的产物.
> 注意 `npm run build`(=`build:all`)不经过 `build.sh`,它按 lock 构建,不会自动
> 更新;要手动升到最新就是 `npm install miko_ui@latest` 后提交 lock.

只重新生成 WASM(不动其余步骤):

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
   ├─ compileAnalyses()         // gradient / divergence / curl / laplacian
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

- [contract/ast.ts](src/contract/ast.ts):解析结果 `AstProgram`
- [contract/ir.ts](src/contract/ir.ts):编译结果 `SceneIR`
- [DslCompiler.ts](src/compiler/dsl/DslCompiler.ts):AST 到 SceneIR 的编排入口
- [SceneStore.ts](src/app/SceneStore.ts):当前会话的 AST/显隐/动画起点等状态
- [CompileController.ts](src/app/CompileController.ts):解析与重新编译的调度
- [RenderController.ts](src/app/RenderController.ts):场景/相机/异步采样编排
- [DslApp.ts](src/app/DslApp.ts):装配层 + rAF 主循环 + 参数刷新入口
- [Plotter.ts](src/render/core/Plotter.ts):对象 id 到渲染器的路由门面
- [ComputeFacade.ts](src/compute/ComputeFacade.ts):数值计算门面
  (曲线采样/积分);`compute/index.ts` 是 compute 层统一入口

### 目录分层(202609 重构后)

依赖严格单向:`main -> app -> ui -> render -> compute/compiler -> math/wasm -> contract/config/core`,
同层之间只允许向后引用,全仓库无环(测试文件引用 `testing/` 不计入生产依赖).

```text
src/contract/       零依赖叶子:跨层数据契约(ast.ts 解析产物 / ir.ts 编译产物 /
                    view.ts 视图值域 / events.ts 视图事件映射)
src/config/         零依赖叶子:数值/渲染/UI 默认值(含 SphericalAngleConvention)
src/core/           零依赖通用原语:EventBus,LatestRequestExecutor(+RequestClient)
src/math/           纯数学(同步,无 DOM,无 Worker)
  CoordinateSystem / latexNumber / paramValue
  adapters/         系数/求交的纯数据转换
  matrix/           行主序 Mat4 与矩阵运算接口(原 tensor/,无张量)
  math_rs/          Rust 数值内核(表达式求值/采样/积分/求交)
src/wasm/           手写 WASM 粘合层:init(主线程)/ workerRuntime(Worker 壳)/ matrixOps(矩阵后端)
src/generated/      wasm-pack 产物(被 .gitignore 忽略,勿手改)
src/compute/        AST/IR 表达式 -> Worker + Rust/WASM 的数值结果
  scheduling/       与领域无关的 Worker 调度(ComputeWorkerClient)
  domain/           curve / surface / vectorField / integral / intersection 编组
  index.ts          compute 层公共面(只导出跨层需要的东西,内部调度不外泄)
  ComputeFacade     曲线采样 + 积分门面;dispose() 收口 5 个领域 dispose*
src/compiler/       AST -> IR(dsl/ 编译管线,parser/ WASM 解析,errors/text 纯工具)
src/render/         只消费 IR;渲染层不再自行解析表达式
  core/             场景/相机/动画/渲染器与轴刻度
  visualization/    网格与积分可视化
src/ui/              应用侧界面:只声明"有什么"(DOM 结构)与"干什么"(行为)
  entity/           实体列表(对象窗口左栏):行结构 + 列表装配
  evaluation/       求值列表(对象窗口右栏):分析/积分/求交/求解/原函数/微分方程
  objects/          两个对象列表的装配与事件接线
  params/           参数面板:滑块取值口径与写回时机
  process/          过程窗口:递等式步骤列表与三级披露判据
  view/             视图窗口:相机/坐标轴/网格/曲面的控件装配(viewState + ViewPanel)
  examples/         示例目录与载入(示例清单数据 + 编辑器写入)
src/app/            控制与编排
src/testing/        测试基建(domStub / setupWasm / matrixOps),不被生产代码引用
```

`src/ui/` 里**没有样式**:控件词表(token / 开关 / 滑块 / 数字框 / 按钮 /
浮层 / 行原语)在库 `miko_ui` 的 `widgets/` 与 `shared/`,主题与默认外观在
库的 `styles/`,桌面窗口系统在库的 `desktop/`,编辑器外壳在库的 `editor/`,
反馈条目与公式排版在库的 `feedback/` / `formula/`.应用侧只保留
应用自有的类名(对象行/求值行/过程步骤/面板容器)与其布局,见
[界面样式配置](#界面样式配置).

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

`contract/events.ts` 只保留有真实 emit 点的视图事件键,不再允许
"先声明后接线"的 dead event keys.

视图窗口(相机/预置视角/点/坐标轴/曲面)的装配固定成三层:

```text
RENDER_CONFIG ──► src/ui/view/viewState.ts   唯一状态源(signal / 派生信号 / 计算值)
                        │  value: Signal<...>
                        ▼
                  src/ui/view/ViewPanel.ts   结构 + 控件实例 + 双向绑定
                        │  effect
                        ▼
                  RenderController           订阅状态,推到 CameraManager / Plotter / SceneManager
```

库的 `widgets/` 是这套东西的词汇表(`createSwitch` / `createSegmented` /
`createSlider` / `createNumberField` / `createButton` / `createPopover` /
行与分组):只负责 DOM 结构与可访问性,不认识 EventBus,也不读配置.应用侧
`ParamPanelController` 复用同一批件,只保留取值口径与写回时机这类业务语义;
示例菜单复用 `createPopover`(开合态/`aria-expanded`/点外部关闭/焦点归还),
自己只留"渲染什么"与"选中后干什么";对象行/求值行也改用库的建元素原语
`create_element`,两栏共用的行外壳与显隐按钮在库的 `shared/rowDom.ts`.
行外壳(`.object-row` / `.row-main` / `.row-actions`)与显隐按钮只要库给了
默认样式,应用侧就不再写第二份 -- 这条由 `src/config/styleLayers.test.ts` 守.

`miko_ui` 的控件类名(`.segmented` / `.control-group` / `.slider-field` 等)
与样式都在库里;应用侧的 `css/panels.css` 只留应用自有的行/栏/面板类
(`.object-sublist` / `.kind-*` / `.object-expr` / `.eval-*` ...)与其布局.

控件的可调范围与选项(`min`/`step`/ViewCube 名单)收在 `UI_CONFIG.view`:
它是**只有 TS 消费**的界面参数(与 `UI_CONFIG.window` 的窗口几何同类),不进
`applyUiConfig` 的 CSS 变量表,`css/base.css` 里因此没有第二份副本;渲染默认值
仍只在 `RENDER_CONFIG`.控制器判"越界"时读的是同一份 `UI_CONFIG.view`.

装配出来的控件不再需要外部 `dispose`:每个控件恰好交给一个持有者(视图面板交
`createViewPanel` 的句柄,参数行交面板控制器,浮层交示例菜单控制器),由持有者
统一解绑.新增一个视图控件只改 `src/ui/view/ViewPanel.ts` 与
`src/ui/view/viewState.ts`;`#view-controls` 这个宿主由 `src/app/appViews.ts`
建,`index.html` 里除 `#app` 外没有任何宿主 id.

另外,曲线/曲面/向量场的 Worker 采样失败现在统一经
`render/core/samplingErrors.ts` 上报,RenderController 转成诊断区错误;
没有"曲线悄悄走主线程兜底,曲面直接消失"的不一致路径.

## meta

**GraphCalc** 于 `2026.09.13.20:15:00` 正式立项
