# 不定积分与微分方程:设计计划

一句话结论:**两个功能都不发明新链路**--原函数照抄"声明级符号内核"那一条
(`solve` 的产物类型口径 + 过程页),微分方程照抄同一条再加"解可回代验证".
差别只在数学能力本身:本计划把原函数从"有限表"放宽到**相对完整的初等积分
能力**(有理函数部分分式 + 换元 + 分部 + 三角),因此路线图
[教学化改造路线图](teaching-roadmap.md) §7.1 的"不补全 CAS"禁令在本文件里
按**显式豁免**处理,豁免范围与理由见第 6 节.

配套阅读:[方程求解过程的展示设计](equation-solving-process.md)(过程页骨架,
本计划直接复用,零改动),[求导与偏导:实现梳理](derivatives-impl.md)(符号
求导链,本计划所有产物都靠它回代验证).

---

## 1 已确认的三条口径

| # | 决定 | 落地含义 |
| --- | --- | --- |
| D1 | **相对完整的 CAS 已不可避免**,不再把能力限制在"一张短表" | 原函数走系统化初等积分:线性性 -> 查表 -> 换元 -> 分部 -> **有理函数部分分式**;明确不可积者(`e^{x^2}`,`\sin(x^2)`,`\sin x/x`,`e^x/x`)报"非初等"并引导走数值 `integral`,**绝不给错误原函数** |
| D2 | 原函数**作为可渲染对象下发** | `F` 同时是一个 `curve`/`surface` 实体,进入既有渲染/分析/积分/求交管线;积分常数 `C` 由选项给具体值(缺省 0),符号通解仍在展示层保留 `+C` |
| D3 | 初值**直接跟在方程后** | `ode O = y' = x*y, y(0) = 1;` 方程内首个顶层 `,` 之后全为初值,多条依次写;`expr` 停止集是 `;`/`{`/`}`,逗号天然落在文本里 |

---

## 2 复用清单

| 既有件 | 位置 | 本次用法 |
| --- | --- | --- |
| 独立产物类型 | `math_rs/src/symbolic/solve.rs`(`SolveOutcome`/`SolveStep`,不含 `Expr`) | 照抄成 `AntiderivativeOutcome`/`OdeOutcome` |
| WASM 入口 + JSON | `lib.rs::solve_equation`(`coeff_names/coeff_values`) | 新增 `antiderivative`/`solve_ode`,同形同系数链路 |
| 声明级编译 | `compiler/dsl/solves.ts` | 新增 `antiderivatives.ts`/`odes.ts` |
| 步骤分区 | `ir::SOLVE_STEP_KINDS` -> `ui/process/processSteps.ts` | 追加 `table`/`substitute`/`check`(旧值不变) |
| 过程页 | `ui/process/processData.ts` -> `ProcessDocument` | 新增两个 builder,过程页零改动 |
| 求值列表 | `EvaluationList`/`SolveItem`/`index.html` 的 `object-sublist` | 新增两个 item 类 + 两个容器 |
| 隐藏语义 | `SceneStore` 集合 + `DslApp._toggleSolve` + `CompileController` | 各加一份(约定 1:先校验,后禁用,仅跳过内核) |
| 符号求导 | `symbolic_derivative` + `cachedDerivativeExpression` | **验证**:原函数与 ODE 解一律回代求导对拍 |
| 多项式工具 | `symbolic/poly.rs` | 扩展出 `divmod`/`gcd`,给部分分式用 |
| 二次求根 | `symbolic/solve.rs` | 二阶常系数特征方程直接复用 |
| 数值求值 | `evaluate_scalar` + `evaluateExpressionAt` | 抽样对拍,不新增求值入口 |
| 渲染管线 | `dsl/objects/*` + `Plotter` + `RenderController` | 原函数/特解以普通对象下发,渲染层零改动 |

---

## 3 不定积分

### 3.1 DSL

```miko
// 原函数 + 可渲染曲线(C 取具体值,缺省 0)
antiderivative F = antiderivative(c) { constant = 0; range = [-4, 4]; segments = 256; }
// 曲面:对 x 或 y 积分
antiderivative G = antiderivative(s, y) { constant = 1; }
```

- 源限 `curve`/`surface`(与 `derivative` 同表);变量缺省 `x`;
- 选项:`constant`(积分常数取值,缺省 0),`range`,`segments`(可渲染对象用);
- 参数系数按当前滑块值代入,过程里回显一行参数取值(与求解"系数显示"同规格);
- 产物两路同名同源:IR `AntiderivativeTask`(求值列表 + 过程页)与
  `SceneObject`(实体列表 + 三维视口).

### 3.2 内核 `symbolic/integral.rs`

判定链(每步都产出 `AntiderivativeStep{latex,reason,kind}`):

1. **常量与线性性**:常数因子提出,和差拆项;每项独立处理;
2. **查表**:`x^n(n≠-1)`,`1/x`,`e^x`,`a^x`,`sin`/`cos`,`sec^2`,
   `1/(1+x^2)`,`1/sqrt(1-x^2)`,`sinh`/`cosh`,`tan`,`1/(x^2+a^2)`,
   `ln x`,`arcsin`/`arctan`;表项带 LaTeX 与规则名,与 `builtins.rs` 同写法;
3. **线性内核换元**:`f(ax+b) -> F(ax+b)/a`;
4. **分部积分**:LIATE 选 `u`,覆盖 `x e^x`,`x sin x`,`ln x`,`x ln x`,
   `x^2 e^x`,`arctan x`;**步数上限 3**,超限报错(防不收敛);
5. **有理函数**:`poly.rs` 扩展 `divmod`/`gcd` -> 多项式除法 + 部分分式
   (互异线性因子 / 重因子 `(x-a)^k` / 不可约二次因子 `x^2+px+q`),
   分别落到 `ln`,`1/x^{k-1}`,`arctan` + `ln` 三个基本形;
6. **三角与代数换元**:`sin^m cos^n`(奇次拆分/倍角降幂),`1/(a^2-x^2)`,
   根式 `sqrt(a^2-x^2)`/`sqrt(x^2+a^2)` 的标准换元;
7. **常数与符号**:结果在**表达式树**里不含 `C`(`C` 只出现在展示层 LaTeX 与
   可渲染对象的 `constant`),这样归一化串可直接喂 `evaluate_scalar`.

产物:

```rust
pub struct AntiderivativeOutcome {
    pub integrand_latex: String,
    pub antiderivative_text: String,   // 归一化串,可求值
    pub antiderivative_latex: String,  // 含 `+C`
    pub constant_symbol: String,       // "C"
    pub variable: String,
    pub steps: Vec<AntiderivativeStep>,
    pub verified: bool,
    pub error: Option<String>,         // 能力边界,不是调用失败
}
```

**验证**:对 `antiderivative_text` 再符号求导,与 `integrand` 化简比较;不一致
直接走 `error` 通道(不给错误答案).这一条同时是 Rust 单测与 TS 对拍的断言.

### 3.3 展示与可渲染对象

- 求值列表新增「原函数」子列表:摘要 `\int f\,dx = F + C`;细节给被积函数,
  变量,常数取值与验证结论;过程页走 `buildAntiderivativeProcess`;
- 可渲染对象:`F` 以 `curve`(或 `surface`)下发,`objectFormulas` 给
  `y = F(x) + c`;进入 `derivative`/`gradient`/`integral` 全部既有能力;
- 顺带能力(不新增语句):`F(b)-F(a)` 由既有 `evaluate_scalar` 两次求值即可
  做牛顿-莱布尼茨定积分,示例里直接演示与 `integral` 数值法对拍.

---

## 4 微分方程

### 4.1 DSL

```miko
ode O1 = y' = x*y;                              // 可分离
ode O2 = y' + p*y = q, y(0) = 1;                // 一阶线性 + 初值(直接跟方程后)
ode O3 = y'' - 3*y' + 2*y = 0, y(0)=0, y'(0)=1; // 二阶常系数 + 两个初值
ode O4 = y' + p*y = q*y^2;                      // Bernoulli
```

- 整段方程由 `expr` 捕获;首个顶层 `,` 之前是方程(按首个顶层 `=` 分左右),
  之后每条初值再按 `=` 分左右;
- 自变量缺省从方程出现的坐标变量推断(`x`/`t`),推断不出且未给 `independent`
  选项则报错;因变量缺省取带导数记号的符号(`y'` -> `y`),`dependent` 可覆盖.

### 4.2 内核 `symbolic/ode.rs`

- **导数记号归一**:字符扫描把 `y''` -> `ypp`,`y'` -> `yp`(只吃标识符边界,
  不做朴素串替换),再走 `parse_expr`;
- 可解类型清单(逐类给完整步骤;超出清单明确报错,不做"看起来像推导"的输出):

| 类型 | 判定 | 步法 |
| --- | --- | --- |
| 一阶可分离 | `y' = f(x)g(y)` | 分离变量 -> 两侧积分(复用 `integral.rs`) |
| 一阶线性 | `y' + p(x)y = q(x)` | 积分因子 `e^{\int p dx}` |
| Bernoulli | `y' + py = qy^n` | `u = y^{1-n}` 化线性 |
| 一阶齐次 | `y' = F(y/x)` | `u = y/x` |
| 一阶恰当 | `M dx + N dy`,检验 `M_y = N_x` | 势函数 |
| 二阶常系数齐次 | `ay''+by'+cy=0` | 特征方程(`solve.rs` 复用)-> 实/重/复根三型 |
| 二阶常系数非齐次 | 右端 `P_m e^{kx}` / 三角 / 多项式 | 待定系数 |
| 可降阶二阶 | `y'' = f(x)` 缺 `y`/`y'` | 两次积分 / `p=y'` 降阶 |

- 产物 `OdeOutcome`:`order`,`independent`/`dependent`,`general_latex`,
  `particular_latex`(有初值时),`arbitrary_constants`,`steps`,`verified`,
  `error`;
- **验证**:解(及由初值定出的特解)回代 `y`/`y'`/`y''` 数值对拍原方程;
  失败走 `error` 通道.

### 4.3 展示

- 求值列表新增「微分方程」子列表,过程页复用题目区显示 ODE 本体;
- 解族可视化不写渲染器:示例用 `param C`(滑块)写 `curve y = 解(C 取滑块)`,
  拖动即看解族演化--`param` 实时联动是现成能力;
- 验证步在过程页显式列出,并与 Rust 断言同源.

---

## 5 新增契约(一次列全)

| 层 | 新增项 |
| --- | --- |
| `compiler_rs/src/miko.pest` | `antiderivative_stmt`,`ode_stmt` + `statement` 分支 |
| `contract/ast.ts` | `AntiderivativeStatement`,`OdeStatement` |
| `math_rs/src/symbolic/mod.rs` | `mod integral; mod ode;` + 产物类型 |
| `math_rs/src/symbolic/poly.rs` | `divmod`/`gcd`/因式分解辅助 |
| `math_rs/src/lib.rs` | `antiderivative`,`solve_ode` 两个 WASM 入口(+ 重建产物) |
| `compiler/dsl/antiderivatives.ts` / `odes.ts` | 声明级编译 |
| `contract/ir.ts` | `SceneIR.antiderivatives`,`SceneIR.odes`;`SOLVE_STEP_KINDS` 追加 `table`/`substitute`/`check` |
| `compiler/dsl/evaluationLatex.ts` | 两个摘要 + 两个细节函数 |
| `ui/evaluation/AntiderivativeItem.ts` / `OdeItem.ts` 等 | 子列表挂载与过程入口 |
| `app/SceneStore.ts`,`CompileController.ts`,`DslApp.ts`,`index.html`,`css/panels.css` | hidden 集合,回调,容器,徽章样式 |
| `ui/process/processData.ts` | `buildAntiderivativeProcess`,`buildOdeProcess` |
| `config/uiConfig.ts` | 新环节上限(原函数步数/ODE 步数)与披露阈值 |
| `example/` | `antiderivative_basic.miko`,`antiderivative_rational.miko`,`ode_separable.miko`,`ode_second_order.miko`(+`exampleCatalog` 登记) |
| `docs/` | 本文件 + `docs/integration-ode-guide.md`(用户指南)+ 索引 |

---

## 6 路线图豁免与边界

`teaching-roadmap.md` §7.1 写着"不补全 CAS(符号积分,极限,级数)".本功能是
**受控豁免**,口径如下(执行时把这段回写到路线图 §7.1 的注记):

- 豁免的是**原函数的初等积分能力**,不是"通用 CAS":仍不做极限,级数,特殊
  函数,符号系数代数,任意阶微分方程;
- 每个产物必须**可回代验证**,验证不过就走能力边界错误通道;
- 明确列出**非初等**清单(`e^{x^2}`,`\sin(x^2)`,`\sin x/x`,`e^x/x`,`\ln x/x`
  之外的对数积分等),给"请用 `integral` 数值法"的指引;
- 内核预算(分部步数上限,换元深度,树深)与既有 `MAX_TREE_DEPTH` 口径一致,
  超限报可读错误,绝不 panic/超栈.

---

## 7 分期与验收

### 一期 骨架对齐(零内核风险)

`contract/ir.ts` 追加字段与 step kind;`SceneStore`/`CompileController`/`DslApp`/
`index.html`/CSS 挂两个子列表;`processData.ts` 两个 builder;新示例文件名先
登记.**验收**:空语句占位不报错;隐藏/过程入口与求解条目完全同构;
`npm test` + `npm run typecheck` 全绿.

### 二期 不定积分(含可渲染对象)-- 已落地

**实现锚点(2026.09)**:
- 内核 `math_rs/src/symbolic/integral.rs`:线性性 -> 基本公式表(含线性内核)->
  有理函数(多项式除法 + 有理根因式分解 + 部分分式小规模消元)-> 根式/反三角
  基本形 -> 分部积分(LIATE + 多项式优先,层数上限)-> 三角幂(按公式表组装);
  每次结果都**回代符号求导 + 抽样对拍**,不过就拒绝;
- WASM `lib.rs::antiderivative`:名字与值分开传,**只给名字时参数保持符号**
  (静态场景按 AST 缓存,参数一旦在编译期折成数值,拖滑块曲线就不跟手);
  `declared_parameters` 同时收"另一个坐标"(对 y 积分时的 x);
- 语法:`miko.pest` 的 `antiderivative_stmt` + `parser_wasm/calculus.rs` 的
  AST 节点(与 `derivative` 共用 `unary_call_to_stmt`);
- 编译分两层:静态场景层建 blueprint(实体侧 + 展示事实),`antiderivativeTasks.ts`
  把事实转成 IR 条目并处理隐藏与占位;
- 展示:`evaluationLatex.ts` 的摘要/细节,`processData.ts` 的
  `buildAntiderivativeProcess`,"原函数"子列表 + `kind-antiderivative` 徽章;
- 示例:`example/antiderivative_basic.miko`,`example/antiderivative_rational.miko`.

**实现中踩到并写进注释的坑**(后来者不必重踩):
1. `linear_parts` 会产出 `2 * 1` 这种未折叠的系数,斜率判定必须先求值再比,
   否则 `sin(2x)` 的线性内核整条失效;
2. 分部积分的 LIATE 必须"多项式优先"且方向为优先级**小**的一侧当 `u`,
   否则 `x*e^x` 会互相挑成对方,直到预算耗尽;
3. 部分分式的解向量按"条目连续占槽"布局(二次因子占两槽),步长写错会越界;
4. 三角幂最初用降幂递推,首项符号/递推增益/基项符号三个量反复写错,
   最终改成"公式表 + 统一装配"(表里放**已积分**的项);
5. 原函数对象必须在静态场景层建 blueprint,否则 `derivative(F)` 找不到它;
   但 blueprint 里的表达式**不能**折参数,要靠 `declared_parameters` 保符号.

**验收**:
- Rust:`d/dx F` 与 `f` 逐例数值对拍一致,覆盖 `x^3+7/x^4-2/x`,`sin(a*x)`,
  `1/(1+x^2)`,`x*exp(x)`,`ln(x)`,`x^2*exp(x)`,`1/(x^2-1)`(部分分式),
  `(2*x+1)/(x^2+x+1)`,`sin(x)^3`,`sqrt(1-x^2)`;非初等例给 `error` 不给解;
- TS:IR 形状,参数系数回显,隐藏不调内核,超出能力时题目 LaTeX 仍有效;
- UI:摘要/细节/过程页排版(`evaluationLatex.test.ts`,`processData.test.ts`);
- 手工:`F` 在三维视口可见,`derivative(F)` 与 `f` 曲线重合.

### 三期 微分方程

顺序:记号扫描 -> 可分离/线性(复用 `integral.rs`)-> 特征方程(复用
`solve.rs`)-> Bernoulli/齐次/恰当 -> 非齐次待定系数 -> 初值 -> wasm/AST/编译
-> UI -> 验证测试 -> 示例.

**验收**:每类至少 2 例,解代回原方程数值一致;有/无初值两种产物都正确;
超范围明确报错;`ode` 与 `solve` 并存时系数链路一致.

### 四期 收尾

用户指南,路线图注记,`example/README.md` 对照表,体积实测入档.

---

## 8 测试清单

- **Rust**:`integral.rs`/`ode.rs` 每例"结果代回"断言;预算超限不 panic;
  非初等识别;空变量/错元数错误文案;
- **TS**:`DslCompiler.test.ts`(IR 形状/系数/隐藏/重名/未知选项/span),
  `evaluationLatex.test.ts`,`processData.test.ts`,`exampleScenes.test.ts`;
- **集成**:新 `.miko` 全部可解析编译;`exampleCatalog.test.ts` 守住文件集;
- **门禁**:`npm test`,`npm run typecheck`,`npm run lint:rs`,
  `cargo test --workspace`;动 Rust 后重跑 `npm run build:wasm` 并验证页面.

---

## 9 风险

1. **部分分式与换元的复杂度**:先做互异线性因子,再做重因子与不可约二次;
   每加一类先补单测再接 UI;
2. **不收敛/深树**:分部步数上限 + 树深预算,超限报错;
3. **不可验证的正确性**:所有产物必须回代验证,失败即能力边界错误;
4. **两份过程数据源漂移**:步骤文案只在 `evaluationLatex.ts` 与
   `processData.ts` 各一处(P4:文案与数据分离);
5. **首屏体积**:主 chunk 增量目标 < 30KB,WASM 增量实测入档;
6. **既有字段语义**:只增字段与新枚举值,`integral` 语义一字不改.
