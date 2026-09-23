# UI 库分离设计计划

本文回答:**把界面抽成一个单独维护的 UI 库,文件怎么组织,抽之前必须先做什么,
"只导入库 + 声明式编排 UI 元素"这个目标可不可行?**

状态:**规划稿(未动代码)**.所有耦合点都标了文件与数目,可以逐条对着工作区核对
(核对时间:2026-09-22 的工作区,`src/ui` 共 14,589 行);**附录 A 给出复现这些
数字的全部命令**,数字若有出入以重跑结果为准.

正文之外另有五份附录,是首轮写作之后补的:附录 A(复现正文全部数字的命令),
附录 B(库里已经有的五条约定 + 落地时会立刻撞到的七类缺件),附录 C(搬库时最
容易丢的六件事,其中 C1 装载顺序与 C2 的 9 个 CSS 变量双份值属于"不知道就会踩"),
附录 D(以文件数计的规模参考),附录 E(**运行时依赖足迹**:今天 2 个直接依赖 /
分离后库恰好 1 个);这一轮同时修正了 §2.2 的一处算术错误(半通用应为 1,583 行,
且 `diagnostics/` 202 行原漏分类).

**U3 已拍板:走路线 B**(2026-09 决定,见 §4/§4.1);**U7 也已拍板:这一层
vendored**(依赖 `@preact/signals-core`,库对外只导出自己的 `signal` / `effect`).
§4 的 A/B/C 对比与放弃 A,C 的理由留在原处,作为决策依据存档.
**本文已无待定项.**

## 落地进展

核对时间:2026-09-22,同一工作区.**P0–P4 已完成并验证**(P4 只差附录 B.2 的补件,见文末).

> **补记一(分离已完成):库不再住在本仓库.** `packages/miko_ui` 已搬成独立仓库
> [ToyosatomiminoMiko/miko_ui](https://github.com/ToyosatomiminoMiko/miko_ui).
> 库的**边界守卫与 CI 跟着库走了**(`scripts/check_ui_boundary.mjs`,
> `.github/workflows/ci.yml`):本仓库不再有库的源码,那些断言无从执行.
> 下面表格里 P0/P1 的 `npm workspaces` / `npm run dev:ui` /
> `--workspace @miko/ui` 描述的是**当时的形态**,保留作为过程记录;现在这些
> 命令在本仓库都不存在了.改库要去独立仓库改.
>
> **补记二(改为 GitHub 直取,npm 出局):** 本仓库与 `@miko/ui` 的关系只剩两条:
>
> 1. `package.json` 里一条本地依赖 `"@miko/ui": "file:packages/miko_ui"`;
> 2. 一条 `preinstall` -> `scripts/fetch_ui.sh`:`packages/miko_ui` 不存在就
>    `git clone` 库仓库的 `main`,存在就原样复用(`--update` 才 fetch + 快进),
>    然后在库目录里 `npm ci` + `npm run build` 产出 `dist/`.
>
> 于是本地的 `npm ci` 与 CI 的 `npm ci` 都自带取库(CI 不需要 submodule,也不
> 需要任何 npm 凭据).库**不发布 npm,不打 tag,不写版本号**:它只服务本仓库,
> 还在 demo 阶段 -- 完整取舍见库仓库的 `RELEASING.md`.
>
> 一度用过的那条按 tag 固定的 GitHub 归档 URL
> (`.../archive/refs/tags/v0.1.0.tar.gz`)已经删掉.顺带记下"为什么不用 npm 的
> git 依赖(`github:owner/repo#ref`)":npm 解析**具名 ref**(分支/tag)时会走
> `git ls-remote ssh://git@github.com/...`,只有 40 位 commit SHA 才走 https;
> 现在的做法是自己的 shell 脚本直接 https clone,不经过 npm 的 git 层,也就不
> 需要 SSH key.
>
> **补记三(改为 release 产物):** 库不再从 `main` 的源码取,而是取它挂出来的
> **滚动 release 资产**(`ui-latest` / `miko_ui_dist.tar.gz`,由库的
> `.github/workflows/release.yml` 在 main 每次推送后覆盖).本仓库与 `@miko/ui`
> 的关系变成:
>
> 1. `package.json` 里一条本地依赖 `"@miko/ui": "file:.cache/miko_ui/current"`,
>    并自己声明库的运行时依赖 `@preact/signals-core`;
> 2. 一条 `preinstall` -> `scripts/fetch_ui.sh`:下载 -> 校验 -> 解开 -> 原子替换
>    缓存,落到 `.cache/miko_ui/current`(gitignore).
>
> 于是**消费者机器上没有 TypeScript,也不构建库**;补记二里那条 `git clone` 到
> `packages/miko_ui` 再本地构建的路径整个作废.`packages/miko_ui` 那时降级成
> "本机开发库时用的工作副本",不是依赖来源.`--update` / `MIKO_UI_UPDATE`
> 的语义从"fetch + 快进"变成"重新下载一份产物";取不到资产就明确失败,没有回退到
> 本地构建的路径.
>
> **补记四(工作副本也搬出本仓库):** 补记三里那个"相邻工作副本"`packages/miko_ui`
> 也搬走了 -- 库既然是上游,就不该躺在消费者仓库的工作树里(它本来靠 `.gitignore`
> 兜着,但目录在那儿就总会有人顺手改).本机现在放在
> `/mnt/IVSTINIANVS/__projects_web/miko_ui`(独立仓库,clone 自同一 origin),
> 本仓库里**没有** `packages/` 目录;`.gitignore` 留着 `packages/` 一条只作护栏.
> 对消费者毫无影响:依赖一直是 `.cache/miko_ui/current` 那份 release 产物,
> 本仓库的构建与 CI 从不读工作副本.下面各表里出现的 `packages/miko_ui` 路径都是
> **当时的形态**,保留作过程记录;要改库请去库仓库的工作副本.
>
> **补记五(更新检查已做,2026-09):** 补记四里搁置的"每次构建都确认拿到的是最新
> 产物"落地了.库侧 `scripts/pack_release.mjs` 把**构建 commit** 写进资产清单的
> `gitHead`(本地工作树脏时是 `<sha>-dirty`;`ci.yml` 的 dry-run 与 `release.yml` 的
> 交付验收都断言它等于本次构建的 commit,所以"资产说自己是谁"是可信的).消费侧
> `scripts/fetch_ui.sh` 每次 `npm ci` 都拿它比 `ui-latest` tag 指向的 commit
> (`git ls-remote --tags`,公开仓库免认证,不吃 GitHub API 限额;**不用** release
> 对象的 `target_commitish` -- 那个字段不跟着强推 tag 更新):
>
> - 相等 -> 直接用;不等 -> **自动重下**(不用手动 `--update`);
> - 资产没有 `gitHead`(旧资产)时不能确证新鲜,但来源纸条若显示它比 tag 旧,照样
>   自动重下(纸条只用来触发重取,不用来宣布"最新");
> - 查不到(断网 / 没 git / 资产不自证版本)时:**CI 里明确失败**(部署出去的不能是
>   "说不清哪一版"的缓存),本地只警告并沿用缓存.`MIKO_UI_SKIP_CHECK=1` 显式跳过
>   检查,`MIKO_UI_REQUIRE_LATEST=1` 让本地也严格;手动放置的资产记为 `local-file`,
>   不参与检查(它是发布坏掉时的兜底).
> - 下载这条路也补了上界与绕行:`--connect-timeout 10 --max-time 45` + 5 次重试
>   (github.com 在某些网络里会"DNS 通,TCP 超时",连上了也可能不吐字节),主 URL
>   不通时改走 GitHub API 的资产端点(`api.github.com` -> `objects.
>   githubusercontent.com`,同一份字节);显式给过 `MIKO_UI_ASSET_URL` 时不绕行 --
>   那是人指的路.CI 里给这一步带上 `GITHUB_TOKEN`(匿名 API 限额 60 次/小时/出口 IP).
>
> 落地顺序有要求:**先推库**(让带 `gitHead` 的资产挂出来),再推本仓库 -- 在那之前
> 本仓库的 CI 会因为"资产不自证版本"而红,这是刻意的.

| 期 | 状态 | 落地后的关键形态 |
| --- | --- | --- |
| P0 | ✅ | 建 `packages/miko_ui` 与 npm workspaces;`widgets/ shared/ desktop/ theme/ formula/` 已移入并改导入路径;`scripts/check-ui-boundary.mjs` 七条守卫接进 `npm test` 的 `pretest` |
| P1 | ✅ | D1/D4/D7 全做:库提供 `mountDesktop(root, spec)` / `DEFAULT_DESKTOP_CONFIG` / `applyTheme(root, tokens)`;`index.html` 只剩 `#app`;`packages/miko_ui/example/` 只 import `@miko/ui` 就能跑(`npm run dev:ui`) |
| P2 | ✅ | 领域视图改名 `src/views/`;新增 `src/adapters/`(IR -> 展示数据:`evaluationToSteps` / `processSteps` / `entityText`);`diagnostics/` 进库为 `feedback/MessageList`;`editor/` 进库为 `editor/`(D6:分词与槽宽下限由应用注入);D3:`EvaluationDetailLine` 提到 `src/contract/evaluation.ts`;D10 提前:库自带 `test/domStub.ts` 与 `test/desktopFixture.ts` |
| P3 | ✅ | `reactive/` 落地(vendored `@preact/signals-core@1.14.4`);四个控件的 `value` 扩成 `T \| Signal<T>`;**参数面板与整个"视图"面板改成"一份 signal + effect"**:9 个视图控制器,`EventBus`,`GraphCalcEvents` 全部下线 |
| P4 | ✅ | D8 全做完:**四份**样式进库(tokens/widgets/desktop/**editor** + 总入口,类名选择器,`./styles/*` 进 exports);`CodeEditor` 组件进库(编辑器 DOM 与结构样式一起收走);样式入口从 7 个 `<link>` 收成 `src/main.ts` 的 import;示例改用库的样式表;库能**独立** typecheck + test(217 用例,不需要 Rust);CI 拆出 `ui` job;库有了 README.**只剩**附录 B.2 的 7 类补件 |

### P4 已落地部分(D8 的样式分家)

- **去向**与 §D8 的表一致:`base.css` 的 `:root` -> 库 `styles/tokens.css`;
  `controls.css` -> 库 `styles/widgets.css`;`window.css` -> 库 `styles/desktop.css`;
  `panels.css` / `process.css` / `diagnostics.css` 留应用侧.
- **去 id**:`#window-layer` / `#snap-preview` / `#dock` 三个选择器改成类名
  (库建的容器本来就只有库自己知道,id 只服务标签关联);`#viewport` 是**应用
  内容**(3D 视口),它的规则留在应用侧 `css/base.css`;`controls.css` 里那条
  面板容器规则(`#view-controls`)也归应用,落到 `css/panels.css`.
- **§9 第三条从"空洞的 0"变成"真的 0"**:`packages/miko_ui/styles` 现在存在,
  守卫扫描它并报告 0 个 id 选择器.顺带把这条规则按附录 A.5 的注脚写严:
  排除十六进制颜色与注释(以前只靠人工剔除).
- **首帧不吃 FOUC**:样式入口从 7 个 `<link>` 变成 `src/main.ts` 的 import,
  但 Vite 会把它们(含从包里 import 的三份)抽成产物里的一个 `<link>`--
  实测产物 CSS 仍是 **56.20 kB**(与拆分前逐字节同量级),`<head>` 里照旧有
  `<link rel="stylesheet">`.
- **单一来源测试拆成两份**:库的 `src/theme/cssPalette.test.ts`(默认主题只有
  一处字面量,别名指向真实 token,库样式引用的色板都存在)与应用侧的
  `src/config/cssPalette.test.ts`(应用样式不许出现颜色字面量,引用的 token
  都能在库里找到,色板里没有死 token).`applyUiConfig.test.ts` 改成对着库的
  `tokens.css` 断言"默认值 == UI_CONFIG 映射值"--这条一过,就说明分家没有
  改动任何默认值.
- **示例现在只 import 库的样式**:`@miko/ui/styles.css` + 一份 20 行的页面级
  CSS,窗口外壳/控件/Dock 全由库的默认主题渲染(截图核对过).
- **库自己的类型检查不再挂别名**:`packages/miko_ui/tsconfig.json` 里那两行
  过渡期的 `paths`(指回应用 `src/`)删掉了,补一份最小的 `*.css` 环境声明;
  于是 `npm --workspace @miko/ui run typecheck` 能**独立**跑绿 -- 顺带证明库内
  确实只有包内相对导入(搬出去不用改 import,§7.2/R4).
- **库自己的测试能独立跑绿**:`packages/miko_ui/vitest.config.ts` 不挂仓库根
  那个 wasm setup(库的测试不碰 `@/generated`),`npm --workspace @miko/ui run
  test` 跑 **18 个文件 / 210 个用例**,不装 Rust/wasm 工具链 -- 这就是附录 C5
  要的那条证据.
- **CI 拆出 `ui` job**(§7.3):Node + `npm ci` + 库 typecheck + 库 test + 边界
  守卫,`build-and-deploy`(`needs: ui`)照旧跑 Rust/wasm 与整仓测试.
- **库有了自己的 README**:用法,公开面分组,八条边界契约,三条设计约束,
  还没做的事(见库仓库 miko_ui 的 `README.md`).

### P4 的编辑器那一刀:`CodeEditor`(D8 的最后一块)

`css/editor.css` 原来整份是 id 选择器(`#dsl-editor*`),而那些节点由**应用**建
-- 直接把它搬进库,等于把消费者的 id 抄进库的样式表,正好是 D8 要消除的东西.
所以这一刀的正确切法是"**先有组件,再有样式**":

- 新增 `packages/miko_ui/src/editor/CodeEditor.ts`:建 `.code-editor*` 那套
  结构(外框 / 行号槽 / 输入包裹层 / 透明 textarea / 高亮裁剪层),把 D6 的两个
  注入点(分词,槽宽下限)与 D7 的 root 一起收进参数;结构上"高亮层紧跟
  textarea"由代码保证,不再靠注释提醒.
- 新增 `packages/miko_ui/styles/editor.css`:结构 + 对齐样式,选择器全是类名;
  **DSL 词法配色留应用**(`.dsl-*` 由应用的分词器产出,配色在
  `css/editor.css`,作用域是库的公开类名).
- 应用的 `src/app/appViews.ts` 缩成"包一层 `#editor-panel` + 调 `createCodeEditor`";
  `#dsl-editor*` 这一批 id 从仓库里彻底消失.
- 真机核对过编辑器(行号对齐,高亮与光标重合,配色)--这是计划 §C3 点名的
  "只能真机验"的那一项.

### 拆不拆独立 repo(§8 P4 的最后一项:评估)

**结论:P0–P4 之后"能不能拆"已经不是问题,"该不该现在拆"才是 -- 现在不拆.**

能拆的证据(全部可复核):

| 项 | 实测 |
| --- | --- |
| 库 ➜ 应用 | 0 处(八条守卫里的前三条;生产代码与测试都算) |
| 库 TypeScript | `npm --workspace @miko/ui run typecheck` 独立通过,配置里**没有任何 paths 别名** |
| 库测试 | `npm --workspace @miko/ui run test` 独立跑绿(19 文件 / 217 用例),不需要 Rust/wasm |
| 库样式 | `styles/` 四份,类名选择器,无 id |
| 库依赖 | 恰好一个(`@preact/signals-core`),`katex` 可选 peer |
| CI | `ui` job 不装 Rust/wasm 就能跑绿 |

不拆的理由(与 §7.1 的表一致):

1. **还没有第二个消费者**:拆出去之后每次改库都要发版,双仓联调;而现在应用每天
   都在改库的 API(这一路的 P0–P4 就是证明).
2. **API 还在动**:控件刚刚接受 `T | Signal<T>`,`viewState` / `CodeEditor` 也才
   定型;发版语义(哪些是稳定面)现在写不出来.
3. **拆的机械成本已经很低**:库内没有相对路径逃逸到仓库外,没有别名,没有对
   应用源码的引用,所以真要拆,就是把 `packages/miko_ui` 整个目录搬到一个新 repo
   再把 `@miko/ui` 换成发版依赖 -- 不需要先做一轮"为了拆而拆"的重构.

触发条件(出现任一条再拆):出现第二个消费者;`index.ts` 的公开面连续几个迭代
不再变动;或者需要独立版本号/独立发布节奏.

### P4 只剩附录 B.2 的 7 类补件

`TextField` / `Menu` / `Splitter` / `ScrollArea` / 表格件 / `Dialog`·`Toast` /
`Tooltip` 都是**新功能**,不影响"分离"这件事的成立:库的边界,样式,测试基线,
文档都已就位,补件按普通功能排期即可(它们该长成什么样,取决于下一个真实消费者).

### P3 落地部分的细节

- 依赖足迹按附录 E.2 变成:**库恰好一个必需依赖** `@preact/signals-core@1.14.4`
  (零传递依赖,`sideEffects: false`);`katex` 仍是可选 peer.`deps` 守卫盯着
  "不许再多一个".
- 三条约束各有对应物:公开面只有库自己的 `signal` / `computed` / `effect` /
  `derivedSignal` / `onValueChange` / `isSignal` / `ValueSource` 工具(消费者看不到
  `@preact/signals-core`);**`batch` 既不在公开面,也在源码里一次都没出现** --
  后一条由边界脚本新增的 `no-batch` 规则与 `reactive.test.ts` 各守一遍;
  不做跨模块 store.
- **与计划的一处偏差**:§4.1 的约束 3 里列了 `onCleanup`,但 vendored 的
  1.14.4 **没有这个导出**(1.x 的清理语义是 `effect` 回调**返回**一个清理
  函数).库沿用上游语义,不再自己发明同名 API;`reactive.test.ts` 按返回
  清理函数来断言.
- 控件的增量路径按计划走:`Switch` / `Slider` / `NumberField` / `Segmented`
  的 `value` 接受 `T | Signal<T>`,传普通值行为一字未变(旧测试全绿),
  传 signal 时"值变了控件自己更新,用户操作写回信号".数字框额外处理了
  "输入中途的 `1.` 不被镜像更新改写"(`selfWrite` 短路)与"步长随模式变"
  (`step` 也接受 signal)这两处.
- **参数面板**(`ParamPanelController`):一行从"滑块值 + 数字框值 + 一份
  `values` 缓存"三个状态源收成一个 `signal<number>`;左边那条
  `writeValue()` 四处一起改的手工同步没有了,归一化收在数字框的 `normalize`
  选项里(信号里永不出现越界值).**原有 16 条行为测试一字未改全绿**.
- **视图面板**:新增 `src/views/view/viewState.ts`(全部控件状态 + 两个可写
  派生信号:开关的"勾选 = 正交",点大小的"倍数 ↔ 半径"),`ViewPanel` 只做
  结构 + 绑定并自己持有生命周期,`RenderController.bindViewState()` 用
  `effect` 把状态推到 CameraManager/Plotter/SceneManager.
- **下线的东西**:`src/views/view/controls/` 9 个控制器及其 2 个测试文件,
  `src/contract/events.ts` + 测试,`src/core/EventBus.ts`(95 行,唯一消费者
  就是这条链路).`RenderController` 因此少了约 140 行事件接线;`DslApp` 的
  构造函数从 64 行收到 **45 行**(编辑器装饰件与对象列表回调各自抽成一个私有
  方法).
- **`ObjectListController` 没有改**:计划把它和另外两个面板并列,但它的输入是
  编译产物(`SceneIR`),没有"两个状态源"要消掉 -- 列表每次由场景重建,行复用
  已经交给 `KeyedRowList`.把它改成 signal 只会多一层中间物,属于计划自己的
  R1("库一层 props,app 又一层 adapter").这一条留在这里,不是漏掉.

P2/P3 之后的总实测口径(复核命令即附录 A,另有 `npm run lint:ui-boundary`):

- **边界守卫全部为 0**(P2 之后是 7 条,P3 又加了 `no-batch` 共 8 条):
  `packages/miko_ui` 的源码与测试都不再引用应用侧任何东西(夹具与 DOM 桩都
  自带).`boundary-baseline.json` 从这一刻起是硬约束,任何一条变正都会让
  `npm test` 失败;
- §9 的第三条(样式里没有 `#`)从 P4 起是**真的 0**:`packages/miko_ui/styles`
  已经存在,守卫会扫它(排除十六进制颜色与注释);
- 应用侧 **77 个测试文件 / 740 个用例**,`tsc`,`vite build` 全绿;库单独跑 **19 个文件 / 217 个用例**(`npm run test:ui`,不装 Rust/wasm);
- **真机验证**:构建产物在 Chromium 里起得来(P2 / P3 / P4 之后各验一次:五个
  窗口 + Dock + 编辑器高亮 + 参数滑块/对象/求值列表/视图面板都有内容,控制台
  无错;P4 的样式分家前后截图与产物 CSS 体积(56.20 kB)一致);库示例页
  `npm run dev:ui` 现在也用**库自己的样式表**渲染.

### P3 里**没有**照字面做的一项

`ObjectListController` 没有改成 signal(理由见上).另外两处**超出计划**的删除是
`src/contract/events.ts`(内容就是那 9 条视图事件)与 `src/core/EventBus.ts`
(95 行,唯一消费者就是这条链路,且没有自己的测试):留着就是无人引用的抽象,
与计划 §10"不留将来可能用得上"的口径冲突.§6.2 的目标布局里列了 `core/EventBus`,
这份表要在 P4 的文档阶段同步(the app 现在没有跨模块事件总线).


### P2 里**没有**照字面做的两项,以及理由

计划把 D2(适配层)与 D5(控件初值注入)列为 P2 项,但两者的验收都是
"库源码 grep 不到 `@/contract/ir` / `@/config/renderConfig`" -- 这条在边界定下来
之后**已经成立**:`entity/ evaluation/ objects/ params/ process/ view/ examples`
整体是应用视图(§2.1 的判定表),它们留在 `src/views/` 里读应用配置是合法的,
库这一侧一个字节都不碰 IR 与渲染默认值.

于是 P2 没有做这两件事的机械动作,理由分别是:

- **D5**:把 `RENDER_CONFIG` 从 9 个控制器挪到 `ViewPanel` 再传进去,是应用内部
  的横向搬家,不改变任何边界,却要动 9 个文件与它们的测试.等这些控件真的进库
  (目前没有这个计划)时再做,才有验收对象.
- **D2**:P2 当时先不做"IR -> props"的适配层,理由是 props 的形状要等 P3(控件
  接受 `T | Signal<T>`)定下来;P3 之后补上了**能做到的那一半**:`src/adapters/`
  收了三个纯函数模块(`evaluationToSteps` / `processSteps` / `entityText`),把
  "读哪些字段,拼成什么文本"从 `views/` 里分出来.没有再造一层泛化的 `Field` /
  `ListItem` props -- 面板现在直接把 signal 绑到控件上,中间那层没有消费者,
  属于计划自己的 R1.

这两条都记在这里,不是漏掉.

与计划的**偏差**(都已落在代码注释里,这里汇总一次):

1. `desktop/windowChrome.ts` 提前在 P1 移到应用侧 `src/app/windowChrome.ts`
   (原本记在 P2 的 D9):它的文案与节点都是应用内容,D4 把配置注入之后它在库里
   已无通用价值;`windowSlotsProvider` 作为通用件留在库的 `desktop/windowSlots.ts`.
2. `editor/legacyEditorCommand.ts` 提前移入库的 `dom/legacyCommand.ts`
   (原本记在 P2 的 D6):它是 DOM 原语而非编辑器逻辑,移进来之后库的生产代码
   才真正做到零 `@/` 引用;签名按 D7 加了 `doc` 参数.
3. `theme/cssPalette.test.ts` 先留在应用侧 `src/config/`(它读的是 `css/*.css`,
   而 CSS 分家在 P4/D8);`theme/applyUiConfig.ts` + 其测试移到
   `src/app/applyUiConfig.ts`(它是应用配置到 token 的映射).
4. `desktop/desktopHosts.test.ts` 删除,换成库侧的 `desktop/mountDesktop.test.ts`
   与应用侧的 `src/app/appViews.test.ts`:hostId 这条契约在 D1 之后不存在了.
5. **D10 提前到 P2**:库的测试要跟着 `diagnostics/` 与 `editor/` 一起进包,
   再借"应用侧骨架"就说不通了.库现在自带 `packages/miko_ui/test/domStub.ts`
   (从 `src/testing/domStub.ts` 复制)与 `test/desktopFixture.ts`(窗口配置夹具,
   替掉 4 个 desktop 测试里的 `@/config/uiConfig`).分家期间两份桩同步维护,
   库独立成 repo 后各自演进.
6. `editor/` 的注入点做成 `highlight(source) => html` 而不是计划里写的
   `tokenize(line, state) => Token[]`:库连"token 是什么"都不需要知道,应用侧
   `src/editor/dslHighlight.ts` 仍然是分词 + 转义 + span 一把做完.换语言只换
   这一个函数,高亮层的滚动同步/帧合并/结构契约一行不动.
7. `src/ui/` 目录在 P2 之后消失:应用视图 -> `src/views/`,`diagnostics` ->
   库的 `feedback/`,`editor` -> 库的 `editor/`,DSL 分词与词法相关测试 ->
   `src/editor/`.

| # | 决定 | 状态 | 内容 |
| --- | --- | --- | --- |
| U1 | 分离形态 | **已定(本稿建议)** | 先在本仓库内做 `packages/miko_ui`(npm workspaces),API 稳定或有第二个消费者后再拆独立 repo.与 `Cargo.toml` 里已有的 workspace 组织方式对称 |
| U2 | 库的边界 | **已定(本稿建议)** | 库提供**结构与交互**;应用提供**内容,初值,领域枚举,回调**.库不认识 `SceneIR` / 编译器 / 数学内核 |
| U3 | 响应式运行时 | **已定:路线 B**(2026-09) | 库提供一个极小的响应式层(signal / computed / effect),控件接受 `T \| Signal<T>`;这一层由 vendored `@preact/signals-core` 实现(U7).放弃 A(声明式到不了 L3)与 C(推翻"不引框架/不用 JSX"的既有取舍,测试面全动).见 §4,§4.1 |
| U4 | 落地节奏 | **已定(本稿建议)** | 分 P0–P4,每期独立可提交;P0 只动文件与目录,不引运行时(信号进 P3) |
| U5 | 是否换 DOM 测试环境 | **已定(随 U3 = B)** | **继续用**现有 900 行手写 DOM 桩(`src/testing/domStub.ts`).前提是 R2 那条硬约束:effect 同步执行,库的更新路径不引 rAF/微任务 |
| U6 | 库的样式契约 | **已定(本稿建议)** | 库的样式**只有类名**,不许出现 id 选择器;token 层(`--color-*` / `--radius-*`)进库并开放覆盖 |
| U7 | 信号的实现来源 | **已定:vendored**(2026-09) | 依赖 `@preact/signals-core`(MIT,零依赖,min 5.7KB / gzip 2.0KB),**但库对外只导出自己的 `signal` / `effect` / `computed`**,不把该包的 API 当成公开面.见 §4.1 末 |

**怎么读这份文档**:

| 要干什么 | 读哪几节 |
| --- | --- |
| 先知道"可不可行,卡在哪" | §1 -> §3 |
| signal 是啥 / 为什么选了 B,U7 | §4 -> §4.1(含 vendored 的三条约束) |
| **动手前必做**:去耦合清单 | §5(D1–D10) |
| 知道库长什么样,文件放哪 | §6 |
| 决定怎么单独维护与构建 | §7 |
| 按阶段推进 | §8 |
| 怎么算"真的独立了" | §9(三条断言) |
| 风险与明确不做的事 | §10 |
| **复核数字**(每个数都能重跑) | 附录 A |
| 库里已经有的约定 / 还缺哪些件 | 附录 B(B.1 五条约定,B.2 七类缺件) |
| **搬的时候最容易丢的东西** | 附录 C(C1 装载顺序,C2 CSS 变量双份,C3 真机项...) |
| 估规模 | 附录 D(动过的文件数) |
| **有哪些运行时依赖**(今天 / 分离后) | 附录 E(含 CI 守卫) |

---

## 一/结论摘要

1. **可行,但不是"把 `src/ui` 整个搬出去"那种可行**(§2).`src/ui` 里只有约四成
   是通用 UI(含测试 5.5k 行),一半是这个应用的界面(7.3k 行,直接消费
   `SceneIR` / `ParamDeclaration` / 编译器拼的 LaTeX).不先做 §5 的去耦合,
   搬完只会得到一个"必须带着 IR 和编译器才能安装的 UI 库".
2. **"声明式编排"是三层,不是一件事**(§3):L1 结构声明(已有,`el()`)/
   L2 编排声明(一半,`UI_CONFIG.window` 已经是,`DslApp` 构造函数还是命令式)/
   L3 状态绑定(**没有**,全靠 `render()` + `set()` + 手写回调).**L3 才是这个
   目标的门槛**,所以 §4 那条决策绕不过去.
3. **最容易误判的一条:"UI 不依赖 three.js"**.实测 UI 层只 import 一个外部包
   `katex`,没有任何 `@/render/*`.与渲染层之间已经是"契约类型 + 回调",最贵的
   一刀早就切完了(§2.3).真正横在中间的不是渲染,是**编译器的 LaTeX 生成**
   (`@/compiler/dsl/evaluationLatex`,10 处)和 **IR 类型**(`@/contract/ir`,
   21 处).
4. **宿主 DOM 的方向是反的,这是第一个硬阻塞**(D1).今天 `index.html` 手写
   20+ 个 id 宿主,`src/app/appHosts.ts` 负责按 id 取;库不能要求消费者先手写
   一堆 id.好消息是离目标只差一步:`UI_CONFIG.window` 的 `windows[]` +
   `adopted[]` + `slots` 已经是标准的声明式形状,只差"库自己建容器".
5. **已选路线 B(2026-09)**(库自带极小 signal).它同时满足"真正的声明式编排"
   与这个仓库既有的两条取舍:`src/ui/widgets/dom.ts` 文件头明确写的"不引框架/
   不用 JSX/不做 diff",以及"不引前端构建插件".而且更新是同步的,900 行 DOM 桩
   照样能用,不必被迫上 jsdom.信号这一层的**来源**仍未定(U7,见 §4.1 末).
6. **"真的独立了"可以机械化判定**(§9):库源码里 grep 不到 `@/contract`,
   `@/compiler`,`@/math`,`@/config/renderConfig`,grep 不到 `getElementById`,
   样式里 grep 不到 `#`.三条同时成立就是独立库;哪条破了,就是刚漏进来的耦合.

---

## 二/体检:现状与实测数据

### 2.1 依赖全景

**UI -> 外部包**(`src/ui` 里所有非相对 import):

| 包 | 处数 | 说明 |
| --- | --- | --- |
| `katex` | 1 | 只在 `src/ui/formula/FormulaView.ts` |
| `vitest` / `node:fs` | 39 | 全在 `.test.ts` |

**没有 `three`**.这一条是本方案最有利的事实.

**UI -> 领域模块**(`src/ui` 里对 `@/{contract,compiler,math,render,core,config}` 的 import):

| 目标模块 | 处数 | 消费者 |
| --- | --- | --- |
| `@/config/uiConfig` | 25 | 除 `widgets/` `shared/` `entity/` `evaluation/` `objects/` `formula/` 外几乎全部 |
| `@/contract/ir` | 21 | `entity/` `evaluation/` `objects/` `params/` `process/` |
| `@/testing/domStub` | 23 | **仅测试** |
| `@/core/EventBus` | 11 | `view/` `view/controls/` |
| `@/contract/events` | 11 | `view/` `view/controls/` |
| `@/compiler/dsl/evaluationLatex` | 10 | `evaluation/` 6 个 item + `process/processData.ts` + `process/disclosure.ts` |
| `@/contract/view` | 9 | `view/` `view/controls/` |
| `@/config/renderConfig` | 7 | `view/ViewPanel.ts` `view/controls/*` |
| `@/math/paramValue` | 1 | `params/ParamPanelController.ts` |
| `@/math/latexNumber` | 1 | `evaluation/` |
| `@/compiler/dsl/keywords` | 1 | `editor/dslHighlight.ts` |

按目录看,边界其实已经很清楚了:

| 目录 | 领域 import | 判定 |
| --- | --- | --- |
| `widgets/` `shared/` | 无 | ✅ 通用 |
| `desktop/` | 只有 `@/config/uiConfig` | 🟡 通用,**但配置不可注入** |
| `theme/` | 只有 `@/config/uiConfig` | 🟡 通用,同上 |
| `editor/` | `@/compiler/dsl/keywords`,`uiConfig` | 🟡 半通用:差一个注入的分词器 |
| `entity/` `objects/` | `@/contract/ir` | ❌ 应用视图 |
| `params/` | `ir`,`paramValue` | ❌ 应用视图 |
| `evaluation/` | `evaluationLatex`,`ir`,`latexNumber` | ❌ 应用视图 |
| `process/` | `evaluationLatex`,`ir`,`uiConfig` | ❌ 应用视图 |
| `view/` `view/controls/` | `events`,`view`,`EventBus`,`renderConfig`,`uiConfig` | ❌ 应用视图 |
| `formula/` | 外部 `katex` | 🟡 通用(公式渲染件) |
| `diagnostics/` | **零 import**(只吃容器 + `DiagnosticEntry[]`) | ✅ 通用(消息列表件) |
| `examples/` | - | ❌ **应用数据**(示例 `.miko` 目录) |

**反向依赖很干净**:只有 4 个文件从外部 import UI:

```
src/app/DslApp.ts          装配 14 个控制器
src/app/RenderController.ts 装配 9 个视图控件控制器
src/app/appHosts.ts        按 id 取宿主(唯一 getElementById 点)
src/main.ts                applyUiConfig() + new DslApp()
```

### 2.2 `src/ui` 的三分类(含测试行数)

| 分类 | 目录 | 行数 | 去向 |
| --- | --- | --- | --- |
| 通用 UI 内核 | `widgets/` `shared/` `desktop/` `theme/` | 5,551 | **进库** |
| 通用小件 | `diagnostics/`(零 import) | 202 | 进库 |
| 半通用(差注入) | `editor/` `formula/` | 1,583 | 进库(需 D6) |
| 应用视图 | `entity/` `evaluation/` `objects/` `params/` `process/` `view/` `examples/` | 7,253 | **留 app**,改名 `src/views/` |
| 合计 | 16 个目录 | 14,589 | - |

> 逐项行数:`widgets`+`shared` 2,060 / `desktop`+`theme` 3,491 / `editor` 1,144 /
> `formula` 439 / `diagnostics` 202 / 应用视图 7,253.分母 14,589 是 `src/ui`
> 下全部 `.ts`(含测试)的行数.

### 2.3 三条既成事实(方案的地基)

1. **token 层已经有了**.`css/base.css` 里是完整的 `--color-*`(40+ 个)与
   `--radius-*` 尺度,组件里一律写 `var(...)` 而不写具体像素.抽库最难的"设计
   系统"这一层不需要从零做,只需要把它从"页面基础样式"提升为"库的主题入口".
2. **声明式窗口配置已经有了**.`UI_CONFIG.window` 的 `windows[]`(id/title/
   几何/minSize)+ `actions[]`(按钮文案与 glyph)+ `adopted[]`(节点 ->
   窗口 -> 槽位)+ `WindowSlot = 'title' | 'actions' | 'overlays'` 加
   `windowSlotsProvider()`,就是一套标准的声明式布局 API,
   `src/ui/desktop/WindowFrame.ts` 已经是"按声明建结构"的形状
   (`docs/windowing-plan.md` §5.3 明确写了"全程声明式(硬约束)").
3. **控件层的形状是对的**.`Button` / `Switch` / `Segmented` / `Slider` /
   `NumberField` / `Popover` 都返回 `{ element, get, set, onChange, dispose }`
   句柄,`createSegmented<T extends string>` 已经是泛型,视图与控制器分工
   (`ViewPanel` 文件头:"本文件不认识 EventBus")也已经划开.这是库的 API
   母版,只是还停在"句柄 + 显式更新"这一层.

---

## 三/"声明式编排"的三层定义

"声明式"在这个目标里是三个不同的东西,混在一起谈就会得出错误结论.

### 3.1 L1 结构声明 -- 已有

```ts
el('div', { class: 'control-row' }, label, input)
```

`src/ui/widgets/dom.ts` 就是一棵用表达式写的树,文件头明确"不引 JSX,不做
虚拟 DOM/diff".这一层可以原样进库.

### 3.2 L2 编排声明 -- 一半

已经有声明式的部分:

```ts
UI_CONFIG.window.windows      // 有哪些窗口,标题,几何锚点,最小尺寸
UI_CONFIG.window.adopted      // 哪个节点进哪个窗口的哪个槽
UI_CONFIG.window.actions      // 标题栏按钮的顺序与文案
```

还是命令式的部分:`src/app/DslApp.ts` 构造函数里 14 个控制器的 `new` +
回调注入(第 100–163 行),以及 `RenderController.wireViewControls()` 里
9 个视图控制器的接线.这一段今天就是"编排",但它是**命令式编排**.

### 3.3 L3 状态绑定 -- 没有

今天数据流的形状是:

```text
编译产物 ──► controller.render(scene)      // 显式推
用户操作 ──► handle.onChange(cb) ──► 手写回调 ──► 另一处 handle.set()  // 显式拉
```

**没有任何一处是"值变了,用它的 DOM 自己更新".** `ParamPanelController`
甚至专门存了一份"当前值"缓存用于双向同步 -- 这正是缺少 L3 时的必然产物.

### 3.4 为什么 L3 决定可行性

用户要的"我只导入 UI 库,声明式编排 UI 元素",L1+L2 能给你**结构**上的声明
式;但真正做到"编排",你需要能写:

```ts
numberRow('半径', pointRadius, { min: 0, step: 0.05 })   // 值是一个 signal
```

而不是:

```ts
const row = createNumberRow('半径', field);
// ... 20 行之后
field.set(renderer.getPointRadius());
```

前者要求库提供"值 -> DOM"的绑定.这就是 U3 那条决策的全部内容.

---

## 四/决策:路线 B(已定,2026-09)

下表保留 A/B/C 三条路线的完整对比,作为**这条决策的依据存档** --
以后若有人问"为什么不用 React / 为什么不干脆不起运行时",答案在这里,不必重新论证.

| 路线 | 库提供什么 | 代价 | 能达成的效果 | 结论 |
| --- | --- | --- | --- | --- |
| A 不起运行时 | `el()` + 控件 + 窗口系统的加强版,对外 `mountDesktop(spec)`;数据更新仍靠 `render()` / `set()` | 最小;3 个硬阻塞(D1/D4/D7)仍要先做 | 声明式只到**结构与布局**;**达不到"编排"** | ✗ 放弃:目标是"声明式编排",A 到不了 |
| **B 自带 signal** | 一个极小的响应式层 `signal/effect/computed`(**vendored `@preact/signals-core`**:MIT,零依赖,min 5.7KB / gzip 2.0KB);控件接受 `T \| Signal<T>` | 多一个运行时依赖(见附录 E);但更新同步,**现有 DOM 桩仍可用**,测试策略不变 | **真正达成"声明式编排"**;不违反 `dom.ts` 文件头的既有取舍 | ✅ **选它**(U7 也选 vendored) |
| C 引 Lit / React / Solid | 库变成某框架的组件集 | 推翻既有取舍;900 行手写 DOM 桩要换 jsdom,测试面全动;单页桌面壳收益有限 | 只在"库要给外部人用"时才划算 | ✗ 放弃:代价最大而当前收益最小 |

**已选 B**.目标 DX(库侧):

```ts
import { mountDesktop, signal, section, switchRow, numberRow, codeEditor } from '@miko/ui';
import '@miko/ui/styles.css';

const pointRadius = signal(0.2);

mountDesktop(document.getElementById('app')!, {
  windows: [
    {
      id: 'source', title: '源码',
      geometry: { x: { at: 16 }, y: { at: 16 }, w: { at: 420 }, h: { fraction: 0.68 } },
      content: () => codeEditor({ value: sourceText, tokenize: dslTokenize }),
    },
    {
      id: 'view', title: '视图',
      content: () => section('点', [
        switchRow('可见', pointVisible),
        numberRow('设定大小', pointRadius, { min: 0, step: 0.05 }),
      ]),
    },
  ],
  actions: ['minimize', 'maximize'],
  dock: true,
});

// 应用侧只剩"库里的值 -> 渲染层"这一条线
pointRadius.subscribe((r) => renderer.setPointRadius(r));
```

选 B 之后,`DslApp` 会从"14 个控制器 + 手写回调注入"缩到"状态源 + 渲染接线",
`view/controls/` 那 9 个控制器里与"读控件值再转发"有关的部分会自然消失
(`EventBus` 在声明式模型下退化成 props 回调,`GraphCalcEvents` 这张表留在 app).

### 4.1 signal 到底是什么,在这份代码里替掉什么

**一句话**:signal 是"一个会通知订阅者的值容器";effect 是"读了哪些 signal,
就在它们变化时重跑".它不含组件,模板,生命周期,虚拟 DOM,diff,调度 --
只有"值 -> 通知"这一件事.语义核心约 25 行:

```ts
let current: (() => void) | null = null;

export function signal<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => { if (current) subs.add(current); return value; },
    set: (next: T) => {
      if (Object.is(next, value)) return;   // 同值不通知:这是"不抖动"的来源
      value = next;
      for (const s of [...subs]) s();
    },
    peek: () => value,
  };
}

export function effect(fn: () => void): () => void {
  const run = () => {
    const prev = current; current = run;
    try { fn(); } finally { current = prev; }
  };
  run();
  return () => { /* 从各依赖的 subs 里摘除 run */ };
}
```

> 这段代码是**用来说清语义的,不是待写清单**:U7 已选 vendored(§4.1 末),
> 库不自己实现它.留着它是因为下面那两条约束(`Object.is` 同值短路,effect 同步
> 执行)正是"不抖动"与"手写 DOM 桩还能用"的依据.

**它替掉的是什么**:今天每个控件都要手写一条"值 -> 控件 -> 值"的同步回路.
以 `src/ui/view/controls/PointStyleController.ts`(第 39–55 行)为例:

```ts
this.sizeValue = controls.value.read() ?? this.baseRadius;   // 真相在这里
controls.visible.onChange((v) => { this.visible = v; this._emit(); });
controls.mode.onChange((m) => this._switchMode(m));          // 手动回写
controls.value.onInput(apply);                               // 手动回写
controls.value.onCommit(apply);                              // 手动回写
this._syncModeUI();  // 把值推回数字框 + 改 label 文案 + 改 input.step,三件事一起
this._emit();        // 再推给 EventBus -> RenderController -> CameraManager
```

六条手工同步路径,而且 `_syncModeUI()` 一条要同时管文案,`step`,文本三样.
signal 版(业务口径一条不少,`size ↔ scale` 的换算变成 `computed`):

```ts
const radius  = signal(0.2);
const mode    = signal<PointMode>('size');
const visible = signal(true);
const display = computed(() => mode.get() === 'size'
  ? radius.get()
  : radius.get() / baseRadius);              // 这就是原来的 _displayValue()

numberRow('大小', display, { min: 0, step: () => (mode.get() === 'size' ? 0.05 : 0.1) });
// 控件内部:display.get() 建初值,onInput 里 display.set(...),DOM 更新由绑定做
effect(() => cameraManager.setPointRadius(radius.get()));   // 原 _emit() 那一跳
```

看不到"手动回写"了 -- 不是代码变短,是**同步路径从 6 条变成 0 条**,而"只有
一个状态源"从"每个控件作者自己记得"变成机制保证.你们自己的注释早就说过这件
事:`src/ui/widgets/Switch.ts` 文件头写"外部(控制器)**不反向持有**一份布尔值
再同步回来 -- 那正是'两个状态源'的老问题";`PointStyleController` 写"状态只有
一个来源 `sizeValue` ... 因此不存在死配置".**那两段话就是在手工执行 signal 的
规则,代价是每个控件都要手抄一遍.**

**它不是**:

- 不是框架:没有组件,模板语言,JSX,生命周期钩子,虚拟 DOM,diff;
- 不做调度:`set()` 同步执行订阅者 -- 这条已写进 §10 的 R2(库的更新路径
  不许引 rAF/微任务);
- **不接管 DOM**:订阅回调里仍然是你自己写 `input.value = format(v)`,库只替你
  决定"什么时候该写".`NumberFieldOptions` 里已有的 `format` / `parse` 两个钩子
  正好就是这条绑定的接缝,不需要新概念;
- 不替代 rAF 合并:`DslApp._scheduleRefresh` 合并的是**编译**,不是 DOM 更新,
  那条保留不动(它属于应用,不属于库).

**U7:这一层从哪来(已定:vendored)**.U3 定了"要有这一层",U7 定了它由谁实现:

| 选项 | 内容 | 代价 | 收益 | 结论 |
| --- | --- | --- | --- | --- |
| **(a) vendored** | 依赖 `@preact/signals-core`(独立类包,**不带 preact 框架本体**),但**库对外只导出自己的 `signal` / `effect` / `computed`** | 运行时依赖多一个(见附录 E) | 依赖图跟踪,嵌套 effect,`computed` 失效传播这些最容易写错的地方不用自己扛 | ✅ **选它(2026-09)** |
| (b) 自写 | 自己实现那约 200 行 | 要维护一份基础原语;写错的症状是"某个控件偶尔不更新"这种最难查的 bug | 零新依赖;`effect` 的清理可与"一件一个 `AbortController`"(附录 B.1 第 1 条)完全对齐 | ✗ 放弃 |

选它的理由只有一条但很实际:**signal 的 bug 全部长在库的最底层,症状是"偶尔不
更新"而不是"报错"**,排查成本远高于省下的那点体积.

**要守住的三条约束**(否则 vendored 会变成"引了个框架进来"的口子):

1. **公开面是库自己的 API.** `@miko/ui` 导出的是自己的 `signal` / `effect` /
   `computed` 包装,`Signal<T>` 类型也由库定义(或再导出别名).**不要**让消费者
   `import { signal } from '@preact/signals-core'` -- 那样将来换成自写实现就是
   破坏性变更,而且两个包各建一份 signal 实例时依赖跟踪会互相看不见.
2. **不使用 `batch()`**(§10 的 R2).signals-core 的 effect 默认就是同步执行的,
   `batch()` 是显式选的批处理.库里一次都不用,**"更新路径不引调度器"这条硬约束
   才成立**,手写 DOM 桩也才能继续用.
3. **不把它当状态管理库用.** 只取 `signal` / `computed` / `effect` / `onCleanup`;
   不用它的 `Signal` 自动订阅糖(那需要 JSX/模板),也不用它做跨模块 store.

许可与体积的实测(2026-09,`@preact/signals-core@1.14.4`):MIT(**与项目的
AGPL-3.0 兼容**,保留其 license 声明即可),`dependencies` 字段不存在(零依赖),
`sideEffects: false`(可摇树),min 5,696 B / gzip 2,024 B.

**增量落地的办法**(避免"要么全改要么不改"):控件的值参数接受
`T | Signal<T>` -- 传普通值维持今天的行为,传 signal 就订阅.于是 `ViewPanel`
可以一个控件一个控件地转过去,P3 不必一次性推翻.

---

## 五/去耦合清单

D1–D7 是**硬阻塞**(不做,库无法被外部消费);D8–D10 是收益项.

### D1 反转宿主 DOM 的方向(硬阻塞)

- **现象**:`index.html` 手写 20+ 个 id 宿主(`#app` `#viewport`
  `#window-layer` `#snap-preview` `#dock` `#left-panel` `#view-controls`
  `#right-page-params` `#params-panel` `#diagnostics` `#right-page-process`
  `#process-panel` `#bottom-panel` `#entity-object-list` 等 7 个子列表
  `#dsl-editor*` 5 个).`src/app/appHosts.ts` 是**唯一**按 id 取节点的地方,
  缺一个就抛带 id 的错误.
- **处理**:库提供 `mountDesktop(root, spec)`,自己建
  `#window-layer` / `#snap-preview` / `#dock` 与每个窗口的正文;应用只提供
  **内容节点或内容工厂**(`content: () => HTMLElement`).`index.html` 缩到
  `<div id="app">` + `<link>`.
- **为什么成本低**:`UI_CONFIG.window.adopted` + `windowSlotsProvider()` 已经是
  "节点 -> 窗口 -> 槽"的声明式增补,只差"容器由库建"这一步.
- **验收**:`index.html` 里再无窗口/面板宿主 id;库源码里 grep 不到
  `getElementById`.

### D2 领域 IR 出库(硬阻塞)

- **现象**:`@/contract/ir` 在 21 个 UI 文件里被 import(`EntityItem`,
  `entityText`,`EvaluationItem`,`analysisItem`,`integralItem`,
  `ParamPanelController`,`processData`,`processSteps` ...).
- **处理**:应用侧新增 `src/adapters/`,做 `SceneIR -> 库 props`;库只认视图
  模型(`Field` / `ListItem` / `Step` / `TableRow`).
- **实际工作量比听起来小**:`*Item.ts` 里与 IR 有关的只是几个字段读取与文本
  拼接,渲染骨架已经在 `shared/rowDom.ts` 里通用化了.
- **验收**:库源码 grep 不到 `@/contract/ir`.

### D3 编译器的 LaTeX 生成出库(硬阻塞)

- **现象**:`src/ui/evaluation/*Item.ts`(6 个),`src/ui/process/processData.ts`,
  `src/ui/process/disclosure.ts` 直接 import
  `@/compiler/dsl/evaluationLatex`.其中 `disclosure.ts` 只为一个类型而 import
  编译器(`EvaluationDetailLine`).
- **为什么这条最深**:这不是"UI 用了领域工具函数",而是**编译器在为界面拼
  LaTeX**.留着它,消费者必须先安装并初始化你的编译器.
- **处理**:`EvaluationDetailLine` 是纯数据(`string` + `kind`),把它从
  `compiler/dsl/evaluationLatex.ts` 提到契约层(建议
  `src/contract/evaluation.ts`);库只吃 `{ latex, kind, label }[]`.顺带能收回
  一处双份口径:`src/contract/ir.ts:804` 的注释说明 IR 与 `evaluationLatex`
  各写了一份同样的公式拼装.
- **验收**:库源码 grep 不到 `@/compiler`.

### D4 配置从单例变成注入(硬阻塞)

- **现象**:`@/config/uiConfig` 在 25 处被 import,是模块级 `as const` 单例;
  `src/ui/theme/applyUiConfig.ts` 无参数直接读它.
- **处理**:拆两半 -- **库默认值**(token,窗口几何锚点,控件 min/step/清单)与
  **应用配置**(有哪些窗口,标题叫什么,每个窗口装什么内容).库的所有配置走
  构造参数;`applyUiConfig(root = document.documentElement)` 改成
  `applyTheme(root, tokens)`.
- **注意**:`UI_CONFIG.window.windows[].hostId` 这条字段在 D1 之后应当消失
  (宿主不再由应用提供).
- **验收**:库源码 grep 不到 `@/config/uiConfig`;存在一份库自己的
  `defaultConfig`,示例页只靠它就能起来.

### D5 控件初值与渲染默认值解耦(硬阻塞)

- **现象**:`src/ui/view/ViewPanel.ts` 与 `src/ui/view/controls/*` 直接读
  `@/config/renderConfig` 取初值(点半径,轴线宽等 7 处).
- **处理**:初值改成构造参数注入(读 `RENDER_CONFIG` 这一段上移到 app).
  控制器本来就用 `handle.get()` 收口,所以只是把"配置来源"从库内挪到库外.
- **验收**:库源码 grep 不到 `@/config/renderConfig`.

### D6 业务与语法细节改成注入

- `src/ui/params/ParamPanelController.ts` -> `@/math/paramValue`(`normalizeParamValue`
  的循环系数回绕):改成注入一个 `normalize(value: number): number`,一个参数.
- `src/ui/editor/dslHighlight.ts` -> `@/compiler/dsl/keywords`:编辑器组件改成
  `tokenize(line, state) => Token[]` 注入;`dslHighlight.ts` 与关键词表留 app,
  `css/editor.css` 里的词法配色类随分词器留在 app(或用 CSS 变量开放).
- **验收**:库源码 grep 不到 `@/math`,`@/compiler/dsl/keywords`.

### D7 全局 `document` / `window` 改成 root 注入(硬阻塞)

- **现象**:`src/ui/widgets/dom.ts`(`document.createElement`),
  `src/ui/shared/dragGesture.ts`(`document.body`),
  `src/ui/shared/KeyboardController.ts`(`document.addEventListener`),
  `src/ui/theme/applyUiConfig.ts`(`document.documentElement`),
  `src/ui/formula/FormulaView.ts`,`src/ui/evaluation/evaluationDom.ts`.
- **处理**:库统一一个 `root: Document | ShadowRoot`,建节点与查询都从 root 走
  (`src/ui/widgets/dom.ts` 的 `el()` 加一个 root 上下文).
- **收益不止可测性**:同页两个实例,嵌进别人的页面,Shadow DOM 隔离,都靠这一条.
  做了它之后 900 行手写 DOM 桩可以继续用(它本来就是"控制器不变量"的好工具).
- **验收**:库源码里不存在裸的 `document.` / `window.`(除类型引用与 root 的
  默认取参).

### D8 CSS 去 id 化并分家

- **现象**:`css/` 7 个文件 1,972 行里,**17 个 id 选择器,共 49 处**
  (`#dsl-editor-highlight-code` 8,`#view-controls` 6,`#params-panel` 6,
  `#dsl-editor` 5,`#dock` 5,`#window-layer` 3,`#snap-preview` 3,
  `#viewport` 2,`#dsl-editor-highlight` 2,`#diagnostics` 2,其余各 1).
- **处理**:库的样式只允许类名(或 `:scope` 前缀),否则**消费者的 id 变成了库
  的公开 API**,同页两个实例必然串味.分家:

  | 文件 | 去向 |
  | --- | --- |
  | `base.css`(token 部分) | 库 `styles/tokens.css` |
  | `controls.css` | 库 `styles/widgets.css` |
  | `window.css` | 库 `styles/desktop.css` |
  | `editor.css` | 库 `styles/editor.css`(词法配色部分留 app) |
  | `panels.css` `process.css` `diagnostics.css` | 留 app |

- **验收**:`packages/miko_ui/styles` 里 grep 不到 `#`(排除十六进制颜色).

### D9 应用内容从 UI 目录里搬出去

- `src/ui/examples/` 是示例 `.miko` 目录与加载器 -- 应用数据.
- `src/ui/desktop/windowChrome.ts` 建的是"示例"按钮,RUN 按钮,示例浮层,
  公式复制提示(`example-btn` / `run-btn` / `example-menu` / `formula-copy-hint`)
  -- 这四件是**应用内容**,只是位置归窗口外壳.库只该提供"往标题栏槽位放节点"
  的能力(D1 的 `adopted`),节点由 app 建.
- `src/ui/process/ProcessPanel.ts` 里混了公式排版 -- 排版件进库,步骤内容由
  app 提供.

### D10 库自己的测试基线

- 现状:23 个 UI 测试 import `src/testing/domStub.ts`(900 行手写桩).
  `src/ui/widgets/widgets.test.ts`(445 行)已经是"结构 + 交互 + dispose"的
  模板形状,直接当库的测试规范.
- 库每个组件至少三条:①结构断言;②交互断言;③`dispose()` 后无残留监听.
- 库自己的测试桩随库走(可以先从 `domStub.ts` 精简一份),不再跨包引用
  `@/testing/*`.

---

## 六/抽库后的文件组织

### 6.1 库

```text
packages/miko_ui/
  src/
    dom/          el, fragment, root 上下文, keyedList, appendInOrder
                  ← 今天的 src/ui/widgets/dom.ts + src/ui/shared/keyedRowList.ts
    reactive/     signal, effect, computed, bind, onCleanup        ← 路线 B 新增
    widgets/      Button Switch Segmented Slider NumberField Popover   ← 今天已有,6 件
                  TextField Menu Dialog Tooltip Toast                  ← 需要新建,见附录 B.2
    layout/       Row Section Field Toolbar Splitter ScrollArea
                  ← widgets/Row.ts 扩成布局层;Splitter 是被窗口化删掉的
                    RightSplitController 的回归(见附录 B.2)
    formula/      FormulaView(KaTeX 作为可选 peer 依赖)
    feedback/     MessageList ← 今天的 diagnostics/DiagnosticsController
                  (零 import,是 src/ui 里最干净的一个件)
    desktop/      WindowFrame WindowManager WindowGeometry WindowResize Dock SnapPreview
    editor/       CodeEditor(tokenize 注入) LineNumbers Highlight
    theme/        tokens.ts, applyTheme(root, tokens)
    index.ts      公共 API 唯一出口(内部路径不进 exports map)
  styles/
    tokens.css    ← css/base.css 的 token 部分
    widgets.css   ← css/controls.css
    desktop.css   ← css/window.css
    editor.css    ← css/editor.css
  test/           组件测试(结构 + 交互 + dispose)
  package.json    exports: { ".": ..., "./styles.css": ... };
                  运行时依赖恰好一个:@preact/signals-core(U7);
                  KaTeX 是可选 peer(只有用公式件时才需要装)
  tsconfig.json   vite.config.ts(库模式构建)
```

### 6.2 应用侧

```text
src/
  app/          DslApp, CompileController, RenderController, SceneStore   ← 装配 + 领域流程
  views/        entity evaluation objects params process view examples
                ← 今天 src/ui/ 里的领域视图;仍用库声明式写,但 props 由 app 定
  adapters/     sceneToFields.ts, evaluationToSteps.ts, paramToSlider.ts
                ← SceneIR -> 库 props(D2),LaTeX 行 -> 步骤(props)(D3)
  contract/     ast, ir, events, view, evaluation(类型从 evaluationLatex.ts 提出)
  config/       uiConfig(只剩应用部分), renderConfig, numericConfig
  core/         EventBus, LatestRequestExecutor
  main.ts       缩到 applyTheme() + mountDesktop() + 领域接线
  index.html    缩到 <div id="app"> 与样式入口
```

### 6.3 边界定义(写成文档,也写成断言)

| 库提供 | 应用提供 |
| --- | --- |
| DOM 原语与响应式原语 | 领域数据与状态源 |
| 控件,布局,窗口系统,主题 | 窗口清单,标题,内容节点,初值 |
| 编辑器(分词器由外部注入) | DSL 分词器与词法配色 |
| 交互与无障碍语义 | 业务动作(显隐 = 不渲染 + 不参与计算...) |

**只要库开始出现"哪些窗口,标题叫什么,控件什么顺序"这类知识,它就不再是库,
而是这个应用的 DSL 换了个目录.**

---

## 七/单独维护的形态与构建

### 7.1 先 workspace,后拆 repo

| 方案 | 什么时候用 | 代价 |
| --- | --- | --- |
| **本仓库 npm workspaces + `packages/miko_ui`(推荐起步)** | 重构期每天要同时改两边 | 无;与 `Cargo.toml` 里已有的 workspace 组织对称 |
| 独立 repo + GitHub Packages / git tag 依赖 | API 稳定,或出现第二个消费者 | 每次改库要发版才能联调;需要双仓 CI |

### 7.2 构建与路径别名

- 库用自己的 `vite.config.ts` 出 ESM + 类型(`vite build --mode lib`),
  或直接 `tsc` 出声明 + 原样发源码(`exports` 指向 `src/index.ts`)由应用侧
  Vite 编译.后者更简单,适合"只有一个消费者"的阶段.
- **注意现有别名约束**:`tsconfig.json` 的 `paths: { "@/*": ["./src/*"] }`
  (TS 7 无 `baseUrl`,必须写 `./src/*`)与 `vite.config.ts` 的 `SRC_ALIAS` 是
  同一约定的两半,注释里明确"改一处必须同步另一处".库包内**不要**再用 `@/`,
  用包内相对路径或自己的别名 `#ui/*`,这样库搬出去时不用改一行 import.
- `css/` 现在是 `index.html` 里 7 个 `<link>` 直接引的.库改成
  `import '@miko/ui/styles.css'`(或 `styles/tokens.css` + 分组入口),由构建
  工具处理;不要在库里用 CSS-in-JS 或插件注入,那与既有取舍冲突.

### 7.3 CI

`.github/workflows/deploy.yml` 现在是单 job.加库之后拆成:

```text
job: ui        cd packages/miko_ui && npm ci && typecheck && test && lint(样式 id 断言)
job: app       npm run typecheck && npm test && npm run build:app   (needs: ui)
job: rust      cargo fmt/clippy/test                                (现状不变)
```

---

## 八/分期

每期独立可提交,可回退.括号里是该期完成的去耦合项.

### P0 建包边界(半天~1 天,零运行时)

- 建 `packages/miko_ui/` 与 npm workspaces,把 `widgets/` `shared/`
  `desktop/` `theme/` `formula/` 移动过去(纯移动 + 改 import 路径).
- 加"依赖方向断言"的 lint 脚本(§9).
- **不引运行时,不改任何行为.**
- 验收:`npm test` 全绿;应用行为一字未变.

### P1 反转与注入(D1 / D4 / D7)

- 库自己建窗口层与 Dock;`index.html` 缩到 `#app`.
- 配置改为构造参数;新增库自己的 `defaultConfig` 与最小示例页
  (`packages/miko_ui/example/`,只用一个空容器就能起).
- root 注入落地.
- 验收:**库能被一个外部最小 demo 消费**(这一段做完,分离才有意义).

### P2 领域类型出库(D2 / D3 / D5 / D6 / D9)

- 新增 `src/adapters/`,把 `SceneIR` / 参数声明 / 求值细节 / LaTeX 行 -> props.
- `EvaluationDetailLine` 提到 `src/contract/evaluation.ts`.
- 视图目录改名 `src/views/`.
- 验收:§9 断言三条全过(此时 L3 还没做,库仍是"结构声明式").

### P3 引入信号,把面板改成 spec 驱动(U3 = B,U7 = vendored,均已定)

- 新增 `reactive/`:一层**薄封装 + 再导出**(不是重写),把 `@preact/signals-core`
  的 `signal` / `computed` / `effect` 包成库自己的 API,并守住 §4.1 末的三条约束
  (公开面是库自己的,不用 `batch()`,不当状态管理库用).
- 控件值参数先扩成 `T | Signal<T>`(传普通值维持今天行为),于是可以一个控件
  一个控件地转,不必一次性推翻 `ViewPanel`.
- 把 `ViewPanel` / `ParamPanelController` / `ObjectListController` 改成
  spec + signal.
- 视图控件控制器里"读值再转发"的部分退化成 props 回调,`EventBus` 在视图控件
  这条链路上可以减少一层.
- 保留 `DslApp._scheduleRefresh` 的 rAF 合并:它合的是**编译**,不是 DOM 更新.
- 验收:`DslApp` 构造函数显著变短;拖动参数不再需要手工 `set()` 同步两处;
  `reactive/` 的封装有测试(至少覆盖"同值不通知"与 effect 的卸载,以及"库里
  没有出现 `batch()`"这条断言).

### P4 收尾与拆仓(D8 / D10 + 文档)

- CSS 分家与去 id;库的组件测试基线补齐;库自己的 README 与 API 文档;
  评估是否拆独立 repo.

---

## 九/验收线:三条机械断言

这就是"通用 UI 库"的**操作性定义**(建议直接写成 CI 里的 grep 断言):

1. `packages/miko_ui/src` 里 grep 不到
   `@/contract`,`@/compiler`,`@/math`,`@/render`,`@/config/renderConfig`;
2. 库源码里 grep 不到 `getElementById`,也没有裸的 `document.` / `window.`
   (root 注入后);
3. `packages/miko_ui/styles` 里 grep 不到 `#`(排除十六进制颜色).

三条同时成立,库就是真的独立了;哪条破了,就是刚漏进来的耦合.

补充一条形态断言:库的 `index.ts` 之外的文件都不该出现在 `package.json` 的
`exports` 里 -- 否则内部路径变成公开 API,以后不敢重构.

---

## 十/风险登记与明确不做的事

| # | 风险 | 触发条件 | 对策 |
| --- | --- | --- | --- |
| R1 | **过度分层**:库做了一层 props,app 又做一层 adapter,改动要跨三处 | 视图模型设计得比领域模型还复杂 | 视图模型只描述"渲染需要什么"(标题/值/动作/子项),不镜像 IR 结构 |
| R2 | 信号层与 DOM 桩的交互不一致 | signals-core 的 effect 一旦被 `batch()` 包住就不再同步,桩里没有微任务队列 | 硬约束:**effect 同步执行**,不引调度器;库里**一次都不用 `batch()`**,库的更新路径也不许依赖 rAF(见 §4.1 末第 2 条) |
| R3 | Lua/文档漂移:两个 repo 后文档分家 | 拆 repo 太早 | P0–P3 全在单仓;拆仓放到 P4 之后 |
| R4 | 别名双份(`tsconfig` + `vite`)在库包里再增殖 | 库用 `@/` | 库内禁用 `@/`,用包内相对/自有别名 |
| R5 | P1 做完后应用行为被"顺手重构"带偏 | 把 D1/D4/D7 与功能改动混在一个提交 | 每期只做该期的项;P0/P1 的提交里不出现行为差异 |
| R6 | 库的 CSS 分家导致应用视觉回归 | id 选择器改类名时漏掉一处 | 分家时按 §D8 表逐文件搬,搬完在真机过一遍(桩不解析样式表,`windowing-plan.md` §8.1 已说明) |

**明确不做的事**:

- 不把"哪些窗口,标题,内容顺序"放进库(那就变成应用的 DSL).
- 不在库的更新路径上引入异步调度(rAF/微任务)来"优化"渲染.
- 不为抽库而改写 `WindowManager` / `WindowGeometry` 的算法 -- 它们是库的资产,
  只搬不重写.
- 不为了"更通用"而把领域枚举(`CamMode` / `ViewHome` / `UpAxis` / `GridPlane` /
  `PointMode`)塞进库:它们是渲染值域,库只提供泛型的 `Segmented<T>` /
  `Switch`,映射留在 app.

---

## 附:与其它文档的关系

- `docs/windowing-plan.md` 是本计划的前置:窗口系统已经按"全程声明式(硬约束)"
  落地,§5.3/§5.4 的 DOM 契约与 §11.1 的三条指针穿透约束在搬库后仍然有效.
  **另见附录 C3**:§5.6 的源码高亮层对齐契约与 §8.1 的"哪些只能真机验"两条
  也要一并搬进库.
- `docs/render-ui-migration-plan.md` 里的桌面端(egui)路线与本计划**正交**:
  那一份把 UI 换成 egui,本计划把 Web 侧 UI 抽成可维护的库.两者都要保留的
  是"数学核心单源"这条口径 -- 本计划里 D3(LaTeX 生成移出 UI)正是朝这个
  方向走的一步.

---

## 附录 A:复现本文所有数字的命令

正文里每个数字都是跑出来的,不是估的.复核或改动之后重跑这五条即可.

```bash
# A.1 UI -> 外部/领域的 import 计数(§2.1 的两张表)
grep -rhoE "from '@/[^']+'" src/ui --include='*.ts' \
  | sed "s/from '//;s/'//" | sort | uniq -c | sort -rn
grep -rhoE "from '[a-z@][^'./][^']*'" src/ui --include='*.ts' | sort | uniq -c | sort -rn

# A.2 按目录的耦合矩阵(§2.1 的判定表)
for d in $(find src/ui -type d | sort); do
  echo "[$d]"
  grep -rhoE "from '@/(contract|compiler|math|render|compute|core|config|app)/[^']+'" \
    "$d" --include='*.ts' | sed "s/from '//;s/'//" | sort -u
done

# A.3 反向依赖:应当只有 4 个文件(§2.1)
grep -rn "from '@/ui/" src --include='*.ts' | grep -v '^src/ui/'

# A.4 CSS 的 id 选择器:应当得 17 个 id / 49 处(D8)
grep -rhoE "#[a-z][a-z0-9-]*" css/*.css | sort | uniq -c | sort -rn
#   ↑ 输出里混着十六进制颜色,需人工剔除(如 #ffd93d,#c678dd)

# A.5 库的三条验收断言:应当全部为空输出(§9)
grep -rnE "@/(contract|compiler|math|render)/|@/config/renderConfig" packages/miko_ui/src
grep -rnE "\b(getElementById|document\.|window\.)" packages/miko_ui/src
grep -rn "#[a-z][a-z0-9-]*" packages/miko_ui/styles
#   ↑ 第二条的例外只有两种,人工确认即可:类型位置(`Document` 首字母大写,不匹配)
#     与 root 的默认参数(`root = document`,没有点,也不匹配).
```

配套的两个"分组行数"取法(§2.2):

```bash
for g in "widgets shared" "desktop theme" "editor" "formula" "diagnostics"; do
  t=0; for d in $g; do t=$((t+$(find src/ui/$d -name '*.ts' | xargs cat | wc -l))); done
  echo "$g = $t"
done
find src/ui/entity src/ui/evaluation src/ui/objects src/ui/params \
     src/ui/process src/ui/view src/ui/examples -name '*.ts' | xargs cat | wc -l
```

---

## 附录 B:正文没写完的两类事实

### B.1 库已经有的五条约定(与 §2.3 的三条地基同级,搬的时候不要丢)

1. **生命周期:一件一个 `AbortController`.** `widgets/` 六件全是这个形状 --
   `element.addEventListener(..., { signal: abort.signal })` +
   一个 `Set<listener>` 订阅集 + `dispose()` 同时 abort 与 clear
   (`Popover` 因为有三处监听用了三个).库的规范照这个写,**不要**混入
   `addEventListener` / `removeEventListener` 手工配对,那正是"漏一处就泄漏
   一个监听"的来源.
2. **键盘只有一个出口.** `src/ui/shared/KeyboardController.ts` 的
   `register({ keys, resolve })`,`resolve()` 返回闭包表示"这一层处理了",
   返回 `null` 表示"放行给下一层";优先级靠**注册顺序**表达
   (见 `DslApp.start()`:示例菜单的 Esc 就是一条 `resolve()` 返回闭包的绑定,
   没有浮层打开时返回 `null` 放行).
   **这条必须在库里保住** -- 否则每个组件各自绑 `keydown`,冲突只能靠
   `stopPropagation` 猜.
3. **浮层的"点外部关闭"挂在根节点上,不挂在浮层自己.**
   `DslApp.start()` 里 `formulaCopyController.bind(appRoot)` /
   `exampleLoader.bind(appRoot)`.这条与 D7 的 root 注入是同一件事,做 D7 时
   一并搬,不要退化成"每个浮层自己监听 body".
4. **id 只服务"标签关联",不当全局注册表.**
   `src/ui/widgets/dom.ts` 的 `nextWidgetId(kind)` 产出的 id 只给
   `<label for>` / `aria-labelledby` 配对;外部一律拿句柄,不按 id 查.
   这条是"库的公开 API 里没有字符串 id"的保证,也是 §9 第二条断言的地基.

5. **指针拖拽只有一份实现.**
   `src/ui/shared/dragGesture.ts` 是全应用唯一的拖动实现,两个消费者分别是
   `desktop/WindowManager`(标题栏移动窗口)与 `desktop/WindowResize`(八向缩放).
   两个刻意的设计点值得原样保留:**增量而非"起点 + 总位移"**(被上下限夹住之后,
   指针回退一小段就能立刻重新跟手,不会出现死区),以及**模块不认识"宽/高/比例"**
   (像素位移怎么解释由 `onDelta` 决定).再加上 `canStart(event)` 这个钩子,
   "双击标题栏"与"最小化时不可拖"都不必在 `onDelta` 里反复判断.
   这是库将来给 `Splitter` / `Slider` / 拖放排序复用的那一层.

### B.2 "导入库就能声明式编排"落地时立刻会撞到的缺口

今天库的控件词汇只有 **6 件**(`Button` / `Switch` / `Segmented` / `Slider` /
`NumberField` / `Popover`)加 5 个行级布局助手(`createControlGroup` /
`createRow` / `createFieldLabel` / `createSwitchRow` / `createNumberRow` /
`createInlineToggle`),**不足以覆盖今天页面上已有的东西**:

| 缺的件 | 今天它在哪 | 撞上它的场景 |
| --- | --- | --- |
| `TextField` | 没有;源码编辑器是 `textarea` 特例 | 任何"输入一个名字/表达式"的需求都退回裸 DOM |
| `Menu` | `src/ui/examples/ExampleLoaderController.ts:131-162` 手搓 `el('div')` + `el('button')` | 菜单是 Popover 最常见的面板内容;不抽就得每处重写,还要重写一份方向键导航 |
| `Splitter` | 被窗口化删掉的 `RightSplitController` | 窗口**内部**要分栏时会想要它(窗口之间的分割已由窗口系统解决) |
| `ScrollArea` | 各处直接写 `overflow-y: auto` | 滚动条样式与键盘滚动行为会重新散进 app |
| `Table` / 公开的列表件 | `src/ui/shared/keyedRowList.ts` 引擎很好,但没公开成件 | 行缓存/复用/排序逻辑会被 app 再写一遍 |
| `Dialog` / `Toast` | 没有 | 需要模态或瞬时提示时从零做(今天警告是常驻的 `#diagnostics` 面板) |
| `Tooltip` | 靠原生 `title` 属性 | 样式与可访问性不可控 |

这不是"抽库的缺陷",是抽库会**暴露**的欠账:今天页面的控件密度低,靠 `el()`
直接拼够用;一旦对外宣称"声明式编排",编排者立刻会问"表格呢,菜单呢,分栏呢".
所以补件建议放进 **P4**,不必挡在 P0–P2 前面(详见 §8).

---

## 附录 C:搬库时最容易丢 / 最容易踩的六件事

| # | 事 | 现状 | 搬库时的要求 |
| --- | --- | --- | --- |
| C1 | **装载顺序有硬约束** | `src/main.ts` 必须在 `new DslApp()` **之前**调 `applyUiConfig()`,因为 `EditorLineNumbers` 构造时按最终字体度量行号槽宽;晚一步就量到兜底字体 | 库必须提供"主题先于组件实例化"的显式顺序(或让组件自己延后测量).这条只写在 `src/main.ts` 的注释里,`main.ts` 一被重写就容易丢 |
| C2 | **9 个 CSS 变量有两份值** | `css/base.css:190-210` 是 `--code-font-family` / `--code-font-size` / `--code-line-height` / `--code-tab-size` / `--code-gutter-width` / `--params-panel-min-height` / `--view-controls-min-height` / `--window-header-height` / `--dock-reserve` 的**兜底副本**,真相源在 `src/config/uiConfig.ts`,由 `applyUiConfig()` 覆盖 | 库同时拥有 CSS 与默认 token 之后,这份兜底副本应收成一处(库的 `tokens.css` 就是默认值,JS 只在需要**覆盖**时才写 `:root`).**不要把两份值一起搬进库**,否则库内部又出现一次"改一处漏一处" |
| C3 | **高亮层对齐契约只能真机验** | `docs/windowing-plan.md` §5.6:源码高亮层是"透明 textarea + 背后一层",列了 5 条对齐轴,错一像素就表现为"编辑不了";§8.1 说明 DOM 桩不解析样式表,不做布局 | 搬 `editor/` 时把 §5.6 与 §8.1 一并搬进库内注释与库的 CONTRIBUTING;凡改 `editor.css` 或 `EditorHighlight` 的提交都要真机过一遍 |
| C4 | **测试归属要跟着代码走** | UI 现有 34 个测试文件:库侧 19(`desktop` 7 / `editor` 5 / `formula` 2 / `shared` 2 / `theme` 2 / `widgets` 1),应用侧 15(其余) | P0 移动时测试跟着目录走;**不要**为了"一次搬干净"把 `views/` 的测试也搬进包 -- 应用视图的测试留在 `src/views/` |
| C5 | **库的 CI 不需要 wasm,这正是分离的收益** | 实测 `src/ui/**/*.test.ts` 里**没有任何** `@/generated` 或 `setupWasm` 引用;但今天 `npm test` 绑在 `build:all` 里(`lint:rs` -> `clean`(会删 `src/generated`)-> `build:wasm` -> `test` -> `build:app`) | 库 job 只跑 `typecheck + test`,不装 wasm 工具链,不跑 `clean`.库的 CI 能不能独立跑绿,是"UI 与计算真的解耦了"最直接的证据 |
| C6 | **`index.html` 里有 4 个 id 只服务 JS 宿主,可直接删** | `#left-panel` `#bottom-panel` `#right-page-params` `#right-page-process` 出现在 HTML 里,但 `css/` 那 17 个 id 选择器里**没有**它们(即它们没有任何样式作用) | D1 做完后这 4 个 id 连同标签一起消失;D8 分家 CSS 时不要为它们补类名 |

---

## 附录 D:规模参考(以"动过的文件数"计,不是天数)

| 期 | 动的文件(实测基数) |
| --- | --- |
| P0 | 移动 37 个 `.ts`(`widgets` 9 / `shared` 7 / `desktop` 14 / `theme` 3 / `formula` 4)+ 改 import 路径;新增 workspace 与断言脚本 |
| P1 | 应用侧 `index.html`,`src/app/appHosts.ts`(最终删掉),`src/main.ts` 三个文件重写;库新增 `mountDesktop`,`defaultConfig`,`example/` |
| P2 | 应用侧 46 个 `.ts` 从 `src/ui/` 移到 `src/views/`(含测试;`diagnostics/` 那 2 个按 §2.2 进库),新增 `src/adapters/`;库侧要改 5 类消费点,共 44 处(`uiConfig` 25 / `renderConfig` 7 / `evaluationLatex` 10 / `paramValue` 1 / `keywords` 1) |
| P3 | 库新增 `reactive/`(薄封装 + 再导出,不是重写;见 §4.1 的三条约束);改 `ViewPanel` / `ParamPanelController` / `ObjectListController` 三处装配方式与 `DslApp` 构造函数 |
| P4 | `css/` 7 个文件分家(17 个 id 选择器 / 49 处);补 §B.2 的 7 类件;库的 README 与示例页 |

> `src/ui` 下共 94 个 `.ts`(含测试):37 进库(P0)+2 进库(`diagnostics`)+
> 46 留 app(P2)+9(`editor`,P2 的 D6 之后再进库)= 94.

> 天数刻意不写:这个仓库的既有文档(`windowing-plan.md` 的分期,`teaching-roadmap.md`
> 的任务表)都在"工作量"一栏留了估计,但那些是作者自己拍的.这里只给可核对的
> 文件基数,避免把一个没做过的重构估出一个看起来精确的数字.

---

## 附录 E:运行时依赖足迹(今天 -> 分离后)

答"现在还有哪些运行时依赖".数字全部实测于 2026-09-22 的工作区
(`package.json` / `package-lock.json` / `dist/`),重量口径统一用字节.

### E.1 今天

| 项 | 内容 |
| --- | --- |
| npm 运行时依赖(直接) | `katex ^0.18.5`,`three ^0.185.1` -- **2 个** |
| npm 运行时依赖(传递,非 dev) | `commander ^15.0.0`(katex 的依赖,只服务它的 CLI).lock 里的非 dev 条目共 **3 条** |
| npm 开发依赖(直接) | 7 个:`@types/katex` `@types/node` `@types/three` `typescript` `vite` `vite-plugin-pwa` `vitest`;lock 里其余 **449 条**全是 dev |
| **真正进浏览器产物的 npm 包** | 只有 `three` 与 `katex` -- 实测 `dist/assets/` 里 grep 不到 `commander`(katex 的 ESM 入口是 `dist/katex.mjs`,不引它) |
| 非 npm 的运行时输入 | 三个 Rust/WASM 模块:`render_rs` 694,950 B + `math_rs` 673,861 B + `compiler_rs` 247,826 B = **1,616,637 B(约 1.54 MB)**,由 `wasm-pack` 在构建期产出到 `src/generated/` |
| 构建期工具链(不是运行时) | `cargo` / `rustup` / `wasm-pack`;`vite` / `vite-plugin-pwa`(产出 `dist/sw.js`);`typescript` |
| 浏览器产物现状 | `index-*.js` 1,182,228 B + `index-*.css` 56,205 B + 上述 1.54 MB wasm + KaTeX 字体(`dist/` 合计 5.2 MB) |

### E.2 分离后

| 包 | 运行时依赖 | 说明 |
| --- | --- | --- |
| `packages/miko_ui` | `@preact/signals-core` -- **1 个必需**;`katex` 为**可选 peer** | MIT,`dependencies` 字段不存在(零依赖),`sideEffects: false`(可摇树),min 5,696 B / gzip 2,024 B |
| 应用 | `three`,`@miko/ui`,`katex`(用到公式件时) | katex 从"应用直接依赖"变成"库的 peer",应用仍要显式装它 |

净变化:**运行时依赖 +1 个包**(`@preact/signals-core`),位置有挪动,**没有新增
构建期工具链**.这正是 U7 选 vendored 而不是"引个框架"的意义 -- 库的依赖足迹从
2 变 3,不是从 2 变 30.

另外两条与依赖有关的既有事实,别再踩:

- **库里不该出现 `three`**.实测今天 `src/ui` 里没有任何 `@/render/*`,也没有
  `three` 的 import;抽库后这条要继续成立(§9 第 1 条断言).
- **库的 CI 不需要 wasm**(附录 C5).UI 测试零 `@/generated` 引用,所以库的
  job 只装一个 npm 依赖就能跑绿;WASM 那 1.54 MB 与 Rust 工具链留在应用侧.

### E.3 一条可写进 CI 的守卫

`packages/miko_ui/package.json` 的 `dependencies` 只允许 `@preact/signals-core`
一项(外加 `peerDependencies` 里的 `katex`).多出一项就是需要评审的事件 --
这比"靠人记得不要乱加依赖"可靠,也和 §9 的三条断言同一个性质:把口径写成机器
能查的东西.
