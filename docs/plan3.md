# 三期完整规划与设置

本文是**一期,二期已落地之后**的完整规划:三期(微分方程)的详细设计,四期
收尾,以及三个待定设计点的备选方案.**本文是执行清单,不是调研笔记**;
每节都给出可直接落地的文件,接口与验收口径.

配套阅读:
- [不定积分与微分方程:设计计划](calculus-suite-plan.md)(总口径与一期/二期)
- [不定积分使用指南](antiderivative-guide.md)(已落地功能的用户文档)
- [方程求解过程的展示设计](equation-solving-process.md)(过程页骨架)
- [教学化改造路线图](teaching-roadmap.md) §7.1(受控豁免口径)

状态基线(2026.09):
`npm test` 71 文件 / 613 通过;`cargo test --workspace` 170 通过;
`npm run lint:rs` 与 `npm run typecheck` 通过;生产构建通过.

---

## 0 待决设计点(先讨论,再动手)

这三条会改变三期的数据模型,建议在开工前定下来.

### P1 解曲线族怎么画

| 方案 | 做法 | 优点 | 代价 |
| --- | --- | --- | --- |
| **A 复用曲面**(推荐) | 把 `y' = f(x,y)` 的右端当成一个 `surface` 下发,**`z = f(x, y)` 就是斜率场**;解族再按 `C` 取几个值各下发一条 `curve` | 零新增渲染器;`surface` 的颜色按 z 高低已能看出斜率分布;`curve` 与解公式天然同一来源 | 斜率场是"高度图"不是"箭头场",需要配色与说明引导;粗曲面看不出方向 |
| B 新增方向场渲染器 | 在 `VectorFieldRenderer` 旁加一个"斜率短线"渲染器,数据从编译期采样拿 | 视觉最贴近教科书 | 新增渲染器 + 采样管线 + 测试;与"复用优先"原则相悖,除非 A 实测不可读 |
| C 只给公式不给图 | 三期只做符号解与过程页 | 最省 | 教学价值砍半(本项目差异化就在"看得见") |

**建议 A 先做**;若实机看下来斜率场不可读,再评估 B(`packages` 层面只多一个
renderer 与一份采样 payload,不影响 IR 契约).

### P2 积分常数 `C` 怎么处理

| 方案 | 做法 | 优点 | 代价 |
| --- | --- | --- | --- |
| **A 族参数扫描 + 常数拟合**(推荐) | 选项 `curves = 3` + `range`:先 `C = 0` 从左邻域起数值积分(复用一期积分器)得到一条基准解,再把每个采样点的目标 `y` 代入解的代数方程,**逐个点解出该点对应的 `C`** | 一次积分拿到任意条曲线;`C` 不是全局常数也照样正确(对一阶通解天然成立);不引入新内核 | 隐式解需要整理成 `F(x,y)=C` 形式才能反解;个别点反解失败要跳过并如实说明 |
| B 只画一条特解 | 选项 `constant`(与 `antiderivative` 同形),缺省 0 | 实现最简 | 看不出"族",教学表达弱 |
| C 逐条独立积分 | 每个 `C` 各积一次 | 直白 | 每条都要一次数值积分,条数一多就慢 |

**建议 A**,并把 B 的 `constant` 保留为"只想要一条"的快捷选项(取 `curves = 1`
即等价).反解失败的点必须跳过并在细节里写出来,不能静默画错曲线.

### P3 隐式解怎么办

`solve_ode` 对可分离方程常给出隐式解(`ln|y| = x + C`).三个选项:

| 方案 | 做法 |
| --- | --- |
| **A 公式给隐式,曲线按 P2-A 反解**(推荐) | 过程页与细节照实排隐式解;实体侧把隐式解整理成显式或按 `F(x,y)=C` 数值反解 |
| B 强制显式化 | 能解出 `y` 才下发给实体,否则只给公式 |
| C 用 `implicit` 对象下发 | 把 `F(x,y) - C = 0` 交给隐式场渲染 | 

C 看着最优雅,但当前 `implicit` 的 marching 渲染按 README 仍标注"留到后续",
不能指望它;A 最稳.隐式解**必须**在过程页明确标注"隐式解"字样,不要让读者
以为右边那一坨就是 `y = ...`.

---

## 1 三期:微分方程(详细设计)

### 1.1 DSL

```miko
// 一阶可分离(自变量/因变量自动推断)
ode O1 = y' = x*y;

// 一阶线性 + 初值(初值直接跟在方程后,与 D3 口径一致)
ode O2 = y' + p*y = q, y(0) = 1;

// 二阶常系数 + 两个初值
ode O3 = y'' - 3*y' + 2*y = 0, y(0) = 0, y'(0) = 1;

// Bernoulli
ode O4 = y' + p*y = q*y^2;

// 显式指定变量(推断不出来时;未给则编译期报错并提示)
ode O5 = y' = z*y { independent = x; dependent = y; };

// 画解族(见 P1/P2)
ode O6 = y' = x*y { curves = 3; range = [-2, 2, -2, 2]; };
```

语法落点(`miko.pest`,与 `solve_stmt` 同形):

```pest
ode_stmt = { "ode" ~ ident ~ "=" ~ expr ~ stmt_end }
```

- 整段方程由 `expr` 捕获(停止集 `;`/`{`/`}`,逗号天然落在文本里);
- **首个顶层 `,`** 之前是方程(按**首个顶层 `=`** 分左右),之后每条初值再按
  `=` 分左右;初值形如 `y(0) = 1` / `y'(0) = 1`;
- 自变量缺省从方程里出现的坐标变量(`x`/`t`)推断;推断不出且未给
  `independent` 选项 -> **编译期错误**(带语句 span),不猜;
- 因变量缺省取带导数记号的符号(`y'` -> `y`),`dependent` 可覆盖.

选项白名单(唯一来源:`odes.ts` 的 `ODE_OPTION_NAMES`):

| 选项 | 含义 | 缺省 |
| --- | --- | --- |
| `dependent` | 因变量名 | 从 `y'` 记号推断 |
| `independent` | 自变量名 | 从方程坐标变量推断 |
| `constant` | 解族取值(见 P2-B) | `0` |
| `curves` | 画几条解曲线(见 P2-A) | `0`(不画) |
| `range` | 解曲线/斜率场的域(2 或 4 个数) | `NUMERIC_CONFIG.curve.defaultRange` |
| `segments` | 解曲线采样分段 | 继承默认 |
| `color` | 颜色 | 调色板 |

### 1.2 内核:`math_rs/src/symbolic/ode.rs`

产物照抄 `solve.rs`/`integral.rs` 的**独立类型**口径(不含 `Expr`):

```rust
pub struct OdeStep { pub latex: String, pub reason: String, pub kind: String }

pub struct OdeOutcome {
    pub equation_latex: String,
    pub independent: String,
    pub dependent: String,
    pub order: usize,
    pub general_latex: Option<String>,     // 通解
    pub particular_latex: Option<String>,  // 特解(写了初值时)
    pub general_text: String,              // 归一化可求值表达式(显式解时)
    pub implicit: bool,                    // 通解是不是隐式(见 P3)
    pub arbitrary_constants: usize,
    pub verified: bool,
    pub steps: Vec<OdeStep>,
    pub error: Option<String>,             // 能力边界,不是调用失败
}

pub fn solve_ode(
    equation: &str,
    dependent: Option<&str>,
    independent: Option<&str>,
    coefficients: &[(String, f64)],
) -> Result<OdeOutcome, String>;
```

**导数记号归一(第一个要写对的东西)**:`y''` -> `ypp`,`y'` -> `yp`,`x'` -> `xp`
必须用**字符扫描**做标识符边界感知的替换,不能用 `str::replace`:

- 朴素替换会把 `y''` 先替成 `yp'` 再替成 `ypp`,看似没事,但会把 `ay'`(参数 `a`
  乘 `y'`)整片读错,也会吃掉 `y_1'` 这类下标名;
- 扫描规则:遇到 ASCII 字母/下划线开头的标识符,读到非标识符字符为止,再看紧跟
  的连续 `'` 个数(1 个 -> `p`,2 个 -> `pp`);`'` 超过 2 个直接报错;
- 归一后的名字(`yp`/`ypp`/`xp`)在 `solve_ode` 内部是普通符号,交给既有
  `parse_expr`/`rewrite_aliases`/`validate_supported` 处理;LaTeX 层在
  `latex_symbol` 里把 `yp` -> `y'`,`ypp` -> `y''`(只加映射,不动打印器).

**判定与步法清单**(逐类给出步骤;不在清单内明确报错):

| 类型 | 判定 | 步法 | 复用 |
| --- | --- | --- | --- |
| 一阶可分离 | 右端能写成 `f(x)·g(y)`,或 `M(x)+N(y)·y' = 0` | 分离变量 -> 两侧分别对 `x`/`y` 积分 -> 隐式解 -> 能解则显式化 | `integral.rs`(按变量调) |
| 一阶线性 | `y' + p(x)y = q(x)` | 积分因子 `μ = e^{∫p dx}` -> `(μy)' = μq` -> 积分 | `integral.rs` |
| Bernoulli | `y' + p y = q y^n`,n 为数值常数 | `u = y^{1-n}` 化线性 | 线性分支 |
| 一阶齐次 | `y' = F(y/x)` | `u = y/x` -> `x u' + u = F(u)` -> 可分离 | 可分离分支 |
| 一阶恰当 | `M dx + N dy`,检验 `M_y = N_x` | 势函数 `Φ`,`Φ = C` | `integral.rs` |
| 二阶常系数齐次 | `a y'' + b y' + c y = 0`,a,b,c 数值 | 特征方程 `aλ²+bλ+c=0` -> 实/重/复根三型 | `poly.rs` + `solve.rs` |
| 二阶常系数非齐次 | 右端 `P_m(x)e^{kx}`,三角,多项式 | 待定系数(特解形式表) | `poly.rs` |
| 可降阶二阶 | `y'' = f(x)`(缺 y) / `y'' = f(y)`(缺 x) | 两次积分 / `p = y'` 降阶 | `integral.rs` |

**验证**(与一期同一条铁律):解对自变量求导后代回原方程,抽样对拍;隐式解则对
`Φ(x,y)=C` 两边求全导再代;不过就走 `error` 通道,`verified=false`.

**预算**:特征方程次数上限沿用 `poly.rs` 的 `MAX_SOLVE_DEGREE`(当前 8);
积分调用沿用一期预算;`ode.rs` 自身的递归/循环设显式护栏,超限报可读错误.

### 1.3 编译分两层(照抄二期已跑通的结构)

二期已经把"符号内核产物 + 实体对象下发 + 可被下游引用"这条路走通了,三期
**照抄,不再重新设计**:

1. **静态场景层**(`staticScene.ts` 新增 `buildOdeBlueprint` 与一个 ode pass,
   放在 antiderivative pass **之后**,derivative pass **之前**):
   - 调一次 `solve_ode` 拿到通解/特解/步骤(步骤存进 `StaticScene.odeFacts`);
   - 按 P1/P2 下发的对象:
     - 斜率场:`surface z = f(x, y)`(右端表达式),`odeOrigin` 标记;
     - 解曲线:`curve y = <特解或按 C 反解>`,`odeOrigin` 标记;
   - 把产物登记进 `resolvable`(于是 `derivative(O)`,`integral(O)` 都能引用);
   - **参数在表达式里保持符号**(与二期同一条教训):`solve_ode` 只收声明参数
     名,不收值;数值由物化层按当前滑块折叠.
2. **求值层**(`compiler/dsl/odeTasks.ts`):把 `odeFacts` 转成 `OdeTask`,
   处理隐藏(不下发对象,不调内核)与能力边界(只留占位 + 理由).

`StaticScene` 与 `SceneIR` 各新增一份:
`odeFacts: Map<string, OdeFact>` / `odes: OdeTask[]`
(`SceneIR.odes` 二期已按空表占位,三期只需填上).

### 1.4 IR 与展示

`OdeTask` 的形状二期已经定在 `contract/ir.ts`(见该文件注释),三期按它填值即可;
展示侧需要新增的只有:

- `compiler/dsl/evaluationLatex.ts`:`odeLatexSummary`(题目 = 原方程),
  `odeLatexDetailEntries`(通解 / 特解 / 初值回显 / 验证 / 能力边界);
  新增两个 detail role:`'general'`(通解),`'particular'`(特解);
- `ui/evaluation/OdeItem.ts`:与 `AntiderivativeItem` 同骨架(徽章
  `kind-ode`,文案"微分方程");
- `ui/process/processData.ts`:`buildOdeProcess`(复用 `ProcessDocument`);
- `ui/evaluation/EvaluationList.ts` + `ObjectListController` + `index.html` +
  `DslApp` + `SceneStore` + `CompileController`:各加一份"微分方程"子列表
  (二期已经加过"原函数",这是**第 6 份同类改动**,照抄即可);
- `css/base.css` + `css/panels.css`:新增 `--kind-ode` 与 `.kind-ode`;
- `config/uiConfig.ts`:若 `process.maxSteps`(48)不够放下"分类 + 标准形 +
  积分因子 + 两侧积分 + 初值代入 + 验证",再单开一个 `ode.maxSteps`;
  **默认不动**,先实测步骤数.

### 1.5 示例(每个都要在文件头写清"学习目标/前置/操作/观察/思考")

| 文件 | 覆盖 |
| --- | --- |
| `example/ode_separable.miko` | 可分离:`y' = x*y`,斜率场 + 解族 + 初值特解 |
| `example/ode_linear_first_order.miko` | 一阶线性:积分因子,参数 `p`/`q` 联动 |
| `example/ode_second_order.miko` | 二阶常系数:三种根型(实/重/复),特征方程与通解 |
| `example/ode_with_initial.miko` | 初值:`y(0)=1` 把族收成一条,拖初值看曲线怎么动 |

---

## 2 四期:收尾与增强(按优先级排)

| 序 | 项 | 内容 | 依赖 |
| --- | --- | --- | --- |
| 4.1 | 文档收尾 | `docs/ode-guide.md`(用户指南),`docs/README.md` 索引,`example/README.md` 对照表,roadmap §7.1 注记回写 | 三期 |
| 4.2 | 体积优化 | 给 `math_rs` 试 `[profile.release] lto = true` / `opt-level = "z"`,实测 `math_rs_bg.wasm` 与主 chunk 增量并写回文档 | 三期 |
| 4.3 | 非齐次二阶 | `a y'' + b y' + c y = f(x)` 的待定系数法(先做 `P_m(x)e^{kx}` 与三角) | 三期内核 |
| 4.4 | 可降阶二阶 | `y'' = f(x)` / `y'' = f(y)` / 缺项型 | 三期内核 |
| 4.5 | 隐式解可视化 | 若 P3-C 的 `implicit` marching 渲染落地,可把隐式解直接画成等值线 | 渲染层 |
| 4.6 | 方向场渲染器 | 若 P1 的 A 方案实测不可读,再做斜率短线渲染器 | 视 P1 结论 |
| 4.7 | 参数曲线 | `curve` 支持 `(x(t), y(t))` 形式,才能画竖直解支/多值解 | 语言层扩展 |
| 4.8 | 方程组与相图 | 一阶线性方程组 + 相图(纯扩展,不在当前定位内) | 4.7 |

---

## 3 测试计划

### 3.1 Rust(`math_rs`)

- `ode.rs` 每个类型至少 2 例,**每例断言解回代验证通过**(与 `integral.rs` 同规模);
- 记号归一单测:`y'`/`y''`/`y_1'`/`ay'`/`y'''`(报错)各一例;
- 能力边界:超出清单的方程给 `error` 且 `general_latex` 为 `None`;
- 隐式解:验证走"隐函数求全导"路径,得 `verified=true`;
- 参数保持符号:传入名字不带值,结果表达式里仍有参数名;
- 预算:超限给可读错误,不 panic(编码规范第 5 条).

### 3.2 TypeScript

- `src/compiler/dsl/odes.test.ts`:照抄 `antiderivatives.test.ts` 的九条结构
  (条目/对象双身份,下游可引用,参数保符号,初值选项,能力边界,隐藏,
  斜率场域,引用不存在,自变量推断失败报错);
- `evaluationLatex.test.ts`:新增 ode 摘要/细节的排版断言;
- `processData.test.ts`:新增 `buildOdeProcess`;
- `ObjectListController.test.ts`:容器与回调各加一份(照二期 diff);
- `exampleScenes.test.ts` + `exampleCatalog.test.ts`:新示例自动纳入(必须登记
  catalog,否则测试红).

### 3.3 门禁(每期收尾都跑)

```sh
npm test && npm run typecheck && npm run lint:rs && cargo test --workspace
```

动 Rust 后必须重跑 `npm run build:wasm` 并验证页面(wasm 产物被 gitignore,
不重建等于没改).

---

## 4 验收口径(三期)

- [ ] 五类一阶方程 + 二阶常系数齐次,每类至少 2 例,过程页步骤完整;
- [ ] 通解与特解都在 IR 里,初值写错(如 `y(0)=1, y(0)=2`)报明确错误;
- [ ] 解回代验证通过率 100%(验证不过的必须走 `error`,不能放行);
- [ ] 斜率场与解族在三维视口可见;`derivative`/`integral` 能引用解曲线;
- [ ] 参数保持符号:拖动滑块解与曲线同步变化(不是冻在声明值);
- [ ] 隐藏项:不下发对象,不调内核,列表留占位;
- [ ] 文档三件套齐:`docs/ode-guide.md` + `example/README.md` + roadmap 注记;
- [ ] 全门禁绿;体积增量按 roadmap §7.2 格式入档.

---

## 5 风险与预案

| 风险 | 预案 |
| --- | --- |
| 记号归一写错(静默读错方程) | 字符扫描 + 专门单测;验证步是最后一道闸 |
| 隐式解反解不出显式 | P3-A/C 二选一;反解失败的点跳过并如实说明,绝不静默画错 |
| 解族按 C 反解在个别点失败 | 每点独立反解(见 P2-A),失败计数写进细节 |
| 斜率场视觉不可读 | P1 留了 B 方案;先按 A 做并实机看效果 |
| 步骤过长挤爆过程页 | `process.maxSteps` 已有截断明文;必要时单开 `ode.maxSteps` |
| WASM 体积继续涨 | 4.2 的 lto/opt-level 实测;必要时把 ODE 内核拆到独立 crate |
| 参数折成数值导致曲线不跟手 | 照二期:只传名字不传值 + 物化层折叠(已踩过的坑) |

---

## 6 执行顺序(建议)

```text
讨论并拍板 P1/P2/P3
      │
      ▼
三期内核 ode.rs(记号归一 -> 可分离 -> 线性 -> 初值 -> 验证 -> 单测)
      │
      ▼
lib.rs 入口 + 重建 wasm
      │
      ▼
miko.pest + parser_wasm.rs + ast/types.ts
      │
      ▼
静态场景 blueprint(斜率场/解族)+ odeFacts
      │
      ▼
odeTasks.ts(条目/隐藏/能力边界)+ IR.odes
      │
      ▼
UI(OdeItem + 子列表 + 徽章 + 过程页)
      │
      ▼
示例 4 个 + catalog/README 登记 + docs/ode-guide.md
      │
      ▼
全门禁 + 体积入档 -> 四期按 §2 优先级推进
```

---

## 7 附:二期已踩过,三期会再遇到的坑

写在这里是为了三期不要重踩(全部来自二期实测):

1. **参数不能早折**:静态场景按 AST 缓存,一旦在编译期把参数折成数值,拖滑块
   只重物化不重解析,曲线会冻在旧值.内核入口必须支持"只给名字不给值".
2. **另一个坐标也算"已声明"**:对 `y` 积分/求导时,`x` 必须一并告诉内核,否则
   报"未声明符号 x".
3. **下游引用靠 `resolvable`**:产物必须在静态场景层建 blueprint 并登记,否则
   `derivative(F)` 报"引用了不存在的对象 F".
4. **隐藏要过滤实体**:隐藏项不仅跳过内核,还要在 `objects` 组装时滤掉,
   否则"隐藏了却还在画".
5. **能力边界不是源码错误**:内核的能力边界走结果里的 `error` 字段,列表保留
   占位并给理由;**绝不用 `Err`/异常**表达"这题超纲".
6. **验证不过就拒绝**:任何符号产物在放行前都要回代对拍,不一致宁可报错.
7. **每个依赖都要可重跑**:`npm run build:wasm` -> 页面验证,是 Rust 改动的
   唯一完成标准.
