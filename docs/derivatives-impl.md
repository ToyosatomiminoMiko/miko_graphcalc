# 求导与偏导:实现梳理与检查记录

本文记录对 GraphCalc 求导/偏导功能的实现检查(2026-09),供维护者参考.
用户视角的 DSL 用法见 [derivatives-guide.md](derivatives-guide.md).

## 1. 现状结论

- **`derivative` 语句把符号求导结果做成新对象**,画出整条导数函数曲线/曲面
  (curve -> curve 求 x 导,surface -> surface 求 x/y 偏导).对象与手写
  curve/surface 完全同构,复用同一 blueprint/物化/渲染管线;语法见
  [derivatives-guide.md](derivatives-guide.md) §1.
- **隐式场求导**:`sphere`(内置隐式场 `|p−c|²−r²`)与 `implicit`
  (`f(x,y)=0` / `f(x,y,z)=0`)没有解出因变量,`derivative` 对它们求的是
  梯度 ∇f,产物是 `vector_field`(复用向量场管线,公式层用
  `VectorFieldObject.gradientOrigin` 保留 ∇ 算子).实现见
  `dsl/implicitField.ts` 与 `staticScene.ts` 的 `buildFieldDerivativeBlueprint`.
- **"微分分析"算子**在指定点做点分析(与"梯度"功能耦合):
  - 一元导数 = `curve` 上的 `gradient`(等价的数学说法:对隐式曲线
    `y − f(x) = 0` 求梯度 ∇ = (−f′, 1, 0),切线方向即 (1, f′, 0));
  - 偏导 = `surface` 上的 `gradient`(fx = ∂f/∂x,fy = ∂f/∂y,法向
    (−fx, −fy, 1),切平面);
  - 隐式场 = `sphere` / `implicit` 上的 `gradient`:∇f 在空间处处有定义,
    但切平面只对等值面上的点有意义,故先沿 ∇f 牛顿投影到 `f = level`,
    再取该处法向;二维隐式曲线额外给出平面内切线(见
    `implicitField.ts::projectToLevelSet`);
  - `at` 的坐标形式由语法显式给出:`at [x, y, z]` 是笛卡尔,
    `at spherical(θ, φ)` / `at spherical(r, θ, φ)` 是球坐标(Rust 解析器
    在 AST 上写 `atForm: 'spherical'`).换算收在坐标系类
    `math/CoordinateSystem.ts`(`CoordinateSystem.cartesian/spherical`,
    `toCartesian`/`fromCartesian`/`convertTo`;二维球坐标自动退化为极坐标),
    θ/φ 约定由 `numericConfig.analysis.sphericalAngleConvention` 全局配置
    (physics 默认 / math);隐式场/球体的 gradient 结果额外携带
    `pointSpherical` 供结果列表回显;
  - div/curl = `vector_field` 上的六个一阶偏导组合;
  - laplacian = 标量场上的三个**二阶**偏导之和
    `∇²f = f_xx + f_yy + f_zz`,与 gradient 共用同一份"维度决定哪几项
    参与"的口径(curve 为 2 维,surface 的 z 项恒 0);对一阶偏导再求一次
    偏导即可,不新增微分规则.隐式场/球体的二阶偏导收在场闭包
    `ImplicitField.laplacian`(implicit 走符号二阶导,球体用解析闭式 6).
- **求导本身在编译期完成(符号求导),数值求值在 WASM 内完成**,对象与
  分析结果都是"纯数据",拖动参数只重新求值,不重新求导(表达式级缓存).
- **`derivative` 语句输出"导数函数对象",分析算子输出"点值"**:前者是
  整条 f′ 曲线(f′ 表达式作为新对象表达式),后者是在某一点求 f′(px),
  fx/fy(px,py),div/curl(px,py,pz),∇²f(px,py).
- **jacobian 未实现**:pest 语法与 AST 类型已接受,编译期
  (`analyses.ts`)抛"分析算子 ... 暂未实现".`laplacian` 已实现(标量场);
  **向量场的逐分量拉普拉斯 `∇²F = (∇²P, ∇²Q, ∇²R)` 暂不实现**,对
  `vector_field` 写 `laplacian` 会被 `analyses.ts` 显式拒绝(错误文案
  带"逐分量拉普拉斯 ∇²F 暂不实现"),而不是落进标量场分支被静默处理.

## 2. 主要代码路径

```text
DSL:  gradient g = grad(c) at [px, 0];
        │ parse_miko()(compiler_rs/miko.pest: analysis_stmt / analysis_op)
        ▼
AST AnalysisStatement { op, call, source, at[], options[] }
        │ compileAnalyses()   compiler/dsl/analyses.ts
        ▼
· 校验:算子×kind 矩阵 / at 数量与可求值性 / call 与算子匹配 / show 白名单
· 曲线/曲面(梯度):对 object.expr 生成 fx_expr / fy_expr
      cachedDerivativeExpression(expr, 'x' | 'y')   compiler/dsl/expression.ts
        │ wasm symbolic_derivative(expr, variable)   math_rs/src/lib.rs
        │   └─ symbolic/derivative.rs + builtins.rs(法则/函数表)
· 曲线/曲面(拉普拉斯):对一阶导再求一次导得到 f_xx / f_yy / f_zz
      secondDerivatives(expr, dim)  dsl/analyses.ts(复用同一份符号引擎缓存)
· 隐式场/球体(梯度):implicitFieldFor(object) -> f 与 ∇f 的点求值闭包
      implicitField.ts::projectToLevelSet 沿 ∇f 牛顿投影到 f = level
        │ 数值求值 evaluateExpressionAt -> wasm evaluate_scalar
        │ (球体的 f/∇f 是解析式,不再走符号引擎)
· 隐式场/球体(拉普拉斯):同一投影点上的 ImplicitField.laplacian
      implicitField.ts(implicit 走符号二阶导;球体给解析闭式 6)
        ▼
JSON payload -> evaluate_gradient_point / evaluate_divergence_point /
              evaluate_curl_point / evaluate_laplacian_point(lib.rs)
              -> field_core.rs 数值求值
        ▼
IR AnalysisResult { point, vector, tangent, scalar, show, enabled }
        │
        ├─ AnalysisRenderer.ts     渲染 point/normal/tangent/tangent_plane
        └─ ObjectListController.ts "结果"列表:∇f / ∇·F / ∇×F / ∇²f 与 f(P)
```

- 曲线 gradient 的 payload:`fy_expr = '0'`(第二 at 坐标不参与);
- 曲面 gradient 的向量 = normalize(−fx, −fy, 1);曲线 = normalize(−f′, 1, 0);
- laplacian 的 payload 是三项二阶偏导 `fxx_expr`/`fyy_expr`/`fzz_expr`,
  数值核只做 `f_xx + f_yy + f_zz`(标量返回,与散度同款签名);`at` 口径
  与 gradient 相同,但测量点仍落在源图形上(靠 `evaluate_scalar` 取一次
  f 值),`vector` 恒 `[0,0,0]`,`show` 缺省 `[point]`;
- curve 求导的切线方向 `tangent = (1, f′, 0)` 未归一化,Δx 半长由
  `renderConfig.analysis.tangentHalfLength`(默认 2)控制;
- 符号引擎:`math_rs/src/symbolic/derivative.rs` 按节点分派(常数/变量/
  一元负/二元运算/函数调用),乘积,商,幂 `f^g`,链式法则展开后交给
  `simplify`;`builtins.rs` 的 `derivative_unary` 表登记每个内置函数的
  导数;别名 `log/pow/sec/csc/cot/deg` 在 `rewrite_aliases` 阶段展开.
  - `printing.rs` 的文本打印器必须给幂的**底数**补括号:`(x^2)^3` 少写
    括号会重读成 `x^(2^3)`(x^6 变 x^8);`7/x^4` 的导数曾因此从
    `-28/x^5` 静默变成 `-28/x^13`.LaTeX 打印器只做展示,不弥补 Text 的语义;
  - `simplify.rs` 会把商/幂法则留下的分数收成人能读的一行:数字系数并进
    分子,同底数幂相乘/相除合并,负号提到运算符上,例如
    `d/dx (x^3 + 7/x^4 - 2/x) = 3x^2 - 28/x^5 + 2/x^2`(仍然不做同类项
    合并/通分/因式分解,边界见 `simplify.rs` 顶部契约).

## 3. 与 gradient 的耦合(设计取舍)

"求导/偏导"目前只是 gradient/divergence/curl 分析在对象上的语义:

- 同一算子 `gradient` 同时承担"一元导数(curve)"与"二元偏导
  (surface)"两种语义,靠对象 kind 区分(analyses.ts 里
  `defaultShow`/`fy_expr`/`tangent` 都按 isCurve 分叉);
- IR `AnalysisResult` 只有一套结构,`tangent` 字段对曲面/向量场为
  null,`tangent_plane` 仅曲面 gradient 使用,`normal` 在 curve 上是
  "切线的法向"而非曲面法向;
- UI"结果"列表对 gradient 一律打印 `f(P)` 与 `∇f`(法向),不区分一元/
  多元;散度只打标量,旋度只打向量.

取舍是合理的:求导在编译期完成一次,渲染/UI 共用点分析管线,示例与
文档都按"微分分析"这一组功能叙述.若未来要加独立的一阶导数语句或
f′ 曲线可视化,应在 DSL/IR 层增加显式语义(参考 §5 的未实现清单),
而不是继续塞进 gradient 的 show.

## 4. 未提交的工作区改动(2026-09 快照)

`git status` 显示以下改动**尚未提交**,它们正是"一元求导可视化"最近
的一批工作,示例与文档已按包含这些改动的代码状态编写:

| 文件 | 改动 |
| --- | --- |
| `src/compiler/dsl/analyses.ts` | gradient 结果新增 `tangent`;curve 求导缺省 show 改为 `[point, normal, tangent]` |
| `src/contract/ir.ts` | `AnalysisShow` 新增 `tangent`;`AnalysisResult.tangent` 字段 |
| `src/compiler/dsl/options.ts` | show 白名单加 `tangent`,解析带缺省项 |
| `src/render/core/renderers/AnalysisRenderer.ts` | 渲染切线(绿色直线) |
| `src/config/renderConfig.ts` | `analysis.tangentHalfLength` |
| `src/compiler/dsl/DslCompiler.test.ts` | curve 切线默认/显式 show 的行为测试 |
| `README.md` | 说明文字(见仓库根 README 的引用更新) |

同时本仓库对 `example/` 与 `docs/` 的忽略已放开
(见根 `.gitignore`),示例集与本文档可随代码一起提交.

## 5. 已知边界与未实现

- `jacobian`:AST 类型 `AnalysisOpKind` 与 pest `analysis_op` 已收,但
  analyses.ts 编译期直接抛"暂未实现";加算子时需同步
  `compiler_rs/src/miko.pest` 与 `ast/types.ts`.
- **向量场的逐分量拉普拉斯 `∇²F = (∇²P, ∇²Q, ∇²R)`**:未实现,且**不会**
  被当成标量场处理--`analyses.ts` 对 `laplacian(vector_field)` 直接报
  "逐分量拉普拉斯 ∇²F 暂不实现".要落地它需要"一个源对象 -> 三分量结果"
  的新 IR 形状(现在 `AnalysisResult` 的 `scalar`/`vector` 是二选一),
  以及三分量各自的二阶偏导 payload,属于独立一组改动.
  (`laplacian` 的标量场部分已实现,见 §1 与 §2.)
- 高阶/混合偏导没有独立语句,但可用 `derivative` 链式求导得到:每步把
  上一步的导数对象当源对象即可(如 `derivative(d = derivative(s, x))` 得
  ∂²f/∂x²,`derivative(dy = derivative(d, y))` 得 ∂²f/∂y∂x).
  `laplacian` 内部正是走这条链式路径(`secondDerivatives`),只是不暴露
  混合偏导 `f_xy`.
- 对数组/向量表达式求导:未支持(`derivative` 源只能是
  curve/surface/implicit/sphere;对 vector_field 求导会报"只能应用于
  curve/surface/implicit/sphere 类型对象").
- 点分析只输出测量点的值;`at` 坐标个数不足时编译报错(curve 最少
  1 个,surface / implicit / sphere 2 个,vector_field 3 个;语法上 `at`
  至少两个数).三维隐式场/球体缺省的第三个坐标按 0 补全.
  `at spherical(θ, φ)` 的两参数形式 `r` 取源球体半径,源不是 `sphere`
  时编译报错;`at spherical` 最多三个参数,球坐标相对世界原点.
- 隐式场 V1:`box`/`conic` 的隐式函数是 max 型分段函数,gradient/derivative
  暂不支持;`implicit` 本体(以及球体)不参与求交/积分;`implicit` 本体
  的 marching squares/cubes 采网渲染留到后续,当前只作为分析源.
- 隐式场梯度分析在对象局部坐标里进行,不套用静态 `transform`(与
  curve/surface 的既有分析一致,是既有边界而非本次新增).
- 隐藏语义:被隐藏的分析先完整校验再置 `enabled: false` 占位,不执行
  WASM 求值(与求交/积分统一,见 analyses.ts 文件头).
- 数值侧对不可导点(abs/sign 在 0 处等)返回 NaN;符号侧 abs 用 sign
  语义,不会产生 0/0.

## 6. 测试现状

- TS:`src/compiler/dsl/DslCompiler.test.ts` 覆盖 curve/surface
  gradient 的 payload,归一化法向,tangent 默认与显式 show,div/curl
  数值编排,laplacian 三类源(curve/surface 走 WASM 数值核,
  implicit 走场闭包)与 `vector_field` 的逐分量报错,kind×算子非法组合
  与 call 不匹配等;
- 展示层:`src/compiler/dsl/evaluationLatex.test.ts` 锁定 laplacian
  摘要/细节两行公式,`src/ui/objects/ObjectListController.test.ts`
  锁定"拉普拉斯"彩色标签;
- Rust:`src/math/math_rs/src/symbolic/mod.rs` 单元测试覆盖符号求导
  法则与化简(`sin(x*a)`,`abs` 的 sign 语义,常数折叠等);
  `field_core.rs` / `lib.rs` 的 glue 测试覆盖 `evaluate_laplacian_point`
  的已知真值(抛物面 4,调和场 0)与 payload 契约.
