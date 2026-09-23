# 面板窗口化设计计划

本文回答:**现在三个贴边固定面板的布局,怎么变成"桌面 + 浮动窗口 + Dock"?**

状态:**已落地(阶段 0–4)**.本文件仍是设计与口径的唯一真相源;实现见
`src/ui/desktop/`(`WindowGeometry` / `WindowFrame` / `WindowResize` /
`WindowManager` / `Dock` / `SnapPreview`)与 `css/window.css`.落地过程中发现
的偏差与补充记在 §11.2(表后的"实现记录").阶段 4 的收尾项(文档同步,残留
清理)也在本稿内完成;阶段 5(键盘窗口管理)仍然暂缓.

§9 的验收清单已经在**真实浏览器**上跑过一遍(见 §13 的验收记录):headless
Chromium + DevTools Protocol,1280×800 与 1920×1080 两组视口,用真实鼠标/键盘
事件覆盖拖动,八向缩放,最小化/恢复,Dock,最大化/全屏/`Esc`,边缘吸附与预览,
示例菜单完整展开,"点过程即抬窗口",空桌面穿透与视口 resize,34 项断言全过;
这一轮查出并修掉了 §11.2 的 E29/E30 两条.

> **后续修订:Dock 移到顶部,并删掉"关闭"与"全屏"**(窗口系统抽成
> `@miko/ui`(独立仓库 miko_ui)之后由用户拍板,与下文原始设计不同,以本条为准):
>
> 1. **Dock 是顶部通栏任务栏**,不是底部浮岛.它紧贴桌面上沿,左右与桌面同宽,
>    只有下沿一条分隔线;`dockReserve` 就是栏高(默认 40px),同时是窗口**工作区
>    的上沿**--窗口的 `y` 从它下沿量起,夹取,最大化与边缘吸附都不越过它.最大化
>    铺的是"任务栏之下的工作区",所以任务栏不会被遮.
> 2. **删掉"关闭"与"全屏"两个动作及其状态**.没有真正的进程可关,关闭与最小化在
>    观感上就是同一件事;全屏与最大化的差别也只剩"遮不遮任务栏",而任务栏不该被
>    遮.于是 `WindowState` 从
>    `normal | maximized | fullscreen | minimized | closed` 收成
>    `normal | maximized | minimized`,`WindowActionId` 收成
>    `minimize | maximize`,Dock 的动作区只剩"全部还原",`Esc` 退出全屏那条键盘
>    绑定与 `.is-fullscreen` 系列规则一并删除.
> 3. 两个"CSS 必须自己读"的外壳尺寸(`--dock-reserve` / `--window-header-height`)
>    改由库在挂载时从 `DesktopConfig` 写到桌面根,`styles/tokens.css` 里的同名值
>    只留作"没有 JS / 纯 CSS"的兜底.
>
> 下文 §3–§5 里关于底部 Dock,`fullscreen`,`closed`,`.dock-inner` 的文字与代码
> 清单是**当时的原始设计**,不再作为实现依据;逐条记录见 §11.2 的 E37.

已拍板的口径(用户 2026-09 指定):

| # | 决定 | 内容 |
| --- | --- | --- |
| W1 | 形态 | **浮动窗口 + 3D 铺满背景**.Three.js 视口仍是铺满 `#app` 的一层,现有面板与右栏两页变成悬在它上面的浮窗(**共五个窗口**) |
| W2 | 窗口外壳功能(一期) | 焦点/z-order 提升,关闭与最小化,**Dock/任务栏**,边缘吸附与磁吸对齐,最大化/单窗口全屏(**后续修订:关闭与全屏已删除,Dock 改成顶部通栏任务栏--见上面的修订块与 §11.2 E37**) |
| W3 | 键盘窗口管理 | **暂缓**,列入本文件的设计与阶段 5,一期不实现 |
| W4 | 布局持久化 | **不做**.README 已明确"界面偏好不落 localStorage";本方案不推翻该约定 |
| W5 | 启用方式 | 替换现有固定布局,不做新旧两套布局的运行时开关 |
| W6 | 窗口数量与标题 | **五个窗口**:`source code`(源码) / `参数` / `视图` / `过程` / `对象`.窗口标题栏直接沿用现有面板标题文案,面板自带的那层 `.panel-header` 删除(B8 的 A 案);`参数` 与 `视图` 之间的分隔条(`RightSplitController`)随之删除 |

参考物:`/mnt/IVSTINIANVS/__projects_web/xxx_VaporwaveDP/`(用户指定的方向).
该项目的窗口观感可用,但实现不严谨,本文**只借观感与交互骨架,不借其实现**;
下面 §3.8 逐条列出它的问题与我们的不同做法.

**怎么读这份文档**(实现者按这个顺序走即可,不必通读):

| 要干什么 | 读哪几节 |
| --- | --- |
| 先摸清现状与要替换的耦合点 | §1 |
| 知道最终长什么样,五个窗口的几何 | §2 -> §3 |
| **动手写**:类型,函数签名,算法,写入点 | §4(照抄即可) |
| 文件放哪,改哪些文件,DOM 契约,样式契约 | §5 |
| **动编辑器之前必读**(高亮层对齐) | §5.6 |
| 交互细节与边界(指针,焦点,隐藏,无障碍) | §6 |
| 按阶段推进 + 每阶段验收 | §7 |
| 测试写什么,什么只能真机 | §8(含 §8.1 测试策略) |
| 真机回归清单 | §9 |
| **动手前先看**:硬性阻碍 B1–B9,方案已订正的错误 E1–E18,查过但不是阻碍的 | §11 |
| 风险登记 | §12 |

> **本稿是修订版**.2026-09 的第二轮核对逐条对着代码查过一遍,补上了硬性阻碍
> (B8/B9 新增,B1 降级并订正)与方案自身写错的地方(E8–E18),其中 E8/E9/E13
> 三条属于"照抄 §4 就会出 bug":几何写入清掉 `z-index`,最大化不清行内几何,
> 默认几何三处底边线不一致.改动都标了编号,便于逐条核对.现在的总数是
> **B1–B10 十条阻碍 + E1–E20 二十条订正**.
>
> 第三轮按用户新拍板的 **W6(五个窗口)** 改了窗口数量与默认几何:参数与视图
> 拆成两个窗口,`RightSplitController` 及其整条链路(`#right-splitter`,
> `--right-split-basis`,`UI_CONFIG.panel.split*`)进删除清单,`source code`
> 不再是通高窗口.连带订正记在 §11.2 E19/E20.

一句话总结形态:`#viewport`(three.js)继续铺满当背景,**五个**浮动窗口
(`source code` / `参数` / `视图` / `过程` / `对象`)悬在它上面,顶部一条紧贴
上沿的通栏任务栏(见文首的后续修订块);窗口可拖可缩放,可最小化/最大化
(**关闭与全屏已删除**);固定布局的 `PanelController`,右栏标签页
`RightPanelTabs` 与"参数区/视图区"分隔条 `RightSplitController` 一并删除,
面板本体(编辑器/参数行/视图控件/过程视图/对象列表)与其全部控制器不动.

---

## 1 现状与要动的东西

### 1.1 现状结构

`index.html` 的 `#app` 下是三个绝对定位面板 + 一个铺满视口的 3D 层:

| 元素 | 位置 | 尺寸来源 | 内容 |
| --- | --- | --- | --- |
| `#viewport` | `inset: 0`,z-index 0 | 铺满 `#app` | three.js canvas(`SceneManager` 构造时 `container.appendChild`) |
| `#left-panel` | 贴左通高 | `--left-panel-width` | 源码编辑器(textarea + 行号槽 + 高亮层)+ 示例浮层 |
| `#right-panel` | 贴右通高 | `--right-panel-width` | 标签页:参数/视图(带 `#right-splitter` 上下分割,**`#params-panel` + `#diagnostics` 与 `#view-controls` 共用这一栏的高度**)与过程 |
| `#bottom-panel` | 底部横条 | `--footer-height` | 对象列表(实体/求值两栏) |

尺寸与折叠的唯一写入点是 `PanelController._applyLayout()`(写 `#app` 上的三个
CSS 变量);右栏内部"参数区 / 视图区"的比例由 `RightSplitController` 写成
`--right-split-basis`;**右栏标签页**由 `RightPanelTabs` 管 `hidden`;三根
`[data-resize-panel]` 分隔条与 `[data-panel-toggle]` 折叠按钮是标记与控制器
之间的连接点.全部拖动走全应用唯一一份 `src/ui/shared/dragGesture.ts`.

注意右栏这一格经历了**两次共用**:`#right-page-params` 与
`#right-page-process` 是同一根侧栏的两个标签页(共用一份宽度,一次只能看一页);
而 `#right-page-params` 内部又是**参数区与视图区共用一份高度**,比例由
`#right-splitter`(`data-split-page="right-page-params"`)上下拖动决定.
窗口化把这两层"共用"都拆开:三页各自独立成窗口(§2.1),这是本次唯一一处
**结构净增**(三个面板变**五个**窗口),也是 `RightPanelTabs` 与
`RightSplitController` 被删除的原因.

### 1.2 窗口化要替换的耦合点(逐条可查)

| # | 现有耦合 | 位置 | 窗口化后 |
| --- | --- | --- | --- |
| C1 | 三个面板的几何是 CSS 绝对定位 + 三个变量 | `css/layout.css` 全文 | 换成窗口几何(px 的 x/y/w/h),由 `WindowManager` 写行内样式 |
| C2 | 折叠 = 收成窄边 + 隐藏正文直接子元素 | `PanelController._applyLayout` | **删除**.最小化/关闭由窗口态表达,不再是"面板折叠";`_collectBindings` / `_bindToggleButtons` 随 `[data-panel-toggle]` 一起消失 |
| C3 | 拖动宽度/高度 | `PanelController._bindResizeHandles` | 换成窗口拖动与八向缩放(仍走 `bindDragGesture`) |
| C4 | `.panel.collapsed ...` 一整组 CSS | `css/panels.css` 57–66,830 | 换成 `.window.is-minimized` 等窗口态选择器 |
| C5 | 面板标题栏 `.panel-header`(含"示例/RUN/收起"按钮) | `index.html` + `css/panels.css` 14–67 | 变成**窗口标题栏**:拖动区 + 窗口按钮;"示例/RUN"移入窗口标题栏(`.window-actions`),`#formula-copy-hint` 移入对象窗口标题的 `slots.title`(旧名 `titleContent`).面板自带的那层 `.panel-header` **整个删除**(W6 的 A 案,§11.1 B8) |
| C6 | 右栏标签栏留在面板 header 内部(为折叠逻辑) | `index.html` 244 注释,`RightPanelTabs` | **整个删除**.参数页与过程页各自独立成窗口,`RightPanelTabs` 与 `#right-tabs` 一并消失;`.right-page[hidden]` 那条 `display:none` 也没了存在理由 |
| C7 | 面板通高 / 通宽靠绝对定位的 `top/bottom/left` | `css/layout.css` 32–55 | 窗口正文给确定高度,`.panel` 改成"填满窗口正文"(`flex:1;min-height:0`) |
| C8 | 示例浮层按视口高度留余量,折叠时隐藏 | `css/panels.css` 806–833 | 锚点改窗口标题栏;`max-height` 按窗口正文高度算 |
| C9 | 面板尺寸/夹取范围在 `UI_CONFIG.panel` | `src/config/uiConfig.ts` 66–85 | 换成 `UI_CONFIG.window` 的各窗口默认几何与最小尺寸;`panel` 段只留 `paramsMinHeight` / `viewControlsMinHeight`(CSS 消费),`split*` 随 `RightSplitController` 一起删除(C14) |
| C10 | 面板尺寸初值的 CSS 兜底 + 测试锁一致性 | `css/base.css` 174–186,`applyUiConfig.test.ts` | **整套删掉**:窗口几何改由 `UI_CONFIG.window` + 行内样式给出,CSS 不再有副本(§11.2 E3) |
| C11 | "点条目行末的过程"= 切标签页 | `DslApp._openProcess` -> `rightPanelTabs.show('process')` | 改成"显示并聚焦过程窗口"(§3.7):源数据没变,变的只是"切页"->"抬窗口" |
| C12 | 面板自带的标题栏与边框/阴影 | `index.html` 三个 `.panel-header`,`.panel-title`;`css/layout.css` 的 `.panel`(含 `overflow: hidden`) | **已按 W6 拍板**:窗口标题栏取代它,**三处 `.panel-header` 全删**(`source code` / `对象` / `视图` 三个文案上移为窗口标题);`.panel` 的 border/阴影留给窗口外壳那一层,不再叠两层.见 §11.1 B8 |
| C13 | `.panel { overflow: hidden }` 裁掉示例浮层 | `css/layout.css`:28 | 裁切职责下沉到 `.window-body`;`.panel` 那条规则搬走后**不带 `overflow`**;浮层从 `.panel-header` 移进窗口标题栏(见 §11.1 B2) |
| C14 | "参数区/视图区"共用参数页的高度,比例由分隔条拖 | `#right-splitter` + `RightSplitController` + `--right-split-basis`(`panels.css:143–185`,`applyUiConfig.ts:38`,`uiConfig.ts` 的 `split*`) | **删除整条链路**:参数与视图各自成窗口,高度由窗口正文给出;`#params-panel` 的 `flex: 0 0 var(--right-split-basis)` 改成 `flex: 1; min-height: 0`;`#view-controls` 变成视图窗口的宿主 |

**不动的**:`EditorLineNumbers`,
`EditorHighlight`,`ObjectListController`,`ParamPanelController`,
`DiagnosticsController`,`ProcessPanel`,`FormulaCopyController`,
`ExampleLoaderController`,`ViewPanel`.它们全部通过构造参数拿节点(装配层
在 `app/appHosts.ts` 与 `ui/desktop/windowChrome.ts` 取好/建好传进去,E34/E35),
窗口化只改**节点在树里的位置与祖先尺寸**,不改节点自身.

**删掉的**:`PanelController`(C1–C4),`RightPanelTabs`(C6)与
`RightSplitController`(C14).三者都是"布局/页面归属/分栏比例"的控制器,而这三
件事在窗口化之后分别由**窗口几何**,**窗口显隐**与**窗口正文高度**表达,不再需要
独立控制器.注意 `RightSplitController` 是 W6 之后才进入删除清单的:只要
参数与视图还共用一栏,它就必须留着.

这是本方案能收敛的前提:**窗口化是"给现有面板换一个容器",不是重写面板**.

---

## 2 目标形态

```text
┌─ #app (desktop) ────────────────────────────────────────────────┐
│  #viewport            铺满,z-index 0      ← three.js canvas     │
│                                                                 │
│  #window-layer        inset:0,z-index 100,pointer-events:none   │
│  ┌ source code ───┐   ┌ 参数 ──────────┐                        │
│  │ 源码 + 示例/RUN │   │ #right-page-   │                        │
│  │ #left-panel    │   │   params       │                        │
│  ├ 视图 ───────────┤   ├ 过程 ──────────┤                        │
│  │ 视图控件        │   │ #right-page-   │                        │
│  │ #view-controls │   │   process      │                        │
│  └────────────────┘   └────────────────┘                        │
│         ┌ 对象 ──────┐                                          │
│         │ 对象列表    │                                          │
│         │ #bottom-... │                                          │
│         └────────────┘                                          │
│  #dock                z-index 200,pointer-events:auto           │
└─────────────────────────────────────────────────────────────────┘
```

每个 `.window` 的结构都相同:`.window-header`(标题 + 标题栏动作 +
窗口按钮,标题是拖动起手区)/ `.window-body`(承载上表里的宿主)/ 八根缩放
手柄.**五个**窗口的位置尺寸都来自 `UI_CONFIG.window.windows`(§2.1).

三层,职责互不重叠:

1. **`#viewport`**:不动一个字节.`SceneManager.resize()` 读
   `container.clientWidth/Height`,只要它继续 `inset: 0` 铺满,画布尺寸,
   相机 aspect,Line2 分辨率都不受影响.
2. **`#window-layer`**:新容器,`inset: 0`,`pointer-events: none`.它只负责
   建立窗口的定位参照与 z-order 层.**整层不拦截指针**,是 W1 能成立的关键:
   桌面空白处,窗口没盖住的地方,OrbitControls 照常收到事件(§3.4).
3. **`#dock`**:新容器,~~底部居中一条~~现在是**紧贴顶部的通栏任务栏**,
   `pointer-events: auto`(整条自己收指针).

窗口自身 `pointer-events: auto`,内部继续用现有 `.panel` 骨架.

**第 0 条约束:全程声明式**.窗口外壳这一层**不写进 `index.html`**,由
`el()` 声明式装配(与 `ViewPanel` 当年把 150 行手写 HTML 收回 TS 是同一条路),
`index.html` 只留面板本体与几个空宿主.装配形状,命名与 DOM 契约见
§5.3 / §5.4;这条不是风格偏好,它有测试守卫(§7 的 `WindowFrame.test.ts`).

### 2.1 五个窗口的默认几何

窗口数从三个变**五个**(W1/W6):右栏那两个标签页("参数 / 视图"与"过程")不再
分页,而且"参数"与"视图"也不再共用一栏高度.拆分口径与代价见 §2.2.

`#app` 的可用区(`desktopW × desktopH`).以下为真实 px(桌面端按窗口大小
重排,见 §3.4 的夹取规则).

| 窗口 | 标题 | 正文宿主 | 默认位置/尺寸 | 最小尺寸 |
| --- | --- | --- | --- | --- |
| `source` | `source code` | `#left-panel` | 左上,`x=16 y=dockReserve+16 w=420 h=round((dH-dockReserve-edgeGap)*0.68)` | 300 × 220 |
| `view` | `视图` | `#view-controls` | 左下,`x=16 y=source.y+source.h+12 w=420 h=dH-edgeGap-y` | 280 × 180 |
| `params` | `参数` | `#right-page-params` | 右上,`x=dW-436 y=dockReserve+16 w=420 h=round((dH-dockReserve-edgeGap)*0.55)` | 280 × 200 |
| `process` | `过程` | `#right-page-process` | 右下,`x=dW-436 y=params.y+params.h+12 w=420 h=dH-edgeGap-y` | 280 × 180 |
| `objects` | `对象` | `#bottom-panel` | 中下,居中 `y=dH-edgeGap-260 w=clamp(360, 720, dW-2*436-32) h=260` | 360 × 160 |

`dW`/`dH` 是桌面宽高.`y` 从**工作区上沿**(`dockReserve`,即顶部任务栏下沿)量起,
`from: 'bottom'` 与"余高"则相对桌面底边,所以五个窗口共用同一条底边线
`dH-edgeGap`(原始设计是 `dH-116`,因为 Dock 当时在底部,要一并让出 100px;
现在 `dockReserve` 从**顶部**让位,底边只剩 `edgeGap=16`,见文首修订块).
表里所有"余高"与 `objects` 的 `y` 都是这条底边线的推论,不是各写各的
数字--旧稿把 `source` 写成通高 `dH-116`,把 `objects` 写成 `y=dH-292`,于是出现
了三条不同的底边(100 / 116 / 32),`objects` 的底边甚至落进 Dock 的 100px 里.

> 这条底边线是硬约束,不是审美:窗口一旦越到底边线以下,它的南边手柄就压在
> 桌面边缘上.阶段 0 的单测要把五个窗口的底边一起断言(§7).

**分栏**:左列 = `source` 上 / `view` 下,右列 = `params` 上 / `process` 下,
两列之外中间留出 3D 视口,`objects` 居中占底部.这样分组是有意的:
左列是"写与看"(源码 + 视图),右列是"算与解"(参数 + 过程),对象列表横跨中下.

编辑器高度要让出来:旧稿的 `source` 是通高,现在被 `view` 分走 32%.
`h=round((dH-dockReserve-edgeGap)*0.68)` 这个比例是**为了让编辑器在小视口下也够用**
定的
(1920×1080 -> 696px,1280×800 -> 506px,都还有 ~69% 的列高);
`view` 拿"余高",在 1280×800 下是 210px,刚好过它的最小高 180.

> 换一种摆法也可以(比如把 `view` 放进右列与 `params`,`process` 三明治),
> 但右列三段在 1280×800 下每段只剩 ~190px,`params` 的滑块与 `process` 的
> 递等式都会很难受.默认几何是"一期的起点"而不是"布局引擎",用户拖一次就
> 改了;真正要守的是底边线与不越界,见下面那张核对表.§10 的"不做自动平铺"
> 也适用于这里.

**中列宽度是算出来的**,不是写死的:`dW-2*436-32` 是"两侧窗口各
420 加左右各 16 的间隙"之后剩下的宽度,再夹到 `[360, 720]`
(1280 -> 376,1920 -> 720).这条换算与 §3.4 的夹取共用同一组纯函数.

> **关于"不重叠"这条,核过一次**(数字可以直接当单测断言,和
> `WindowGeometry.test.ts` 的期望值一致):
>
> ```text
> 1280×800: 左列 16...436 | objects 452...828 | 右列 844...1264   -> 无重叠
> 1920×1080: 左列 16...436 | objects 600...1320 | 右列 1484...1904 -> 无重叠
> 底边线(五个窗口共用,一起断言):1280×800 全部 = 784;1920×1080 全部 = 1064
> 左列内部:source 底 562 / view 顶 574(1280×800),source 底 752 / view 顶 764(1920×1080)
> ```
>
> 三条结论:**① 两个目标视口下都不重叠**;**② 更窄的视口下允许重叠**;**③ 五个
> 窗口的底边线一致,且都在桌面底边之内**.② 的取舍是窗口可以拖,用户
> 自己摆,与 §10「明确不做」里的"不做自动平铺"是同一条取舍.真正必须守住的不
> 变量只有两条:**窗口不越界** 与 **标题栏永远在桌内**,它们由 §3.4 的夹取保证.
> `x: 'center'` 的换算是
> `x = clamp(round((dW - w) / 2), 0, dW - w)`,窄视口下自然退化成贴边.

默认几何写在 `UI_CONFIG.window.windows`(锚点式描述,见 E4),由
`WindowGeometry.resolveDefaultGeometry()` 按当前桌面尺寸算出 px,在
`WindowFrame` 建完元素后立即写行内样式.**CSS 侧不留副本**,理由见 §11.2 E3.

### 2.2 为什么把三页拆成三个窗口(以及参数/视图为什么也拆)

当年把求解过程做成右栏**第二个标签页**(提交 `456daef`),理由是空间不够:
右栏一份宽度,一次只能看一页,好处是"手不动的东西可以让位给过程板书"
(`docs/equation-solving-process.md` 第 1 节).窗口化之后这条约束消失了:

- **一次只能看一页** -> 多个窗口可以同时看,拖参数滑块时过程里的"系数取值"
  那一步就在旁边,这正是求解示例(`example/solve_equations.miko`)最想让人
  看到的东西;
- **共用一份宽度** -> 过程窗口可以单独拖宽.当年文档 §3.3 记的"过程页默认
  300px 对递等式偏窄(一条链式展开要 400–500px)"由此有了出路:不用加"板书
  模式"按钮,也不用连累参数窗口(它 300px 就够);
- **切页** -> 每个窗口各自有最小/最大化/关闭,可以只要过程不要参数.

**"参数"与"视图"为什么也拆**(W6,用户 2026-09 追加拍板):它们本来就是同一栏
里的**上下两块**,靠 `#right-splitter` 抢高度--这是三页里唯一还在"共用"的
一对.拆开之后:

- 视图窗口可以整块收起或最大化,调相机/坐标轴时不必把参数挤成一条;
- `#params-panel` 不再需要 `flex: 0 0 var(--right-split-basis)`,也不再有
  "参数区最小高度 / 视图区最小高度"互相牵制的那套下限;
- 代价是删除整条分栏链路:`RightSplitController`,`#right-splitter`,
  `--right-split-basis`,`UI_CONFIG.panel.split*`,以及对应测试(§1.2 C14);
- 另一个代价:`source code` 不再是通高窗口(视图窗口占左列下方,§2.1).
  编辑器拿到约 69% 的列高,这是刻意的取舍.

代价要写清楚:默认布局多两个窗口(小视口下五块可能重叠,但窗口可拖,用户
自己摆,见 §2.1 的说明);过程窗口不再"切过去就自动在前",改成**显式抬升焦点**
(§3.7).

### 2.3 与 3D 视口的关系(必须写清的边界)

- 3D 视口**不是窗口**,它没有标题栏,不能移动,不能关闭.这一条是 W1 的直接
  后果,也是本方案最省改动的地方.
- 副作用要接受:**看着**某块 3D 区域想转视角,如果那块被窗口盖住,点在窗口上
  是操作窗口,不是转视角.空桌面处照常可转.
- 单窗口最大化(§3.3)会把桌面盖满,此时只剩 Dock 上一条;想转视角先
  还原或最小化.这是刻意的取舍,不是缺陷.
- 后续若要"边看大图边调参数",出路是把视口也变成窗口(参考项目的 `--w/--h`
  百分比方案),那是另一次工作,本方案不做.

---

## 3 窗口模型

### 3.1 状态与唯一写入点

> **后续修订**:状态只剩三个(`normal | maximized | minimized`),字段仍是
> `geometry` / `state` / `restore` / `focused` / `zIndex`;`fullscreen` 与
> `closed` 两条状态连同它们的动作,类名,键盘绑定一起删除(见文首修订块与
> §11.2 E37).下文的五态与转移表是原始设计,保留作记录.

一个窗口的状态收敛成五个字段,全部由 `WindowManager` 持有:

```text
geometry   { x, y, w, h }          // 普通态几何(px,相对 #app)
state      'normal' | 'maximized' | 'minimized'   // 原设计还有 fullscreen / closed
restore    geometry | null         // 进入 maximized 前的几何,还原用
focused    boolean                 // 与 z-order 一起维护
zIndex     number                  // 该窗口当前的 z-index(焦点独占写入)
```

- **几何的唯一写入点**是 `WindowManager._applyGeometry(id)`:普通态把
  `geometry` 逐条写进该元素的 `left/top/width/height`;`maximized` 态则**清掉
  这四条行内属性**,几何交给 `.is-maximized` 的 `inset`.
  它不写类名,也不碰 `z-index`(行内属性压过类规则,清不干净就是"最大化没反应").
- **状态的唯一写入点**是 `WindowManager._applyState(id)`:`.window` 上的
  **每一个类**(`.is-maximized` / `.is-hidden` /
  `.is-focused` 除外--后者归 `focus()`)都在这里切,并刷新
  `inert` / `aria-hidden` / 任务栏按钮的激活态与淡化.拖动,按钮,
  Dock,键盘(阶段 5)全部只改状态,由这两个函数落地.
- `z-index` 有**第三**个写入点,就是 `focus()`:几何写入会清行内样式,两者
  必须分开,否则会出现"拖动时窗口掉到后面"(§11.2 E8).
- 这条"一个状态源 + 一个写入点"的约定是从 `PanelController` 继承的
  (它当年就是为了修 `UI-P3.3` 的分叉),必须照搬:窗口化把状态从 1 个
  布尔扩成 5 态 + 几何 + z-order,没有这条,分叉会成倍出现.

**状态转移**:

| 起点 | 事件 | 终点 | 备注 |
| --- | --- | --- | --- |
| normal | 拖标题栏 | normal | 只改 `geometry` |
| normal | 最大化按钮 / 拖到顶部任务栏附近 / 标题栏双击 | maximized | 存 `restore` |
| normal | ~~全屏按钮~~ | ~~fullscreen~~ | **已删除** |
| normal | 最小化按钮 | minimized | `focused = false`,焦点下移 |
| normal | ~~关闭按钮~~ | ~~closed~~ | **已删除**(与最小化等价);任务栏按钮保留 |
| maximized | 还原按钮 / 拖标题栏(拖即还原并跟手) / 点任务栏按钮 | normal | 用 `restore` |
| maximized | ~~全屏按钮~~ | ~~fullscreen~~ | **已删除** |
| ~~fullscreen~~ | ~~`Esc` / 退出按钮~~ | ~~normal~~ | **已删除** |
| maximized | 最小化按钮 | minimized | `restore` **保留**,再开还是最大化前的尺寸 |
| minimized | 任务栏按钮 | normal | 回 `geometry` |
| ~~closed~~ | ~~任务栏按钮~~ | ~~normal~~ | **已删除** |
| 任意 | 桌面 `resize` | 同态 | normal 按夹取规则收进工作区;maximized 只需重算类(几何被 CSS 接管) |

`minimized` 是唯一的隐藏态(它与原设计的 `closed` 行为**完全等价**:都进
`is-hidden` + `inert`),所以 `closed` 连同那个只写不读的 `.is-closed` 类一起
删掉了(见 §11.2 E31/E37).后续若真要"关闭=释放内容",再按新语义加回来,
而不是先留一个空类名.

### 3.2 焦点与 z-order

- 3D 的 `z-index` 是 0;窗口层是 100;Dock 是 200.窗口之间在 100–199 之间
  取号,从 110 起递增,**不做取模回收**(会话内几百次提升不会溢出,回收只会
  引入"层级回绕"的隐蔽 bug).
- 提升规则:`pointerdown` 落在窗口任意位置(capture 阶段)-> 该窗口提到最高
  z,其余窗口去 `.is-focused`.这与 `bindDragGesture` 的 `preventDefault` 不
  冲突:提升监听不阻止默认行为,只改 z 与类.
- **提升不改 DOM 焦点**:指针路径**只**动 z 与类,不动 `element.focus()`.
  否则点在编辑器里光标会丢,点在参数输入框里焦点会被窗口抢走.程序路径
  (`reveal()` / Dock 点击)才取焦点--两条路径的开关见 §4.5 的
  `focus(id, { takeDomFocus })`.
- 关闭/最小化当前焦点窗口时,焦点交给**可见窗口中 z 最高**的那个;没有就
  交回桌面(不强行给某个窗口,避免"我关了 A 却把 B 顶到最前"的意外).
- 视觉:聚焦窗口的边框/标题栏亮度提升,复用现有 token(§5.5),不引入
  参考项目那种"青/琥珀两套描边互换"的做法.

### 3.3 最大化(~~与单窗口全屏~~)

> **后续修订**:这一节只剩"最大化",单窗口全屏连同它的按钮 / `Esc` / `.is-fullscreen`
> 已删除;最大化填的是**顶部任务栏之下的工作区**(`inset: var(--dock-reserve) 0 0 0`),
> 不是"减去 `dockReserve` 的底部余量".下表是原始设计,保留作记录.

| 档 | 触发 | 效果 |
| --- | --- | --- |
| **最大化** | 标题栏右上的 `▣` 按钮;标题栏双击;拖到顶部任务栏附近(阈值 = 任务栏下沿 + `snap.edge`) | ~~填满 `#app` 减去 `dockReserve`(100px)的底部余量~~ -> 填满工作区,**保留**窗口标题栏与顶部任务栏 |
| **单窗口全屏** | ~~标题栏右上的 `⤢` 按钮(或 `F11` 语义)~~ | **已删除**(它相对最大化只剩"遮不遮任务栏",而任务栏不该被遮) |

最大化只写一个 CSS 类(`.is-maximized`),几何从类里
`inset: var(--dock-reserve) 0 0 0` 得到,**不覆盖 `geometry`**;退出时 `restore`
或 `geometry` 原样
写回,所以"最大化前拖到一半的窗口"能精确还原.

`resize` 时若处于 maximized,只需重算类(几何被 CSS 接管),不需要
夹取;处于 normal 的窗口按 §3.4 夹取.

### 3.4 拖动,八向缩放与指针穿透

**拖动**:起手元素是 `.window-title`(标题文字 + 可选 `slots.title`),标题栏
动作(`.window-actions`:示例 / RUN)与窗口按钮(`.window-controls`)是它的
**兄弟**,天然不在拖动区内.不做"整个 header 可拖,靠 `closest('button')`
过滤":`bindDragGesture` 在 `pointerdown` 里 `preventDefault()`,而
`pointerdown` 的默认行为包含"聚焦 + 后续 click/双击",让它落在按钮上会连点都
点不动(参考项目就是靠运行时判断绕开的,见 §3.8);用元素边界把这件事表达
清楚,比在运行期判断"点到的是不是按钮"更可靠(结构见 §5.4).

- 拖动全程给窗口加 `.is-dragging`,由 CSS 保证拖动期间正文 `pointer-events: none`
  (拖到数字输入框上方不会误触),并提升合成层.
- 跟手实现沿用 `bindDragGesture` 的**增量**语义,由 `WindowManager` 自己累加
  `geometry.x/y` 并夹取:增量语义在夹到边界后回拖能立刻跟上,不会出现
  "起点 + 总位移"那种死区(`dragGesture.ts` 文件头已写明这条理由).

**调整窗口大小:机制原样保留,难度不高**.这一点要写清楚,避免被当成两件事:

- **保留现有的一套**:仍然只有 `src/ui/shared/dragGesture.ts` 一个拖动实现,
  仍然由 CSS 给手柄光标(`bindDragGesture` 起手时读的是
  `getComputedStyle(handle).cursor`,这是"光标只有 CSS 一个来源"的前提),
  仍然用 `is-dragging` 类表达拖动中,仍然由 `{ signal }` 统一解绑.
- **只改属性与归属,不改类名**:
  - 连接属性:现有三根 `[data-resize-panel]`(左/右面板宽度,底部面板高度)
    换成八根 `[data-window-resize]`(方向 `n/s/e/w/ne/nw/se/sw`),仍是
    "数据属性负责连接"(与 `PanelController` 当年的约定一致),
    `WindowFrame.test.ts` 按它断言.
  - **类名 `.resize-handle` 保留**(用户明确要求):手柄就是
    `<div class="resize-handle" data-window-resize="e">` 这样的元素.
    现有 `css/layout.css` 里那四条 `.resize-handle-{right,left,top}` 是**针对
    面板边缘**写死的定位,随 `layout.css` 一起删除;但 `.resize-handle` 基类
    与"光标由 CSS 给"这条约定原样搬到 `css/window.css`(八向光标:
    `n/s` = `ns-resize`,`e/w` = `ew-resize`,`ne/sw` = `nesw-resize`,
    `nw/se` = `nwse-resize`).`bindDragGesture` 起手时读的
    `getComputedStyle(handle).cursor` 因此仍然有值,不需要任何新逻辑.
- **新增的只是几何解释**:`WindowResize.ts` 把 `(方向, deltaX, deltaY)` 映射成
  `x/y/w/h` 的改变,是纯函数,不碰 DOM(下面就是全部算术);
  `WindowManager` 累加后统一走本节末尾那套夹取,再交给几何的唯一写入点.

```text
east  : w += dx
west  : x += dx ; w -= dx
south : h += dy
north : y += dy ; h -= dy
// 角 = 两个方向的并集:e.g. se = east + south,nw = north + west
```

三条必守的细节(否则会有"拖不动""窗口跳""拖到自己身上"的观感 bug):

1. **`west`/`north` 要同时动 `x`/`y` 与 `w`/`h`**:只改尺寸会让窗口"看着不动,
   右边却在跑".这是最容易被写错的一条.
2. **夹取要在累加后统一做一次**,不要在 `w -= dx` 与 `x += dx` 之间插夹取:
   `west` 撞到 `minW` 时必须让 `x` 跟着停住,先夹 `w` 再算 `x` 会把窗口整体
   往右推.做法是先把 `x/w` 都算出来,再一起夹(或者按方向夹 `w` 后反推
   `x = right - w`).
3. **至少 `EDGE_KEEP` 宽留在桌内**(与移动同一条),否则把东边一路拖到屏幕外
   就只剩一条抓不住的边.

夹取规则(数值见 `UI_CONFIG.window`):

```text
minW/minH 来自 UI_CONFIG.window.windows[id]
w ∈ [minW, max(minW, desktopW)]        h ∈ [minH, max(minH, desktopH)]
x ∈ [-(w - EDGE_KEEP), desktopW - EDGE_KEEP]     // 至少留 EDGE_KEEP 宽在桌内
y ∈ [0, desktopH - HEADER_MIN]                   // 标题栏绝不能被拖出桌顶
```

`y` 的下限取 0 而不是负值:标题栏是唯一的手动入口,它一旦跑到 `#app` 外面
就再也抓不回来.参考项目 `makeDraggable` 只夹 `0 ≤ y ≤ innerHeight - offsetHeight`,
窗口比视口高时会把标题栏夹出屏幕,这正是我们要避开的.

八根手柄统一用现有的 `.resize-handle` 类 + `[data-window-resize]` 方向属性;
它们的命中区与光标归 `css/window.css`,自己不带任何 JS 尺寸逻辑;
`.window-body` 的内容不参与手柄的定位(手柄是 `.window` 的绝对定位子元素).

**指针穿透不是可选项**:`#window-layer` 必须 `pointer-events: none`,只有
`.window` 及其内部 `auto`.否则窗口层会整片盖住 canvas,OrbitControls 立刻
失效(W1 的核心约束).

### 3.5 边缘吸附与磁吸对齐

拖动过程中,每帧算一次吸附候选,**预览用一层覆盖高亮表达,松开才落地**:

| 触发 | 预览 | 落地结果 |
| --- | --- | --- |
| 指针距桌面左/右边缘 ≤ `SNAP_EDGE`(16px) | 半屏高亮区 | 窗口吸附成该半屏(`w = desktopW/2`,通高) |
| 指针距桌面上边缘 ≤ `SNAP_EDGE` | 全桌面高亮 | 最大化(§3.3) |
| 窗口某条边与另一可见窗口的对应边距离 ≤ `SNAP_MAGNET`(8px) | 对齐参考线 | 该边贴合(只吸附正在被拖的那条边,不改变尺寸) |

- 高亮层是 `#snap-preview`(一个绝对定位 div,形状由**行内几何**给出:半屏就是
  `desktopW/2` 宽的矩形,最大化就是整块桌面),不做动画,拖动结束即隐藏.
  落地时删掉了原方案的 `is-left` / `is-right` / `is-maximize` 类:形状已经由
  几何表达,那三个类没有 CSS 消费者(§11.2 E31).
- 磁吸只对**同一轴**的边生效,且吸附是"这一次移动的修正",下一次移动会先
  清掉修正再判--否则窗口会被永久吸住.
- 阈值进 `UI_CONFIG.window.snap`,不进 CSS(CSS 不消费,与现有
  `sideMinWidth` 那批值的处理一致).

### 3.6 Dock / 任务栏

> **后续修订**:Dock 现在是**紧贴桌面上沿的通栏任务栏**,`dockReserve` 就是栏高
> (默认 40),既是任务栏高度也是工作区上沿;动作区只剩"全部还原"(退出全屏按钮
> 随全屏一起删除).下面的"底边居中"是原始设计,保留作记录.

一条固定在~~底边居中~~顶部通栏的横向容器,内容**由窗口清单生成**(不在 HTML 里
手写按钮,与"示例菜单由控制器渲染"同一约定):

- 每个窗口一个按钮:**只放标题**,不摆状态标记.点击语义按状态分派:normal ->
  提升并聚焦(已是焦点则最小化);minimized -> 恢复到 `geometry`;
  maximized -> 还原到 `normal`.
- 按钮自身就是状态指示:当前焦点窗口的按钮带 `.is-active`(背景 + 边框 + 文字色),
  最小化的按钮按 `data-state` 淡化(`opacity: 0.6`).
- 任务栏右侧另放一个**桌面动作区**:一个"全部还原"入口(把五个窗口一键复位到
  默认几何,对应参考项目的"恢复默认").~~单窗口全屏退出(`Esc` 同样可退)~~
  已随全屏删除.
- 任务栏常驻:即使五个窗口全最小化也必须在,否则用户没有回到窗口的入口.
  窗口全最小化时桌面只剩 3D 视口,`:empty` 之外的提示不必做.

### 3.7 过程窗口的"打开"语义(替代切标签页)

拆成独立窗口之后,"点条目行末的过程"这件事从**切页**变成**抬窗口**,需要一条
明确口径,否则会出现"点了没反应"(过程窗口正被最小化)或"点了我正在编辑的东西
被抢走焦点"两种坏手感.

`DslApp._openProcess(request)` 的三步(顺序固定):

1. **恢复可见**:过程窗口若处于 `minimized` / `closed`,无条件回到
   `restore ?? geometry`(与 Dock 点击同一条写入路径,不新开分支);
2. **抬升并聚焦**:提到 z 最高,加 `.is-focused`,并让过程窗口获得 DOM 焦点
   (`element.focus({ preventScroll: true })`,窗口带 `tabindex="-1"`);
3. **载入文档**:`processPanel.show(document)`,与现在完全一致.

三条不变量:

- **不最大化,不改几何**:点"过程"只让它可见并到最前,尺寸是用户的事.
  参考项目那种"点一下就把窗口弹到某个尺寸"的做法不引入.
- **不碰参数窗口**:参数窗口可以仍在最前(用户正拖滑块时点过程,过程窗口会
  盖在它上面,但参数窗口的几何与数值不变).这比原来"切页会把参数页整页
  `hidden`"更温和--原来切页是**连视图一起消失**,现在只是被盖住.
- **焦点去向只有一处**:步骤 2 的"抬升 + `.is-focused`"必须调用
  `WindowManager.focus(id)` 这个既有入口,不在 `DslApp` 里手写 z-index 或类名
  (与 §3.1 的"一个状态源 + 一个写入点"同一条理由).

`ProcessPanel.refreshEcho()` 的旧触发点("切回过程页时刷新参数只读回显")随之
失去意义:参数一变,过程窗口顶部的只读回显本来就在旁边,也不存在"切回来"
这个动作.它的新触发点是 `paramPanelController` 的值变化(已有 `_scheduleRefresh`
那条链路),细节见 §7 的测试改写.

### 3.8 与参考项目的逐条差异

参考项目只借观感,以下是我们**刻意不同**的地方:

| 参考项目 | 问题 | 本方案 |
| --- | --- | --- |
| `--x/--y/--w/--h` 百分比定几何 | 窗口大小随视口按比例缩放,"最小尺寸"无从表达;字号不跟着缩,小视口必然挤坏 | px 几何 + 显式最小尺寸 + `resize` 时夹取 |
| 拖动只夹 `0 ≤ y ≤ innerHeight - offsetHeight` | 窗口高于视口时标题栏被夹出屏幕,抓不回来 | `y ∈ [0, desktopH - HEADER_MIN]`,标题栏恒在桌内 |
| 缩放用 `resize: both` + CSS | 原生 resize 光标/尺寸不受控,与"拖动窗口"两套手感 | 八根手柄统一走 `bindDragGesture` |
| 局部缩放 `transform: scale()` | 缩放后命中区域与视觉脱节(靠 200ms 后移除过渡遮丑) | 不做缩放;要么原尺寸,要么最大化 |
| `contenteditable` 编辑模式 | 页面即编辑器,内容可被误改 | 不做.界面不做运行时编辑 |
| 布局存 `localStorage` 的原始 `cssText` 字符串 | 字符串里塞的是上一次的出生格式,字段一改就静默失配 | 不持久化(W4);内部状态是结构化的对象,不留字符串副本 |
| z-index 每次 `++topZ`,关闭/删除窗口也占号 | 长会话下无上限 | 同左但明说不会溢出;不做回收 |
| 关窗只加 `.closed`(`opacity: 0` + `pointer-events:none`) | 元素仍在无障碍树与 Tab 序里(读屏还能念到关掉的窗口) | 用 `opacity: 0` + **`inert`** + `aria-hidden="true"`,但**不**用 `display: none`(理由:编辑器行号与高亮层会量到 0 尺寸,见 §5.6) |
| Dock 按钮靠手写 `data-restore` 与 id 配对 | 加窗口要两处同步 | 按钮由窗口清单生成,`data-window` 一条连接 |
| 顶栏标题 `contenteditable` 可改 | 窗口标题与内容命名分叉 | 标题由窗口注册表给出,不可改 |

---

## 4 实现规格

> **后续修订**:这一章的**代码清单是当时的原始设计**,现状以库仓库 `miko_ui`
> 的源码为准(差异汇总见文首修订块与 §11.2 E37)--具体地:动作只剩
> `minimize | maximize`,状态只剩 `normal | maximized | minimized`,`Dock` 是顶部
> 通栏任务栏,`dockReserve` 默认 40 且是工作区上沿,`--dock-reserve` /
> `--window-header-height` 由库从 `DesktopConfig` 写到桌面根.类型与公式的口径
> (夹取 / `fitGeometry` / 吸附 / 单一写入点)不变,只是去掉全屏与关闭那两条分支.

这一章是"照着写"的部分:类型,函数,状态转移,写入点,常量.凡是本文件给出
签名的,文件名与签名都可以直接用;凡是本文件给出公式的,不要另发明一套.

### 4.1 配置:新增 `UI_CONFIG.window`

位置:`src/config/uiConfig.ts`,与现有 `editor` / `formula` / `panel` / `process`
/ `view` 平级的**纯数据**段.契约与现有约定一致:

- **CSS 不消费它**(窗口几何由 JS 写成行内样式,见 §11.2 E3),所以
  `applyUiConfig.ts` 的映射表**不加任何 `--window-*`**;
- `css/base.css` 里**不留副本**;
- `as const` 已经在文件末尾统一收口,这里的形状按它写.

```ts
/** 一个轴上的定位:固定像素 / 贴另一边 / 居中 / 占桌面的一档 / 夹取. */
type AxisSpec =
    | { readonly at: number }                                        // 固定 px
    | { readonly from: 'right' | 'bottom'; readonly inset: number }   // 贴右边/下边
    | 'center'                                                       // 居中
    | { readonly fraction: number; readonly of: 'usableHeight' }      // 占可用高的一档
    | { readonly clamp: readonly [min: number, max: number];
        readonly inset: number };                                    // 夹取(中列宽度)

/**
 * `from: 'bottom'` 的语义**写死成一条**(旧稿没写,于是同一份 spec 算不出
 * §2.1 的两组期望值):
 *
 *   x: { from: 'right',  inset }  ->  x = dW - inset - w   // 右边贴到 dW-inset
 *   y: { from: 'bottom', inset }  ->  y = dH - inset - h   // 底边贴到 dH-inset
 *   h: { from: 'bottom', inset }  ->  h = dH - inset - y   // 同上,解出高度
 *
 * 三个都读作"**该窗口的这条边落在距桌面该侧 inset 处**".于是 `view` 与
 * `process` 用同一个 `inset: 116` 就自动落在同一条底边线上,不需要两套规则.
 * `x: 'center'` 用算出来的 `w`;`usableHeight = desktop.h - dH的底边余量(116)`
 * (source / params 用 `fraction` 拿它的一档).
 */

/** 默认几何:写"锚点",不写算出来的数字(见 E4). */
type WindowGeometrySpec = {
    readonly x: AxisSpec;
    readonly y: AxisSpec;
    readonly w: AxisSpec;
    readonly h: AxisSpec;
    /** 依赖另一个窗口:`y` 接在 `after` 的下方 `gap` 像素处(`y` 被忽略). */
    readonly after?: { readonly id: string; readonly gap: number };
};

interface WindowConfigEntry {
    readonly id: 'source' | 'view' | 'params' | 'process' | 'objects';
    /** 标题栏文案,同时是 Dock 按钮的 `title` 与无障碍名. */
    readonly title: string;
    /** 正文宿主 id:由 readAppHosts() 取成节点后交给 WindowManager(见 E35). */
    readonly hostId: string;
    readonly dock: { readonly label: string };
    readonly defaultGeometry: WindowGeometrySpec;
    readonly minSize: { readonly w: number; readonly h: number };
}

window: {
    windows: readonly WindowConfigEntry[];   // 五个,顺序即 z 初始序与 Dock 顺序
    /** 标题栏上的窗口按钮:顺序即显示顺序,glyph 进配置不散在 TS 里. */
    actions: readonly {
        readonly id: 'minimize' | 'maximize' | 'fullscreen' | 'close';
        readonly label: string;   // aria-label / title
        readonly glyph: string;   // '─' '▣' '⤢' '✕'
    }[];
    /** 桌面几何常量(单位 px). */
    edgeKeep: number;      // 移动/缩放时至少留在桌内的宽度,建议 80
    edgeGap: number;       // 窗口与桌面边缘的间隙,建议 16
    headerMinVisible: number;  // 标题栏至少可见高度,建议 HEADER_HEIGHT
    dockReserve: number;   // 底部为 Dock 留出的高度,建议 100
    /** 底边线 = desktop.h - (dockReserve + edgeGap) = dH-116:五个窗口共用,
     *  由 §4.1 里各窗口的 `inset: 116` 表达(数值写在各窗口 spec 里,
     *  不在这里再造一个派生常量,避免"改了一处忘了另一处"). */
    /** `.window-header` 高度:经 applyUiConfig 写成 `--window-header-height`,
     *  css/window.css 用 `height: var(--window-header-height)` 消费.数值只有
     *  这一处,另加一条测试锁住(与 `--side-default-width` 那批同一处理). */
    headerHeight: number;
    z: { windowLayer: number; first: number; snapPreview: number; dock: number };
    snap: { edge: number; magnet: number };   // 16 / 8
}
```

**五个窗口的数值**(就是 §2.1 那张表的机器可读版;数组顺序 = Dock 顺序 =
依赖顺序,不能随意调):

```ts
{ id: 'source',  title: 'source code', hostId: 'left-panel',
  dock: { label: '源码' },
  defaultGeometry: { x: { at: 16 }, y: { at: 16 }, w: { at: 420 },
                     h: { fraction: 0.68, of: 'usableHeight' } },  // = round((dH-116)*0.68)
  minSize: { w: 300, h: 220 } }

{ id: 'view',    title: '视图',       hostId: 'view-controls',
  dock: { label: '视图' },
  defaultGeometry: { x: { at: 16 }, y: { at: 0 },
                     w: { at: 420 }, h: { from: 'bottom', inset: 116 },
                     after: { id: 'source', gap: 12 } },           // y = source.y + source.h + 12
  minSize: { w: 280, h: 180 } }                                    // h = dH - 116 - y(与 process 同一条底边)

{ id: 'params',  title: '参数',       hostId: 'right-page-params',
  dock: { label: '参数' },
  defaultGeometry: { x: { from: 'right', inset: 16 }, y: { at: 16 }, w: { at: 420 },
                     h: { fraction: 0.55, of: 'usableHeight' } }, // = round((dH-116)*0.55)
  minSize: { w: 280, h: 200 } }

{ id: 'process', title: '过程',       hostId: 'right-page-process',
  dock: { label: '过程' },
  defaultGeometry: { x: { from: 'right', inset: 16 }, y: { at: 0 },
                     w: { at: 420 }, h: { from: 'bottom', inset: 116 },
                     after: { id: 'params', gap: 12 } },          // y = params.y + params.h + 12
  minSize: { w: 280, h: 180 } }                                   // h = dH - 116 - y(与 view 同一条底边)

{ id: 'objects', title: '对象',       hostId: 'bottom-panel',
  dock: { label: '对象' },
  defaultGeometry: { x: 'center', y: { from: 'bottom', inset: 116 },  // = dH - 116 - h = dH - 376
                     w: { clamp: [360, 720], inset: 2 * 436 + 32 },  // = dW - 904
                     h: { at: 260 } },
  minSize: { w: 360, h: 160 } }
```

`source` 的 `h`,`params` 的 `h` 用 `fraction`,`view` / `process` 的 `y` 用
`after` 接在上面那个窗口的下方 `gap` 像素处,**计算顺序固定**:数组顺序即依赖
顺序(§4.5 的 `bind()` 就是按数组顺序遍历的).先把数组排成
`source -> view -> params -> process -> objects`,两条 `after` 的前置窗口就都在
它前面(`view` 依赖 `source`,`process` 依赖 `params`).
`y` 在类型上是必填,所以 `view` / `process` 各写了一个占位的 `y: { at: 0 }`;
**存在 `after` 时以 `after` 为准,`y` 被忽略**(不要两边都写真值,否则读的人
不知道哪个生效).`view` / `process` 的 `h` 照旧按 §4.1 的语义解出:
`h = dH - inset - y`,其中 `y` 是 `after` 算出来的那个值.
`resolveDefaultGeometry(spec, desktop, resolved)` 的第三个参数就是"已经算出来的
前几个窗口",`after` 从里面取.

两条换算例子(可以直接当单测用例;五个窗口的底边都在同一条线上):

```text
1920×1080: 底边 964 | source h=656 底672 | view y=684 h=280 | params h=530 底546 | process y=558 h=406 | objects y=704 w=720
1280×800 : 底边 684 | source h=465 底481 | view y=493 h=191 | params h=376 底392 | process y=404 h=280 | objects y=424 w=376
```

三个容易算错的点,阶段 0 的用例要盯住:①`source`/`params` 的 `fraction` 取的是
`usableHeight = dH-116`,不是桌面高(`0.68*964=655.5 -> 656`,不是 `734`);
②`view`/`process` 的 `h` 是"从自己的 `y` 到 `dH-116`",所以两列的 `y` 值相同
时高度也相同(`558 -> 406`);③`objects` 的 `y` 用 `h` 反推(`964-260=704`).

### 4.2 `WindowGeometry.ts`(纯函数,阶段 0)

**不含任何 DOM 引用,不 import `document`**.建议签名:

```ts
export interface Desktop { readonly w: number; readonly h: number }
export interface Geometry { readonly x: number; readonly y: number;
                            readonly w: number; readonly h: number }
export interface SizeConstraints { readonly w: number; readonly h: number }
export interface Limits {
    readonly desktop: Desktop;
    readonly min: SizeConstraints;
    readonly edgeKeep: number;
    readonly headerMinVisible: number;
}

/** 默认几何:锚点/夹取 -> px.五个窗口的依赖顺序由调用方保证(见 §5.1). */
export function resolveDefaultGeometry(
    spec: WindowGeometrySpec, desktop: Desktop, resolved: ReadonlyMap<string, Geometry>,
): Geometry;

/** 夹取:尺寸 [min, max(min, desktop)],x/y 按 edgeKeep / headerMinVisible. */
export function clampGeometry(g: Geometry, limits: Limits): Geometry;

/** 移动:k -> k+1 的唯一入口.delta 是原始像素增量. */
export function moveGeometry(g: Geometry, dx: number, dy: number, limits: Limits): Geometry;

/** resize 时把窗口整体收进桌内(初始几何与桌面 resize 都走它). */
export function fitGeometry(g: Geometry, limits: Limits): Geometry;

/** 吸附落点的三种形状(与 resolveEdgeSnap 的返回同域). */
export type SnapKind = 'left' | 'right' | 'maximize';

/** 吸附判定:返回落点几何或 null(不吸附). */
export function resolveEdgeSnap(
    pointer: { x: number; y: number },
    desktop: Desktop, snap: { edge: number },
): { readonly target: Geometry; readonly kind: SnapKind } | null;

/** 磁吸:把被拖的边贴到其它窗口的对应边.只改一个轴. */
export function magnetize(
    g: Geometry, others: readonly Geometry[], magnet: number,
): Geometry;

/**
 * 几何的四条行内属性:窗口几何**唯一允许的写入形状**
 * (`WindowManager` 逐条 `style.setProperty`,见 §4.5).
 */
export function geometryStyle(
    g: Geometry,
): Readonly<Record<'left' | 'top' | 'width' | 'height', string>>;
```

**夹取公式(唯一一份)**:

```text
maxW = max(min.w, desktop.w)          maxH = max(min.h, desktop.h)
w    = clamp(g.w, min.w, maxW)        h    = clamp(g.h, min.h, maxH)
x    = clamp(g.x, -(w - edgeKeep), desktop.w - edgeKeep)
y    = clamp(g.y, 0, max(0, desktop.h - headerMinVisible))
```

`max(min, desktop)` 那个兜底是为了小视口:桌面比最小尺寸还小时,宁可让窗口
超出桌面,也不要算出 `min > max` 的区间(`clamp` 会返回 `min`,窗口比桌面大,
标题栏仍在桌内,能抓回来).

`maximized` / `fullscreen` 的落地几何**不在 `WindowGeometry.ts`**:进入这两种态
时 `WindowFrame.clearGeometry` 清掉行内四条属性,几何交给 `css/window.css` 的
`.window.is-maximized`(`inset: 0 0 var(--dock-reserve) 0`)与
`.window.is-fullscreen`(`inset: 0`).原方案里的 `maximizedGeometry` /
`fullscreenGeometry` 两个函数在落地时删除了:它们是同一组数字的第二份实现,
而且只被自己的单测调用(§11.2 E31).

`resolveEdgeSnap` 的判据(三者互斥,按这个顺序判):

```text
pointer.y <= snap.edge                        -> maximize
pointer.x <= snap.edge                        -> { x: 0, w: desktop.w / 2, h: 整个可用高 }
pointer.x >= desktop.w - snap.edge            -> { x: desktop.w / 2, ... }
其它                                          -> null
```

半屏的高度与最大化一致(减去 `dockReserve`),这样三者观感统一.

`magnetize` 只处理"正在被拖的那条边":拖左边的窗口时取 `g.x`,与其它窗口的
`x` 或 `x + w` 比较,差值在 `magnet` 内就贴上去;`y` 同理.**一次移动只吸附
一次**,下一次移动先清掉上次的修正(所以修正量由调用方按"这次移动"临时算,
不要写进 `entry.geometry`).

### 4.3 `WindowResize.ts`(纯函数 + 绑定)

**纯函数部分**(阶段 0 一起测):

```ts
export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** 方向 -> 这次增量怎么改几何.纯算术,不夹取(夹取统一在调用方做一次). */
export function applyResize(
    g: Geometry, direction: ResizeDirection, dx: number, dy: number,
): Geometry;

/** 绑定:把某根手柄接到上面那个函数.DOM 部分只做这一件事. */
export function bindWindowResize(
    handle: HTMLElement, signal: AbortSignal,
    direction: ResizeDirection,
    onGeometry: (next: Geometry) => void,
    read: { geometry(): Geometry; state(): WindowState },
): void;
```

`applyResize` 的完整映射(角 = 两轴并集):

```text
east  : w += dx
south : h += dy
west  : x += dx ; w -= dx
north : y += dy ; h -= dy
se = east + south      nw = north + west
ne = north + east      sw = south + west
```

绑定实现**必须**复用 `ui/shared/dragGesture.ts`:

```ts
bindDragGesture(handle, signal, {
    // 最大化/全屏态下缩放无意义(几何由 CSS 类接管),直接不起手.
    canStart: () => read.state() === 'normal',
    onStart: () => {},
    onDelta: (dx, dy) => onGeometry(applyResize(read.geometry(), direction, dx, dy)),
    onEnd: () => {},
});
```

三条注意:

1. `canStart` 用**状态**判断,不要用"元素上有没有某个类"判断--状态是唯一
   真相源(§3.1).因此 `read` 里必须有 `state()`,`WindowManager` 也要把它
   暴露成公开方法(§4.5);`direction` 由调用方绑定手柄时传入,不从 DOM 属性
   现读.**`read` 里不需要 `limits()`**:夹取统一由调用方在 `onGeometry` 之后
   做一次,本模块不认识上下限.
2. `applyResize` 返回的是**未夹取**的几何,调用方(`WindowManager`)必须过一遍
   `clampGeometry`.这是 §3.4 第 2 条的落地方式:`west` 撞到 `min.w` 时,
   `x` 与 `w` 是同一次 `clampGeometry` 里一起夹的,不会互相推.
3. 手柄的光标由 CSS 给.`bindDragGesture` 起手时读
   `getComputedStyle(handle).cursor`,所以 `css/window.css` 里八根手柄的
   `cursor` **一条都不能少**;少了不会报错,只是拖动时鼠标不变形.

### 4.4 `WindowFrame.ts`(声明式建结构)

```ts
export interface WindowFrameSpec {
    readonly id: string;
    readonly title: string;
    // 现成节点按槽位分组;词表 `WindowSlot` 与 UI_CONFIG.window.adopted 是同一套.
    // 缺省槽位 = 不搬节点(E33).
    readonly slots: Partial<Record<WindowSlot, readonly Child[]>>;
    readonly controls: readonly WindowActionButton[];  // 由 UI_CONFIG.window.actions 生成
    readonly geometry: Geometry;               // 建好即刻写入行内样式
}
export interface WindowActionButton {
    readonly id: 'minimize' | 'maximize' | 'fullscreen' | 'close';
    readonly label: string;
    readonly glyph: string;
    readonly onClick: () => void;
}
export interface WindowFrameHandle {
    readonly element: HTMLElement;
    readonly title: HTMLElement;   // 拖动起手元素
    readonly body: HTMLElement;
    readonly handles: readonly { readonly direction: ResizeDirection;
                                  readonly element: HTMLElement }[];
    readonly controls: ReadonlyMap<string, ButtonHandle>;
    dispose(): void;
}
export function createWindowFrame(spec: WindowFrameSpec): WindowFrameHandle;
```

装配顺序(照 §5.4 的 DOM 契约):

```ts
const element = el('section', { class: 'window', attrs: { 'data-window': spec.id } });
element.tabIndex = -1;
element.hidden = false;               // 由状态类控制显隐,不用 hidden
writeGeometry(element, spec.geometry);   // 立即写,避免一帧闪在左上角;见下面的"唯一写入形状"

const title = el('span', { class: 'window-title' },
    el('span', { text: spec.title }), ...(spec.slots.title ?? []));
const actions = el('div', { class: 'window-actions' }, ...(spec.slots.actions ?? []));
const controls = el('div', { class: 'window-controls' },
    ...spec.controls.map(c => createButton({ class: 'window-control-btn', text: c.glyph,
                                             ariaLabel: c.label, title: c.label })
        .also(b => b.onClick(c.onClick)).element));
const header = el('header', { class: 'window-header' }, title, actions, controls,
    ...(spec.slots.overlays ?? []));
const body = el('div', { class: 'window-body' });
element.append(header, body, ...RESIZE_HANDLES.map(direction => {
    const handle = el('div', { class: 'resize-handle', attrs: { 'data-window-resize': direction } });
    return { direction, element: handle };
}));
```

三个必须做的细节:

- **`el()` 不支持 `style`**:几何**只能**经 `writeGeometry()` 逐条
  `style.setProperty` 落地.不要用 `element.style.cssText = ...`--
  `cssText` 赋值会**清空整个行内声明块**,把 `focus()` 写的 `z-index` 一起清掉,
  被拖的窗口会当场掉到其它窗口后面(旧稿就是 `cssText` 写法,见 §11.2 E8).
- **`slots.overlays` 是标题栏里的浮层**(`#example-menu`),它是 `.window-header`
  的直接子节点,不是 `.window-actions` 的(那一层是按钮行).浮层的定位锚点是
  `.window-header`(`position: relative`),且必须在 `.window-body` **之外**,
  否则会被正文的裁切切掉(§11.1 B2).
- **`slots` 里三个槽位的节点是搬过来的,不是重建的**(`#run-btn` 的监听不能丢).
  用 `append` / `replaceChildren` 都要保留节点身份.节点由 `windowChrome.ts` 建,
  经 `UI_CONFIG.window.adopted` 定位,不再来自 `index.html`(E33).

几何的两个 DOM 侧助手(`writeGeometry` / `clearGeometry`)放在 `WindowFrame.ts`
并导出,由 `createWindowFrame` 与 `WindowManager.applyGeometry` 共用;
`geometryStyle`(纯字符串)留在 `WindowGeometry.ts`:

```ts
/** 逐条写四条几何属性.唯一允许的几何落地方式(不碰 z-index). */
export function writeGeometry(element: HTMLElement, g: Geometry): void {
    for (const [name, value] of Object.entries(geometryStyle(g))) {
        element.style.setProperty(name, value);
    }
}

/** 清掉四条行内几何;进入 maximized/fullscreen 前必须调它. */
export function clearGeometry(element: HTMLElement): void {
    for (const name of ['left', 'top', 'width', 'height'] as const) {
        element.style.removeProperty(name);
    }
}
```

### 4.5 `WindowManager.ts`(状态与写入点)

```ts
export type WindowState = 'normal' | 'maximized' | 'fullscreen' | 'minimized' | 'closed';

interface Entry {
    readonly spec: WindowConfigEntry;
    readonly frame: WindowFrameHandle;
    readonly host: HTMLElement;
    /** 唯一几何真相源(普通态);最大化/最小化不改它. */
    geometry: Geometry;
    /** 进入 maximized 前的几何,还原用;首次最大化时写入. */
    restore: Geometry | null;
    state: WindowState;
    /** 每个窗口一份:拖动/缩放的指针监听在它上面 abort. */
    gesture: AbortController;
    /** 该窗口当前的 z-index(`focus()` 写;几何写入**不得**碰它). */
    zIndex: number;
}

export class WindowManager {
    private readonly entries = new Map<string, Entry>();
    private readonly dockButtons = new Map<string, ButtonHandle>();
    private z = UI_CONFIG.window.z.first;
    private focusedId: string | null = null;
    private root: HTMLElement | null = null;
    private dockAbort: AbortController | null = null;
    private geometryListeners = new Set<(id: string) => void>();

    constructor(
        private readonly layer: HTMLElement,   // #window-layer
        private readonly dock: HTMLElement,    // #dock
        private readonly snapPreview: HTMLElement,
    ) {}

    bind(): void;                  // 建 frame + 搬宿主 + 建 Dock + 起初始焦点 + 挂 resize
    focus(id: string, options?: { takeDomFocus?: boolean }): void;   // 唯一抬升入口(§3.2)
    reveal(id: string): void;      // 恢复可见 + focus(id, { takeDomFocus: true })(§3.7)
    getState(id: string): WindowState;   // WindowResize 的 canStart 读它(§4.3)
    getGeometry(id: string): Geometry;
    onGeometryChange(listener: (id: string) => void): () => void;
    onDesktopResize(): void;       // bind() 已挂到 window.resize;留公开入口给测试
    dispose(): void;
}
```

`layer` / `dock` / `snapPreview` 三个容器节点由调用方传入(与 `EditorHighlight`
"节点由装配层取好传入"同一约定),本类不自己去 `getElementById` 找它们;
正文宿主同样由调用方传入(`windowBodies: ReadonlyMap<WindowId, HTMLElement>`,
按 `spec.hostId` 取好的一整张表,见 `app/appHosts.ts`)--**本类完全不碰
`document`**(E34).取不到宿主时仍然抛一条带 id 的错误,不要 `!` 硬断言后让
`frame.body.append(null)` 报一个读不懂的 TypeError;正常路径上这个错误由
`readAppHosts()` 在装配期更早发出.

`bind()` 的顺序(不能换):

```text
0. window.addEventListener('resize', this.onDesktopResize, { signal })  // 旧稿漏了这条
1. desktop = { w: root.clientWidth, h: root.clientHeight }
2. resolved = new Map()
   for spec of UI_CONFIG.window.windows:          // 数组顺序即依赖顺序
       g = resolveDefaultGeometry(spec, desktop, resolved)
       resolved.set(spec.id, g)
3. for spec: createWindowFrame({ ..., slots: content(spec.id), geometry: g })  // slots 里的现成节点在这里被 append
       host = windowBodies.get(spec.id)                 // 取不到就抛带 id 的错
       frame.body.append(host)                          // 宿主是搬过来的,不是重建
       layer.append(frame.element)
       bindWindowMove(id)                               // .window-title 上的拖动
       bindWindowRaise(id)                              // 窗口上 capture 阶段 pointerdown -> focus(id)
       bindWindowResize(每根手柄, id, direction, ...)      // 八向缩放(§4.3)
       applyGeometry(id); applyState(id)                 // 立即写,避免首帧闪在左上角
4. buildDock()      // 每个窗口一个按钮,点击调 focus/reveal/setMinimized
5. focus('source', { takeDomFocus: false })  // 初始焦点必须有一个,否则 z 序没有参照
```

`bindWindowRaise` 是 §3.2 的落地:`pointerdown` 在**捕获阶段**触发,只调
`focus(id)`(默认不夺 DOM 焦点),不 `preventDefault`,不 `stopPropagation`,
所以 `bindDragGesture` 与正文输入框照常收到事件.旧稿的 `bind()` 清单里
没有这一步,"提升规则"写了却没接.

**几何的唯一写入点**:

```ts
private applyGeometry(id: string): void {
    const entry = this.entries.get(id)!;
    // 最大化/全屏的几何由 CSS 类负责(inset:0).这里必须**先清掉四条行内几何**,
    // 因为行内 left/top/width/height 会压过类规则里的 inset:0--不清就是
    // "点了最大化没反应"(旧稿就漏了这一步,见 §11.2 E9).
    if (entry.state === 'maximized' || entry.state === 'fullscreen') {
        clearGeometry(entry.frame.element);
    } else {
        writeGeometry(entry.frame.element, entry.geometry);   // 逐条 setProperty
    }
    for (const listener of this.geometryListeners) listener(id);
}
```

`applyGeometry` **不碰任何类名**:`.window` 上的类(含 `is-maximized` /
`is-fullscreen`)全部由 `applyState` 独占.`clearGeometry` / `writeGeometry`
也只碰 `left/top/width/height` 四条属性--`z-index` 归 `focus()` 独占.
这条是硬约束:旧稿用 `element.style.cssText = geometryToCss(...)` 写几何
(`geometryToCss` 这个助手在落地时一并删除了,见 §11.2 E31),
`cssText` 赋值会清空整个行内声明块,于是拖动第一帧就把 `z-index` 清成 `auto`,
被拖的窗口当场掉到其它窗口后面(§11.2 E8).

**状态的唯一写入点**(与 `PanelController._applyLayout` 同一条理由;
`.window` 上的**每一个类**都在这里写):

```ts
private applyState(id: string): void {
    const entry = this.entries.get(id)!;
    const element = entry.frame.element;
    const hidden = entry.state === 'minimized' || entry.state === 'closed';
    // 三个状态类一起在这里刷新:normal 态全部移除(关闭态不另写类名,
    // 它与最小化在视觉上同一件事,状态只体现在 Dock 的 data-state).
    element.classList.toggle('is-maximized', entry.state === 'maximized');
    element.classList.toggle('is-fullscreen', entry.state === 'fullscreen');
    element.classList.toggle('is-hidden', hidden);
    element.toggleAttribute('inert', hidden);     // 挡 Tab 序与点击
    element.setAttribute('aria-hidden', String(hidden));
    // 最大化 / 全屏两个按钮的文案在对应态要变成"退出",两个入口(按钮/双击)
    // 共用这里;不在这里写,双击最大化后按钮还是"最大化".
    entry.frame.controls.get('maximize')?.setText(
        entry.state === 'maximized' ? '❐' : '▣');
    entry.frame.controls.get('fullscreen')?.setText(
        entry.state === 'fullscreen' ? '⤡' : '⤢');
    // Dock 按钮的激活态与 aria-pressed 也在这里刷新(唯一写入点)
}
```

`toggleAttribute` 是 `src/testing/domStub.ts` 目前**没有**的 API,阶段 0 要
一并补上(§5.2 的 `domStub.ts` 行),否则 `WindowManager.test.ts` 直接抛
"toggleAttribute is not a function".

**焦点与 z**(`focus` 与 `reveal` 的唯一区别就是后者先恢复可见):

```ts
focus(id, options: { takeDomFocus?: boolean } = {}) {
    const e = this.entries.get(id)!;
    if (e.state === 'minimized' || e.state === 'closed') return;   // reveal 才有权改状态
    this.focusedId = id;
    e.zIndex = ++this.z;
    e.frame.element.style.zIndex = String(e.zIndex);   // z-index 只在这里写
    for (const other of this.entries.values())
        other.frame.element.classList.toggle('is-focused', other.spec.id === id);
    // 指针路径默认 false:点了编辑器/输入框就不该被窗口抢走 DOM 焦点.
    if (options.takeDomFocus === true) e.frame.element.focus({ preventScroll: true });
}

reveal(id) {
    const e = this.entries.get(id)!;
    if (e.state === 'minimized' || e.state === 'closed') {
        e.state = 'normal';
        this.applyState(id);        // 先恢复可见
    }
    this.focus(id, { takeDomFocus: true });   // 再抬升并取 DOM 焦点
}
```

**`takeDomFocus` 这个开关不能省**(旧稿的 `focus()` 无条件调
`element.focus()`,与 §3.2/§6 的口径直接矛盾,照抄就会把编辑器光标弄丢):
`pointerdown` 落在正文输入框上时,浏览器的默认聚焦行为会把焦点交给那个
输入框;`bindWindowRaise` 调的是 `focus(id)`(默认 `false`),不干预它.规则是:

- **指针路径**(`pointerdown` 提升,`bindWindowRaise`)只改 z 与类,**不**调
  `element.focus()`;
- **程序路径**(`reveal()`,Dock 点击)才调 `element.focus()`.

`bindWindowRaise` 也**不** `preventDefault`,不 `stopPropagation`--拖动与
正文的默认行为都得原样收到.

**状态转移**(§3.1 那张表的代码化,每个方法都是"改状态 -> `applyState` ->
`applyGeometry`"**这个顺序**):先落地状态类,几何写入再按新状态决定"写四条
行内属性"还是"清掉它们";反过来虽然也能出正确结果,但中间会有一帧
`is-maximized` 已加,行内几何还没清的过渡态,不值得冒.

```ts
setMinimized(id, minimized: boolean): void
    // 进入:state='minimized';focusedId 交给可见窗口中 z 最高者,没有则 null
    // 退出:state='normal';geometry 不变;然后 focus(id, { takeDomFocus: true })
setMaximized(id, maximized: boolean): void
    // 进入:restore ??= geometry;state='maximized'
    // 退出:geometry = restore ?? geometry;state='normal'
setFullscreen(id, on: boolean): void
    // 同 setMaximized,但用 'fullscreen';从 maximized 进 fullscreen 时
    // restore **不覆盖**(否则退出全屏会回到全屏尺寸而不是最大化前的尺寸)
setClosed(id, closed: boolean): void      // 与 setMinimized 同形,state 用 'closed'
setGeometry(id, next: Geometry): void     // 过 clampGeometry,写回 entry.geometry
onDesktopResize(): void                   // 重算 desktop,所有 normal 窗口重新夹取;
                                          // maximized/fullscreen 只需重算 CSS 类
```

`bind()` 里已经用同一个 `AbortController` 把 `window.resize` 挂到
`onDesktopResize`(见 `bind()` 第 0 步),`dispose()` 随 signal 一起摘掉;
`DslApp.onResize` 不需要改--它继续只负责 `renderController.resize()`.
把这条监听放进 `WindowManager` 而不是 `DslApp`,是因为"重新夹取"要用到
桌面尺寸与五个窗口的几何,那些状态只在这里.

`dispose()`:对每个 entry `gesture.abort()` + `frame.dispose()` +
把宿主**还回 `#app`**(不是留在已删除的窗口里).最后清 `entries` /
`dockButtons` / `listeners`,`dockAbort.abort()`.

**宿主归还**这一条容易漏:`dispose()` 之后 `DslApp.dispose()` 可能再被调一次,
而 `#dsl-editor` 等节点还在窗口层的 DOM 里(虽然 `#window-layer` 由本类建,
但 `index.html` 里没有它们的备份).做法是把宿主塞回 `this.root`(`#app`)末尾,
与 `PanelController.dispose()` "先把 DOM 复位再丢状态"是同一条约定.

### 4.6 CSS 归属与必须搬动的规则

改动清单见 §5.2(`css/*.css` 那几行),这里只写**规则去哪**这个容易搞错的部分:

| 规则 | 现状 | 去向 |
| --- | --- | --- |
| `#viewport { position:absolute; inset:0; z-index:0 }` | `layout.css` | `css/window.css`(它现在是"窗口层的底"),或留在 `panels.css` |
| `.panel { position:absolute; z-index:10; display:flex; flex-direction:column; background/border/box-shadow; overflow:hidden }` | `layout.css` | **拆开**:`position/z-index` 删掉(几何归窗口);`display:flex` 等留成 `.window-body > *`;**`overflow: hidden` 也要删掉**(裁切下沉到 `.window-body`);颜色/边框/阴影是否保留取决于 §11.1 B8 的拍板(窗口外壳已有一层边框/阴影,两层会叠) |
| `#left-panel / #right-panel / #bottom-panel` 的 `top/left/right/bottom/width/height` | `layout.css` | 全删(几何由 JS 写).`#right-panel` 整个删除(B6) |
| `.panel.collapsed *` | `layout.css` + `panels.css` | 全删(折叠语义不存在了) |
| `.resize-handle` + `.resize-handle-{right,left,top}` | `layout.css` | 基类保留并搬到 `css/window.css`,三条方向类删除;新增八条 `[data-window-resize="..."]` 的 `cursor` 与命中区 |
| `#app { --left-panel-width ... }` 与 `:root` 的 `--side-default-width` 等 | `base.css` | 全删(B7) |
| `.window-header` / `.window-body` / `.window` / `.window-controls` / `.window-actions` | 新 | `css/window.css`.`.window { overflow: visible }`,`.window-body { overflow: hidden }`(B2) |
| `#right-tabs` 全部规则,`.right-page[hidden]` | `panels.css` | 删除 |
| `.example-menu` 的锚点与 `max-height` | `panels.css` | 浮层节点从 `#left-panel > .panel-header` 移进 `.window-header`(见 §11.1 B2),锚点改成 `.window-header`(`position: relative`),`max-height` 改按窗口正文高度算(E5) |
| `#snap-preview` | 新 | `pointer-events: none` + `aria-hidden`(漏了它会挡住桌面拖拽) |
| `.window-header` 的高度 | 新 | `height: var(--window-header-height)`,由 `applyUiConfig` 从 `UI_CONFIG.window.headerHeight` 写入(唯一副本) |

`css/window.css` 是新文件,**必须加进 `cssPalette.test.ts` 的 `CSS_FILES`**
(§5.5 硬约束 1),否则新文件里的颜色不受色板约束.

---

## 5 代码结构与新增文件

### 5.1 新增

```text
src/ui/desktop/
  WindowGeometry.ts       纯函数(无 DOM):x/y/w/h 的夹取,最大化/还原,吸附判定
  WindowFrame.ts          声明式建窗口外壳(标题栏/正文/八根缩放手柄),返回句柄
  WindowResize.ts         八向手柄 -> "方向 + 增量 -> 几何改变"的解释(纯逻辑)
  WindowManager.ts        窗口注册表 + 状态机 + z-order + 焦点 + 几何写入
  SnapPreview.ts          吸附高亮层的显示/隐藏
  Dock.ts                 Dock 的装配与点击分派(调用 WindowManager)
  *.test.ts 与实现同目录    (沿用现有"测试与实现同目录"的约定)
css/window.css            桌面层 / 窗口外壳 / .resize-handle 与八向光标 / Dock / 吸附高亮 / 全屏态
```

**这一批新文件里没有"拖动实现"**:拖动仍然只有
`src/ui/shared/dragGesture.ts` 一份,窗口拖动与八向缩放都是它的消费者
(前者起手元素是 `.window-title`,后者是八根 `[data-window-resize]` 手柄).
`WindowFrame.ts` 只负责把结构建出来,把 `[data-window-resize]` 手柄放好;
真正的绑定由 `WindowManager` 在建完 frame 后调用 `bindWindowResize()` 完成,
与"`PanelController.bind()` 才挂 [`data-resize-panel`] 手柄"是同一时序.

**文件按它建的那个东西命名,不按比喻命名**.所以是 `WindowFrame.ts`(窗口
外壳)而不是 `windowChrome.ts`.

"chrome" 在本仓库已经有两个所指:`src/ui/examples/replaceEditorSource.ts`
讲浏览器 Chrome 的插入行为,`src/ui/editor/EditorLineNumbers.test.ts` 讲
measureText 里那 15px 的 chrome(canvas 以外的边距).同一个词再加"窗口装饰"
这一层含义,读代码时要靠上下文猜;而且它和浏览器名字直接撞车,搜索窗口相关
代码会先搜到一堆浏览器注释.同理不用 `WindowUI` 这种没有所指的名字.

> 命名与构造方式的**硬约束**统一写在 §5.3 / §5.4,不只是这一处文件的取舍:
> 窗口化引入的所有新结构都必须走 `el()` 声明式装配.

两个纯逻辑文件(`WindowGeometry.ts` 与 `WindowResize.ts`)刻意**不碰 DOM**:
夹取,吸附,最大化换算,八向解释全部能在单测里穷举边界;`WindowFrame` 只管
建结构,`WindowManager` 只管把结果写进 DOM.这条分工与 `ViewPanel` 只建控件,
不订阅 EventBus 是同一手法:能在单测里穷举的部分不碰 DOM.

### 5.2 修改

| 文件 | 改动 |
| --- | --- |
| `index.html` | 新增 `#window-layer` / `#dock` / `#snap-preview` 三个空宿主(§5.3);面板本体留原处,删三个 `[data-panel-toggle]` 按钮,三根 `[data-resize-panel]` 分隔条,右栏标签栏 `#right-tabs`(§2.2),**"参数区/视图区"分隔条 `#right-splitter`**(§1.2 C14),外层空壳 `#right-panel`(§11.1 B6);**删掉三处面板自带的 `.panel-header`**(W6/B8:两个标题上移为窗口标题,`#example-menu` 与 `#formula-copy-hint` 由 `windowChrome.ts` 建,按 `slots.overlays` / `slots.title` 落位,E33);**把 `#view-controls` 从 `#right-page-params` 里挪出来当独立宿主**(§11.1 B10);`.window` 外壳**不写进 HTML**,由 `createWindowFrame` 建 |
| `css/layout.css` | **删除**.三件事各有去向:`#left-panel` / `#right-panel` / `#bottom-panel` 的绝对定位 -> 窗口几何(§3.1);`.resize-handle` 基类与四向光标规则 -> **`.resize-handle` 类名保留**,连同八向光标一起搬进 `css/window.css`;`.panel` 的底色/边框/阴影 -> `css/panels.css`(或 `window.css` 的 `.window-body > *`).**`.panel` 那条规则搬走时不要带上 `overflow: hidden`**(裁切归 `.window-body`) |
| `css/window.css` | 新增(见上),含保留的 `.resize-handle` 与八向 `cursor`;`.window { overflow: visible }`,`.window-body { overflow: hidden }` 负责裁切(**B2**);`.window-header { height: var(--window-header-height) }` |
| `css/panels.css` | 删 `.panel.collapsed` 组(57–66,830)与 `#right-tabs` 全部规则,`.right-page[hidden]`,**`.right-splitter` 全部规则(156–185)**,**`#params-panel { flex: 0 0 var(--right-split-basis) }` 改成 `flex: 1; min-height: 0`**;示例浮层锚点改 `.window-header`,`max-height` 改按窗口正文算(E5);新增 `.window-body` 的 flex 列与 `.window-body > * { flex: 1; min-height: 0 }`(B5) |
| `css/controls.css` | `#view-controls` 变成视图窗口的宿主:`flex: 1 1 auto` 保留,`min-height: var(--view-controls-min-height)` 保留(窗口太矮时它自己出滚动条);**注释里"高度由分隔条分配"那句要改**(分隔条不存在了) |
| `css/base.css` | **只删不加**:`--side-default-width` / `--footer-default-height` / `--collapsed-*` / **`--right-split-basis`** 与 `#app` 的三个派生变量(`--left/right-panel-width`,`--footer-height`)全部删除(B7,E3,C14).窗口几何**仍不新增 `--window-*`**(窗口是 JS 建的,没有"CSS 首帧"这回事);唯一例外是 `--window-header-height`(§4.1) |
| `css/diagnostics.css` | 高度基准随参数窗口变矮,`max-height: 34%` 是否合适要真机看过再定(B3) |
| `css/editor.css` | **只改高度基准的来源,不改任何对齐规则**(§5.6 的清单).编辑器窗口的正文高度由 `.window-body` 给出,`#editor-panel { flex: 1; min-height: 0 }` 与 `#dsl-editor-box { height: 100% }` 原样保留 |
| `src/config/uiConfig.ts` | `panel` 段**只留** `paramsMinHeight` / `viewControlsMinHeight`(CSS 消费),`splitMinRatio` / `splitMaxRatio` / `splitDefaultRatio` 删除(C14);新增 `window` 段(五个窗口的清单 / 默认几何的锚点描述 / 最小尺寸 / 吸附阈值 / 桌面余量 / 标题栏按钮清单,§4.1 与 E4) |
| `src/ui/theme/applyUiConfig.ts` | 变量映射表**删掉**面板几何那几条(没有 `--window-*` 要写,见 E3)与 **`--right-split-basis`**,**新增 `--window-header-height`** 一条 |
| `src/ui/theme/applyUiConfig.test.ts` | 删面板几何与 `--right-split-basis` 断言,新增 `--window-header-height` 的一致性断言 |
| `src/testing/domStub.ts` | **旧稿漏了这个文件,不补 `WindowManager.test.ts` 跑不起来**:`StubElement` 加 `toggleAttribute`;`StubStyle` 加 `removeProperty`(几何写入用 `setProperty`/`removeProperty`,不再用 `cssText`);`hidden` / `inert` 按属性语义可读回.`getComputedStyle` 只认行内 `cursor` 这条现状不变 |
| `src/app/DslApp.ts` | 见下面的接线清单 |
| `src/ui/panels/PanelController.ts` | **删除**.职责被窗口态吸收:宽度/高度 -> 窗口几何(§3.1),折叠 -> 最小化/关闭(§3.3,§3.6) |
| `src/ui/panels/PanelController.test.ts` | **删除**;两条有价值的断言迁进 `WindowManager.test.ts`(§8) |
| `src/ui/panels/RightPanelTabs.ts` | **删除**(拆页后不存在).两个页容器的 `hidden` 写入点随它一起消失(§11.1 B1) |
| `src/ui/panels/RightPanelTabs.test.ts` | **删除**;两条断言换对象继续守,见 §8 |
| `src/ui/panels/RightSplitController.ts` | **删除**(W6/C14:参数与视图不再共用一栏高度,没有比例可管).`computeSplitRatio` 是它导出的纯函数,一起走 |
| `src/ui/panels/RightSplitController.test.ts` | **删除**.没有替代物:`--right-split-basis` 这个写入点本身不存在了(§8 的"必须保留"清单同步去掉它) |

**`DslApp.ts` 的具体接线**(逐条,照做):

```ts
// 字段
private readonly windowManager: WindowManager;   // 替换 panelController / rightPanelTabs

// 构造函数末尾(在 renderController 之后,节点都已取好)
this.windowManager = new WindowManager(
    document.getElementById('window-layer')!,
    document.getElementById('dock')!,
    document.getElementById('snap-preview')!,
);

// start():窗口装配(标签页与分栏那几行全删)
this.windowManager.bind();          // 建 frame + 搬宿主 + 建 Dock + 初始焦点
// 删:this.panelController = new PanelController(); panelController.bind(...);
// 删:this.rightSplitController = new RightSplitController(); rightSplitController.bind(...);
// 删:this.rightPanelTabs = new RightPanelTabs(...); rightPanelTabs.bind();

// 过程入口:从"切页"改成"抬窗口"(§3.7)
private _openProcess(request: ProcessRequest): void {
    this.windowManager.reveal('process');   // 恢复可见 + 抬升聚焦(唯一入口)
    this.processPanel?.show(request.document);
}

// dispose():与 bind() 配对
this.windowManager.dispose();       // 内含:宿主还回 #app,frame.dispose,gesture.abort
// 删:this.panelController?.dispose(); this.rightPanelTabs?.dispose();

// 窗口尺寸变化后需要重排的视图(目前只有编辑器行号,见 §9 待验点 1)
this.windowManager.onGeometryChange(() => {
    this.lineNumbers.refresh();
    this.editorHighlight.refresh();
});
```

`#example-btn` / `#run-btn` / `#example-menu` / `#formula-copy-hint` **不在这里
搬,也不在 `index.html` 里**:四者由 `ui/desktop/windowChrome.ts` 的
`createWindowChrome()` 用 `el()` 建出来,落点由 `UI_CONFIG.window.adopted`
声明,再由 `windowSlotsProvider()` 解析成 `WindowFrameSpec.slots`(E33).
`ExampleLoaderController` / `FormulaCopyController` 与 `runButton` 拿到的是
**构造参数**(与 `createViewPanel(host)` 同一约定),所以既没有"启动前必须在
文档里"的约束,也没有 `getElementById`.旧稿的"必须在 `new DslApp()` 之前都还
在文档里 + `hidden` 暂存区"随 E25 一并作废.

`DslApp` 的 `window.addEventListener('resize', this.onResize)` **保持不动**:
窗口的重新夹取由 `WindowManager` 自己在 `bind()` 里挂的 `resize` 监听负责
(§4.5 第 0 步),两条监听各管各的,不合并.

**顺序上的两条约束**(错了会在启动时报"缺少结构"或量到 0):

1. `WindowManager` 的**构造**必须在最后(它要用到 `#window-layer` 等宿主);
   但宿主的搬运发生在 `bind()` 里,也就是 `start()` 阶段,那时代码都已经拿到
   了节点引用--所以 `EditorLineNumbers` / `EditorHighlight` 的构造期度量
   (它们读 `#dsl-editor` 的字体)不受影响.
2. `windowManager.bind()` 必须在 `processPanel` 构造**之前或之后都行**
   (`_openProcess` 只在运行时用它,那时 `bind()` 早已完成);但 `processPanel`
   必须在 `start()` 里建完,`KeyboardController` 与 `_openProcess` 都依赖它.
   推荐顺序:`windowManager.bind()` -> `processPanel = new ProcessPanel(...)`,
   `rightSplitController` 那一行整条删除.

### 5.3 构造方式:全程声明式(硬约束)

窗口外壳**不写进 `index.html`**.本项目已经把"结构进 HTML,逻辑进控制器"的
旧做法改成"HTML 只留宿主与默认数据,结构由 `el()` 声明式建出来",窗口化必须
沿用,不能因为它是新代码就退回手写标记.

**准入清单(E33 起生效,"全程声明式"的可判定形式)**.`index.html` 只允许三类
内容,别的节点一律不许出现:

1. **应用外壳与层**:`#app` / `#viewport` / `#window-layer` / `#dock` /
   `#snap-preview`;
2. **五个正文宿主**:`UI_CONFIG.window.windows[].hostId` 指向的元素;
3. **面板本体**:仅当它的默认内容本身是 HTML 文本(`#dsl-editor` 的默认源码,
   以及靠它守住"源码不参与缩进"的那批测试);面板内的结构容器(如
   `#dsl-editor-input`,`#object-panel`)属于本类.

除这三类以外的节点--**包括标题栏动作,浮层,提示**--都在 TS 里 `el()` 建,
以构造参数注入(见 `ui/desktop/windowChrome.ts`),**不用 id 查找**.取节点的
唯一入口是 `app/appHosts.ts` 的 `readAppHosts()`;`DslApp` 与 `WindowManager`
都不再碰 `document`.这条规则有测试守卫:`ui/desktop/desktopHosts.test.ts`
(配置 ↔ HTML),`app/appHosts.test.ts`(HTML ↔ 取节点),
`ui/desktop/windowChrome.test.ts`(节点结构).

现状的两条既有做法(照抄即可):

| 做法 | 现存例子 |
| --- | --- |
| 宿主元素留在 HTML,内容由 `createXxx(host)` 整体装配 | `#view-controls` 留在 HTML,内容由 `createViewPanel` 用 `el()` 建(`ViewPanel.ts` 文件头写明"以前散在 index.html 约 150 行手写 div/label/input/span") |
| 只在 `el()` 表达不了的地方才 `document.createElement` | `evaluationDom.ts:132` 的 `<summary>`(lib.dom 的 `HTMLElementTagNameMap` 没有它),文件内一句注释说明理由 |

**窗口清单是声明式的唯一真相源**,放 `UI_CONFIG.window.windows`:

```ts
window: {
    windows: [
        {
            id: 'source',
            title: 'source code',           // 窗户标题沿用原面板标题(W6)
            hostId: 'left-panel',          // 已存在的元素,原样搬进窗口正文
            dock: { label: '源码' },
            // 默认几何是**锚点 + 夹取**,不是写死的数字:列高与中列宽度
            // 都依赖桌面尺寸,由 WindowGeometry.resolveDefaultGeometry() 算出 px
            // (见 §11.2 E4).锚点的语义只有一条,写在 §4.1 的 AxisSpec 注释里.
            defaultGeometry: { x: { at: 16 }, y: { at: 16 }, w: { at: 420 },
                               h: { fraction: 0.68, of: 'usableHeight' } },
            minSize: { w: 300, h: 220 },
        },
        { id: 'view',    title: '视图',      hostId: 'view-controls',         ... },
        { id: 'params',  title: '参数',      hostId: 'right-page-params',     ... },
        { id: 'process', title: '过程',      hostId: 'right-page-process',    ... },
        { id: 'objects', title: '对象',      hostId: 'bottom-panel',          ... },
    ],                                       // 数组顺序 = Dock 顺序 = 依赖顺序
    actions: [                                // 标题栏上的窗口按钮,顺序即显示顺序
        { id: 'minimize',   label: '最小化', glyph: '─' },
        { id: 'maximize',   label: '最大化', glyph: '▣' },
        { id: 'fullscreen', label: '全屏',   glyph: '⤢' },
        { id: 'close',      label: '关闭',   glyph: '✕' },
    ],
    // 标题栏采用关系:谁,进哪个窗口,哪个槽.节点本身在 windowChrome.ts 里建.
    adopted: [
        { node: 'exampleButton',   window: 'source',  slot: 'actions'  },
        { node: 'runButton',       window: 'source',  slot: 'actions'  },
        { node: 'exampleMenu',     window: 'source',  slot: 'overlays' },
        { node: 'formulaCopyHint', window: 'objects', slot: 'title'    },
    ],
    chrome: { exampleLabel: '示例', runLabel: 'RUN', copyHint: '点击公式复制 TeX' },
}
```

字符字形进配置,不在 TS 里散落**字面量**(与 `UI_CONFIG.view.viewCube` 的
`label` 同一处理;`DOM_ICONS` 那类"TS 里一堆字符常量"的写法不引入).

装配 API 与现有控件同一副骨架(`element` / `get` / `on...` / `dispose`).
**签名只有一份,在 §4.4**;这里只重复三条最容易写错的约定,避免两处签名
各自漂移(旧稿在这节又抄了一份不完全一样的 `WindowFrameSpec`,见 §11.2 E10):

- `createWindowFrame` 建出 `.window` / `.window-header` / `.window-body` /
  八根手柄,并把 `spec.slots` 三个槽位(`title` / `actions` / `overlays`)里的
  **现成节点**原样 append 进去--不是按 innerHTML 重建一份.节点由
  `windowChrome.ts` 建(示例 / RUN / 示例浮层 / 复制提示),落点由
  `UI_CONFIG.window.adopted` 声明,`WindowManager` 只负责转交.
- 正文宿主(`#left-panel` / `#view-controls` / `#right-page-params` /
  `#right-page-process` / `#bottom-panel`)由 `readAppHosts()` 按配置的
  `hostId` 取成一张表,`WindowManager` 收到后 `body.append(host)`;宿主与其全部
  内容一行不改(§1.2).`WindowManager` 不再自己查 `document`(E34).
  `#view-controls` 这一条是 W6 新增的:它原先在 `#right-page-params` 内部,
  现在是**视图窗口**的宿主,必须从参数页里挪出来(§11.1 B10).
- `data-*` 属性统一走 `el()` 的 `attrs`(`el('section', { attrs: { 'data-window': id } })`),
  与 `evaluationDom.ts` / `rowDom.ts` 一致;不用 `innerHTML`,不拼字符串标记.
  唯一允许 `document.createElement` 的地方是 `WindowFrame.ts` 内部若碰到
  `el()` 覆盖不到的标签(现状里没有),且必须像 `evaluationDom.ts` 那样就地
  写明理由.

于是 `index.html` 的改动收成"删三个折叠按钮 + 三根分隔条 + 三层面板 header,
加三个空宿主,把 `#view-controls` 提出来当宿主":

```html
<div id="app">
    <div id="viewport"></div>

    <!-- 新增:窗口宿主层 / 吸附高亮 / Dock(内容由 WindowManager 装配) -->
    <div id="window-layer"></div>
    <div id="snap-preview" aria-hidden="true"></div>
    <div id="dock" role="toolbar" aria-label="窗口"></div>

    <!-- 五个正文宿主留在这里;启动时由 WindowManager 搬进各自的
         .window-body.面板本体内容一行不改,只:
         ① 删三个 [data-panel-toggle] 与三根 [data-resize-panel];
         ② 删三处面板自带的 .panel-header(W6/B8:标题上移为窗口标题);
         ③ 删 #example-menu / #formula-copy-hint(改由 windowChrome.ts 建,E33);
         ④ 把 #view-controls 从 #right-page-params 里提出来(视图窗口宿主) -->
    <aside id="left-panel" class="panel"> ...编辑器... </aside>
    <!-- 右栏原来那层 #right-panel 删除(见 §11.1 B6) -->
    <div id="right-page-params" class="right-page"> ...参数滑块 + 诊断... </div>
    <section id="view-controls"></section>          <!-- 视图窗口宿主 -->
    <div id="right-page-process" class="right-page"> ...过程... </div>
    <footer id="bottom-panel" class="panel"> ...对象列表... </footer>
</div>
```

- 两个 `.right-page` 各自直接进一个窗口正文(**不再包一层 `#right-panel`**):
  它当前唯一的用途就是"共同父节点 + `layout.css` 的绝对定位",窗口化后两者
  都不需要,留着会变成空壳.右栏的内部骨架(`.right-page` 的 `flex` 列,分隔条,
  两个 `min-height`)一个字符都不用改.
- 标签栏 `#right-tabs` 与它下面的"过程/参数"两个按钮整块删除;
  `.right-page[hidden]` 的 `display:none` 规则随之删除(两页不再互相隐藏,
  它们在不同窗口里).
  **注意 B1 的真实情况**:`index.html` 里两个页容器**本来就没有 `hidden` 初值**,
  唯一写它的是 `RightPanelTabs` 自己(构造期 `_applyPages(DEFAULT_RIGHT_TAB)`).
  所以"删 `RightPanelTabs`"这一步本身就消除了全部写入者,不需要去摘一个不存在
  的属性;旧稿把 B1 写成"必须显式摘掉 `hidden`"是不准确的(§11.1 B1 已订正).
  唯一残留风险是 vite 开发态 HMR 不整页刷新时的旧 DOM,刷新即消失.
- **`#example-menu` 与 `#formula-copy-hint` 早已不在 HTML 里**:它们由
  `windowChrome.ts` 建,`adopted` 表把它们分别放进 source 窗口的 `overlays` 与
  objects 窗口的 `title`(E33).旧稿在这一步写的是"从 `.panel-header` 里摘出来",
  那条路径随 `.panel-header` 一起消失.
- **三个面板自带的 `.panel-header` 已按 W6/B8 拍板:全删**.窗口标题栏给出
  `source code` / `参数` / `视图` / `过程` / `对象`,面板里不再留第二层标题
  (`视图` 那条 header 更是直接变成了一个窗口标题).`.panel` 的 border/阴影也
  交给窗口外壳那一层,不再叠两层(§11.1 B8).
- **`#view-controls` 要提出来**:它原先在 `#right-page-params` 内部,是"参数页
  下半块";现在是**视图窗口**的宿主,必须成为 `#app` 下的独立宿主(§11.1 B10).
  `createViewPanel(#view-controls)` 的调用方式不变,变的只是它在树里的位置.

三个要点:

- **`.panel` 为什么仍留在 HTML 而不是也搬进 TS**:`#dsl-editor` 的默认源码
  是 HTML textarea 的文本内容,`editorStyles` / 示例相关那批测试按"源码不参与
  缩进,不搬动"的约定守着它(§7 保留清单).面板本体留在原处,只由 JS 改挂载
  点,是最小改动且不触碰那条约定;窗口外壳这一层**没有**这类约束,所以它必须
  声明式地建.这条豁免就是 §5.3 准入清单第 3 条.
- **宿主节点由谁 append**:`readAppHosts()` 按 `hostId` 取齐五个宿主交给
  `WindowManager`,`bind()` 里 `frame.body.append(host)`.宿主与其内部一切一行
  不改;面板内部的控制器继续用构造参数收节点(`ObjectListController` /
  `ParamPanelController` / `createViewPanel`),`DslApp` 自己不再查 id(E34).
- **删除清单**:三个 `[data-panel-toggle]` 按钮,三根 `[data-resize-panel]`
  分隔条,三处 `.panel-header`,`#right-splitter`,加上 `#example-menu` /
  `#formula-copy-hint` 的**移除**与 `#view-controls` 的**上提**.

窗外壳由 JS 生成带来的一个**新收益**要写清楚:`.window` 之间的层叠关系与
`data-window` 连接全部由注册表给出,`index.html` 里不再有"三个面板的复制粘贴
结构",加窗口只改 `UI_CONFIG.window.windows` 一处.

代价与对策也说清楚:`index.html` 不再能"一眼看出窗口长什么样".对策是
§5.5 的 DOM 契约测试(`WindowFrame.test.ts` 断言结构,按钮,手柄齐全),
以及本节的配置示例本身就是结构文档.

### 5.4 DOM 契约(声明式结构的落地形状)

`createWindowFrame` 产出的结构固定如下,由 `WindowFrame.test.ts` 断言--**这张
表就是标记的真相源**,不在 HTML 与 JS 里各留一份:

```text
section.window[data-window="<id>"][tabindex="-1"][role="region"]
├── header.window-header
│   ├── span.window-title            ← 拖动起手元素(bindDragGesture)
│   │   └── (slots.title:对象窗口放 #formula-copy-hint,其余为空)
│   ├── div.window-actions           ← slots.actions(示例 / RUN,由 windowChrome 建)
│   ├── div.window-controls          ← 最小化 / 最大化 / 全屏 / 关闭
│   └── (slots.overlays:标题栏浮层,如 #example-menu)
├── div.window-body
│   └── <host>                        ← #left-panel / #right-page-params /
│                                       #right-page-process / #bottom-panel
└── div.resize-handle[data-window-resize="n|s|e|w|ne|nw|se|sw"]  × 8
```

吸附高亮**不是**每个窗口里的元素:它是窗口层里的**一个** `#snap-preview`
(§3.5),由 `SnapPreview.ts` 显示/隐藏.旧稿在这张表里画了一个
`div.window-snap`,与 §3.5/§4.5 的构造参数冲突,已删(§11.2 E11).

- **拖动起手就是 `.window-title` 元素本身**,不需要"覆盖整个标题栏的拖动层".
  理由:标题里只有文字(对象窗口多一个只读的 `#formula-copy-hint`,仍然不可点),
  `bindDragGesture` 的 `preventDefault()` 不会踩到任何交互;`.window-actions`
  与 `.window-controls` 是它的**兄弟**而非子节点,天然不在拖动区内,
  `closest('button')` 这类运行期判断可以直接删掉.
- 类名分工:`window-actions` 是**面板动作**(示例 / RUN),`window-controls` 是
  **窗口按钮**(最小化 / 最大化 / 全屏 / 关闭).两者不同名,避免"动作"一词
  同时指两件事.
- **`overlays` 是 `.window-header` 的直接子节点**,不在 `.window-actions` 里
  (那一层是按钮行),更不在 `.window-body` 里(会被正文的 `overflow: hidden`
  切掉,§11.1 B2).
- `tabindex="-1"` 让窗口可被脚本聚焦(`reveal()` 的落点,§3.7),但不进 Tab 序;
  `role="region"` + `aria-labelledby` 指向 `.window-title` 给读屏一个名字.
  窗口化顺手把 `#right-page-*` 的 `role="tabpanel"` 删掉--标签页不存在了,
  留着就是指向空气的语义.
- `.window-body` 是 `display: flex; flex-direction: column; min-height: 0;
  overflow: hidden`(窗口正文的确定高度与裁切都由它给出),里面那个宿主由
  `.window-body > * { flex: 1; min-height: 0 }` 拉满--这是 §11.1 **B5** 的
  一条,漏了宿主会塌成 0 高.
- `.window` 自身 `overflow: visible`(B2),窗口间的层叠靠 `z-index`
  (`focus()` 独占写入),不靠 DOM 顺序.

### 5.5 样式契约(必须遵守现有两条硬约束,外加一条例外)

1. **颜色单一来源**:`css/window.css` 里**不允许**出现任何颜色字面量,一律
   `var(--...)`;新增的窗口专用色(标题栏激活底,吸附高亮)在 `css/base.css`
   的 `:root` 里加 token,并**把 `css/window.css` 补进
   `src/ui/theme/cssPalette.test.ts` 的 `CSS_FILES`**--那个列表是硬编码的,
   漏加等于新文件不受约束,测试不会提醒.这是本方案最容易漏的一步.
2. **几何值单一来源**:窗口几何的真相源是 `UI_CONFIG.window` + `WindowGeometry`
   纯函数,由 `WindowManager` 写成行内样式;**CSS 里没有窗口几何的副本**
   (窗口是 JS 建的,不存在"CSS 首帧",这条与现有 `panel` 的做法刻意不同,
   理由见 §11.2 E3).CSS 只负责 `.window` / `.window-body` / `.resize-handle`
   的样式与光标,不写 `left/top/width/height` 的具体数字.
3. **唯一的例外是标题栏高度**:`UI_CONFIG.window.headerHeight` 经
   `applyUiConfig` 写成 `--window-header-height`,由 `css/window.css` 消费
   (`height: var(--window-header-height)`),并由 `applyUiConfig.test.ts`
   按现有方式锁一致性.理由:`headerMinVisible` 的夹取要用这个数(§3.4),
   而它在 CSS 里也必须可读;放两份却没有守卫,将来改一处会出现"标题栏被
   夹到只剩半行".这与 `--code-gutter-width` 的处理同类,不违反第 2 条
   (那是几何,这是样式常量).

### 5.6 源码高亮层的定位契约(动窗口前必须先读这节)

高亮层是这个项目里**几何最脆**的一块:`textarea` 里的文字是透明的,着色全靠背后
一层绝对定位的 `<pre>`,两者错开一个像素,越往右下越明显.它当年调了很久,而
窗口化恰好会动它外层的每一层容器,所以这里把它靠什么成立写全,并给出"改窗口时
不许碰"的清单.

**五条对齐轴**(前四条在 `css/editor.css`,第五条在 JS):

| # | 靠什么成立 | 位置 |
| --- | --- | --- |
| 1 | 高亮层等于 textarea 的边框盒:`#dsl-editor-highlight { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 0 }`,父层 `#dsl-editor-input { position: relative }` | `editor.css` |
| 2 | 字体/字号/行高/制表位逐项相同,且都取 `--code-*` 变量(唯一真相源 `UI_CONFIG.editor`) | `#dsl-editor` 与 `#dsl-editor-highlight-code` |
| 3 | 内边距相同:`padding: 10px 12px` 两边各写一份 | 同上 |
| 4 | **相邻兄弟选择器**:`#dsl-editor.is-highlighted + #dsl-editor-highlight { display: block }`--高亮层的显隐挂在 textarea 上,靠"紧邻的下一兄弟"选中它 | `editor.css` |
| 5 | 滚动只写 transform:`code.style.transform = translate(-scrollLeft, -scrollTop)`,**禁止**改成抄高亮容器自己的 `scrollTop` | `EditorHighlight.sync()` |

第 5 条的理由在 `EditorHighlight.ts` 文件头写得很具体:两侧 `client` 尺寸天生
差一个滚动条厚度(经典滚动条约 15px),抄 `scrollTop` 会在接近底部时被浏览器
夹住,实测偏差 **15.1px**(约 0.8 行),未夹住时是 0.0px.所以高亮容器永远是
`overflow: hidden` 的裁剪框,不是滚动容器--这一点由
`editorStyles.test.ts` 的一条断言守着.

**窗口化不许碰的东西**:

- **不要动 `#dsl-editor-box` / `#dsl-editor-input` / `#dsl-editor` /
  `#dsl-editor-highlight` 的相互顺序**.第 4 条的 `+` 选择器依赖"高亮层紧跟
  textarea";谁在中间插一个节点,高亮就整层不显示(而不是错位,所以更容易被
  误判成"功能没了").
- **不要把 `#editor-panel` 的 `height: 100%` 改成按内容高**.`#dsl-editor-box`
  的 `height: 100%` 需要一个有确定高度的父;窗口正文给了确定高度,这条链必须
  一路 `min-height: 0`,否则 flex 子项的内容最小高度会把 textarea 撑出窗口,
  高亮层虽然跟着撑,但滚动同步的基准就被破坏了.
- **窗口的隐藏态不能用 `display: none`**.理由不是视觉,是测量:
  `EditorHighlight` 与 `EditorLineNumbers` 在构造期与 `ResizeObserver` 回调里
  都读尺寸,`display: none` 下 `clientWidth/Height` 为 0,行号槽宽与首帧对齐
  会按 0 算.所以最小化/关闭统一用
  `opacity: 0` + `pointer-events: none` + `inert`(挡 Tab 序与点击)+
  `aria-hidden`,布局与尺寸保持有效.
- **不要把 `overflow` 语义往上传**:`#dsl-editor-box` 是唯一负责"圆角 + 裁掉
  textarea 滚动溢出"的一层.窗口正文只需给高度,不要自己加 `overflow: hidden`
  之外的处理(滚动条样式,`scrollbar-gutter` 这类都会改变 textarea 的
  client 宽度,进而改变第 5 条那个 15px 差值).

**要补的测试守卫**(现有 `editorStyles.test.ts` 只锁了"归属"与"高亮层不是滚动
容器"两条,不足以覆盖上面这些):

1. `#dsl-editor-highlight-code` 与 `#dsl-editor` 的
   `font-family` / `font-size` / `line-height` / `tab-size` / `padding` 逐项相等;
2. `#dsl-editor.is-highlighted + #dsl-editor-highlight` 这条选择器存在(第 4 条);
3. `#dsl-editor-highlight` 规则里 `overflow: hidden`,`inset: 0`;
4. 新增的窗口隐藏态规则**不含** `display: none`(扫 `css/window.css`).

第 1,2 条是本次新增的重点:它们把"当年调了很久"的三条经验变成会失败的断言,
而不是继续只活在注释里.

---

## 6 交互细节与边界

| 场景 | 约定 |
| --- | --- |
| 点击窗口正文里的输入框/按钮 | 提升焦点,但**不**夺取 DOM 焦点(不动 `event.preventDefault`),编辑器光标,参数输入框的焦点都保持 |
| 拖动窗口时指针经过其它窗口 | `pointer-events` 只在拖动中的窗口上保留,其余照常;不触发悬停样式 |
| 窗口缩到比正文最小高度还小 | 夹在最小尺寸上,正文内部自己出滚动条(现有 `#params-panel` / `#view-controls` 的 `min-height` 与滚动规则继续生效) |
| 编辑器窗口被缩放 | 高亮层与行号都靠 `ResizeObserver` 补同步,尺寸变化本来就已覆盖;但**必须保证窗口的隐藏态不用 `display: none`**(见下两行) |
| 参数与视图两个窗口 | 各自独立,没有分隔条可拖;参数窗口太矮时 `#params-panel` 自己出滚动条,视图窗口太矮时 `#view-controls` 自己出滚动条(两条 `min-height` 保留) |
| 点条目行末的"过程" | 走 `WindowManager.reveal('process')`(§3.7):被最小化/关闭先恢复,再抬升聚焦;不最大化,不改几何,不碰参数窗口 |
| 示例浮层 | 锚点从 `.panel-header` 移到 `.window-header`;`max-height` 按窗口正文高度而不是 `100vh` 算,避免浮层超出窗口 |
| 窗口最小化后再点 Dock | 回到原几何;若最小化前是最大化状态,回到最大化(`restore` 保留) |
| 最小化 / 关闭后的隐藏方式 | **用 `opacity: 0` + `inert` + `aria-hidden`,不用 `display: none`**(这条是硬约束,理由见 §5.6) |
| 视口 resize | 每个 normal 窗口按比例夹回桌内(不按比例缩放尺寸,只保证不越界);maximized/fullscreen 只需重算类 |
| 小视口(桌面宽度 < 两个窗口最小宽之和) | 夹取函数的 `max(min, desktop)` 兜底,窗口允许互相重叠;不做自动平铺(§9 明确不做) |
| 触屏/触控笔 | 全部走 Pointer Events + `setPointerCapture`,与现有分隔条同一路径,不需要额外适配 |
| 无障碍 | 窗口标题栏的按钮带 `aria-label`;最小化/关闭写 `aria-hidden`;吸附高亮 `aria-hidden`;Dock `role="toolbar"` 且按钮带 `aria-pressed` |

---

## 7 分期

每期都是可独立验收的一小步,前一期不通过不进下一期.

### 阶段 0:几何纯函数 + 测试基建(零 DOM 风险)

**内容**:`WindowGeometry.ts`(夹取 / 最大化换算 / 吸附判定 /
`resolveDefaultGeometry(desktop, spec, resolved)` 锚点换算)+ 单测;
顺手把 `src/testing/domStub.ts` 缺的 API 补上(`toggleAttribute`,
`StubStyle.removeProperty`),否则阶段 1 的 `WindowManager.test.ts` 跑不起来.

**验收**:边界穷举用例全绿:窗口比桌面大,桌面比最小尺寸小,负位移,吸附
阈值开闭,最大化往返几何一致,**以及五个窗口在 1280×800 / 1920×1080 下的
默认几何互不重叠,不越界,且五个窗口的底边线同为 `dH-116`**
(§2.1 的断言是纯函数用例,不需要打开浏览器).两组期望值就是 §4.1 末尾
那张表(注意 `source`/`params` 用 `fraction`,`view`/`process` 用 `after`,
两列的 `y` 相同则 `h` 也相同).

**为何先做**:这一步没有任何 DOM 与样式风险,却把最容易算错的几个公式
(含 E4 的锚点换算)先钉死.后面阶段都是在它之上接线.

### 阶段 1:窗口骨架,Dock 最小版,拆三页与焦点

这一阶段本身拆成三小步,**每步结束后 `npm test` 都必须全绿**;不要一次
把 HTML/CSS/装配层与三个控制器的删除同时改完(旧稿把几件事压成一步,
是这一期最大的返工来源):

```text
1a  包窗口:#window-layer / .window / css/window.css / 拖动 / 焦点 / 几何
    -- PanelController / RightPanelTabs / RightSplitController 暂不删,
       分栏与标签页照旧,五个窗口先按默认几何摆着
1b  拆三页:删 RightPanelTabs 与 RightSplitController,把参数 / 视图 / 过程
    分别进三个窗口(视图窗口用 #view-controls 当宿主),_openProcess 走 reveal()
1c  删 PanelController 与 #right-panel,收掉残留断言
```

**内容**:`#window-layer`,五个 `.window` 包装,`css/window.css`,窗口
标题栏与标题栏上的四个窗口按钮,拖动(标题栏),z-order 与焦点,`WindowManager` 接管
`DslApp` 的装配/释放;**Dock 的"最小版"**(每个窗口一个按钮 + 还原 +
"全部还原",不做吸附/磁吸);**拆三页**(§2.2:删除 `RightPanelTabs` 与
`RightSplitController`,把 `#right-page-params` / `#view-controls` /
`#right-page-process` 分别挂进三个窗口,`_openProcess` 改走 `reveal()`,
并处理 §11.1 的 **B2/B5/B6/B8/B10**);删除 `PanelController`,`#right-panel`
与 `#right-splitter`.**缩放与吸附暂不做**.

**Dock 最小版为什么必须在这一期**:窗口能最小化/关闭,就必须有回来的入口.
旧稿把 Dock 全放到阶段 3,于是阶段 1 的验收句里出现了"可最小化/还原"却
没有任何还原入口--这不是可验收的状态.

**验收**:真机(浏览器)上:五个窗口可拖动,可提升,可最小化/还原;**关掉
任意窗口后能从 Dock 恢复**;空桌面处能转 3D 视角;编辑器输入/行号/高亮/参数
联动全部照常;**示例菜单能完整展开而不被窗口切掉**(B2);**参数 / 视图 / 过程
三个窗口打开后都有内容**;从对象列表点"过程"能让过程窗口可见并到最前;
`npm test` 与 `npm run typecheck` 全绿.

**高亮层是这一阶段的红线**:编辑器窗口是唯一"内容对容器几何敏感"的窗口,
`editorStyles.test.ts` 与 `EditorHighlight.test.ts` 必须保持绿;它们一红就说明
动到了 §5.6 的五条对齐轴,先回退那一步再继续,不要在红的基线上往下走.

**为什么把"拆页"放进阶段 1 而不是单独一期**:拆页本身就要求窗口已经存在
(三页要各有各的窗口),而 `RightPanelTabs` / `RightSplitController` /
`PanelController` 又各有共享的断言文件(§8),分几次动反而要动几遍测试.
按上面的 1a/1b/1c 走,这一阶段结束后**新旧结构就切换完毕**,后面几个阶段
都只是加交互能力.

**风险**:这是唯一会同时触到 HTML/CSS/装配层的阶段,最大风险是"某个控制器
拿不到节点".缓解就是上面的 1a/1b/1c:先只改 DOM 包装与样式,一次性跑通
`DslApp` 的全部入口,再开始拆三个旧控制器.

### 阶段 2:调整窗口大小 + 最大化/全屏

**内容**:把三根 `[data-resize-panel]` 换成八根 `[data-window-resize]`,
`WindowResize.ts`(纯几何解释),最大化与单窗口全屏态,`resize` 时的夹取.
机制仍走 `bindDragGesture`(§3.4),不新写手势实现.

**验收**:每个窗口八个方向都能拖动且夹在最小尺寸上;西/北方向拖动时窗口
"左边跟着走"而不是只往右长;**最大化/全屏真的铺满**(进入这两种态时四条行内
几何必须被清掉,否则行内属性压过 `.is-maximized { inset: 0 }`,表现为
"点了没反应",见 §11.2 E9);最大化->还原的几何与最大化前逐像素一致;
全屏按 `Esc` 能退出;窗口标题栏在任何拖动下都没被拖出桌顶;
`WindowResize.test.ts` 的纯函数用例全绿.

### 阶段 3:吸附与磁吸

**内容**:`SnapPreview.ts`,半屏/最大化吸附,窗口间磁吸;Dock 在这一期只补
"吸附预览"与焦点联动,按钮与"全部还原"在阶段 1 已经做完.

**验收**:拖动到左/右/上边缘的预览与落地结果一致;磁吸不会在窗口之间反复
抖动;预览层不拦截指针(`pointer-events: none`).

### 阶段 4:收尾与回归

**内容**:`PanelController` / `RightPanelTabs` / `RightSplitController` 残留清理
(含 `#right-tabs`,`#right-splitter`,`--right-split-basis`,
`.right-page[hidden]` 的样式回收),`css/layout.css` 删除,文档与 README
同步(布局章节,`UI_CONFIG` 章节,`docs/equation-solving-process.md` 的
"右栏标签页 / 参数区与视图区"口径--那两处的前提都被 W6 推翻了),测试补齐
(§8),真机回归(§9).

### 阶段 5(暂缓,W3):键盘窗口管理

设计先记下,一期不实现:

- 进现有 `KeyboardController` 的**唯一键盘出口**,不另绑 `keydown`.
- 建议绑定:`Alt+方向键` 把焦点窗口按磁吸步长移动;`Alt+M` 最小化,
  `Alt+Enter` 最大化,`Alt+F` 单窗口全屏,`Alt+Tab` 在可见窗口间轮换焦点,
  `Alt+1..5` 直取五个窗口(source code / 视图 / 参数 / 过程 / 对象);`Esc` 退出全屏
  (这条一期就要做,它属于全屏的出口而不是窗口管理).
- 前提是先定义"窗口快捷键是否在编辑器获得焦点时生效"--`KeyboardController`
  现在对 textarea 有明确的键位策略,窗口快捷键必须与它对齐,否则 `Alt+方向键`
  会和文本导航打架.

---

## 8 测试清单

**新增**:

| 文件 | 锁什么 |
| --- | --- |
| `src/ui/desktop/WindowGeometry.test.ts` | 夹取边界,最大化往返,吸附判定(纯函数,穷举);**五个窗口在两组视口下的默认几何:x 不重叠,不越界,底边线同为 `dH-116`,两条 `after` 的左右列对称**(§4.1 的期望值表) |
| `src/ui/desktop/WindowFrame.test.ts` | **DOM 契约**(§5.4):`.window` / `.window-header` / `.window-title` / `.window-actions` / `.window-controls` / `.window-body` / `role="region"` / 八根 `[data-window-resize]` 齐全;传入的既有节点(`#run-btn`,`#example-menu`,`#formula-copy-hint`)是**被搬进去**而不是被重建,且 `#example-menu` 落在 `.window-header` 而不是 `.window-body`,`#formula-copy-hint` 落在 `.window-title`;窗口按钮的 `aria-label` 来自 `UI_CONFIG.window.actions`.这条测试是"标记真相源在 TS"的守卫 |
| `src/ui/desktop/WindowManager.test.ts` | 焦点/z-order 单调;**拖动(几何写入)不会清掉 `z-index`**(拖动一帧后 `style.zIndex` 仍是焦点值,§11.2 E8);**进入 maximized/fullscreen 会清掉四条行内几何**,退出时按 `restore` 写回(§11.2 E9);最小化->还原回原几何;关闭后 `aria-hidden`/`inert` 与 Dock 态;五种状态转移的分支;`focus(id)` 默认不夺 DOM 焦点,`reveal()` 才夺(§3.2);`reveal()` 对被最小化/关闭的窗口先恢复再抬升,对可见窗口只抬升;`dispose()` 复位并把宿主还回 `#app`(照搬 `PanelController.test.ts` 的桩式写法,它已经证明 `bindDragGesture` 能在 DOM 桩里完整走一遍拖动,包括给手柄手工写 `style.cursor`) |
| `src/ui/desktop/WindowResize.test.ts` | 八个方向的"增量 -> 几何改变"解释(纯函数),以及**西/北方向同时动 `x/w`**,单轴方向只动一条,角 = 两轴之并这三条;`canStart` 在 `state !== 'normal'` 时返回 false(用桩的 `getState`);最小尺寸与 `EDGE_KEEP` 夹取 |
| `src/ui/desktop/Dock.test.ts` | Dock **五个**按钮由清单生成(不是手写),顺序与 `UI_CONFIG.window.windows` 一致;按状态分派的点击语义;激活态跟随焦点 |
| `src/ui/editor/editorStyles.test.ts`(扩写,不是新建) | §5.6 的四条新守卫:高亮层与 textarea 的 `font-*`/`line-height`/`tab-size`/`padding` 逐项相等;`#dsl-editor.is-highlighted + #dsl-editor-highlight` 相邻兄弟选择器存在;`#dsl-editor-highlight` 是 `inset: 0` + `overflow: hidden`;`css/window.css` 的隐藏态不含 `display: none` |
| `src/ui/desktop/desktopHosts.test.ts`(新建,可选但推荐) | 纯文本解析 `index.html`:每个 `UI_CONFIG.window.windows[].hostId` 都能在 HTML 里找到对应 id 且只出现一次,`index.html` 里**没有任何 `.window` 结构**,标题栏四个应用节点与 `#window-staging` 都不在 HTML 里(E33).这是一条不需要浏览器的守卫,堵住"配置与 HTML 漂移"(§11.1 B9) |
| `src/app/appHosts.test.ts`(新建,E35) | 把 `index.html` 的 id 集合造成桩树,断言 `readAppHosts()` 不抛(HTML 够不够),五个正文宿主 key 与配置一致,缺一个宿主就抛带该 id 的错误 |
| `src/ui/desktop/windowChrome.test.ts`(新建,E33/E34) | 四个节点按 `ChromeNodeId` 建齐,文案来自 `UI_CONFIG.window.chrome`,`Popover` 需要的 aria 配对成立,`windowSlotsProvider()` 的输出与 `adopted` 表一致 |

**改写**:

| 文件 | 改动 |
| --- | --- |
| `src/ui/panels/PanelController.test.ts` | 删除;其中"折叠态只有一个状态源 + 一个写入点""`dispose` 先复位 DOM"两条**有价值的断言迁进 `WindowManager.test.ts`** |
| `src/ui/panels/RightPanelTabs.test.ts` | **整份删除**(`RightPanelTabs` 不存在了).其中两条断言换个对象继续守:页容器不写 `hidden` 初值 -> 归到上面那条 `index.html` 解析测试("没有 `.window` 结构" + hostId 存在);`.panel.collapsed #right-tabs` 的隐藏清单 -> 改成"`.right-page` 不再有 `[hidden]` 规则"(防止有人把标签页逻辑残留下来) |
| `src/ui/panels/RightSplitController.test.ts` | **整份删除**(W6/C14:参数与视图已经拆成两个窗口).没有替代物可迁:`computeSplitRatio`,`--right-split-basis`,`#right-splitter` 三者一起消失.要防的是"有人把分栏逻辑加回来",归到上面那条 `index.html` 解析测试(断言 `#right-splitter` 与 `data-split-page` 都不存在) |
| `src/ui/process/ProcessPanel.test.ts` | `refreshEcho()` 的触发点从"切回过程页"变成"参数值变化",需要确认它现在按哪个入口测(§3.7 第三条) |
| `src/ui/theme/cssPalette.test.ts` | `CSS_FILES` 加 `window.css`,删 `layout.css` |
| `src/ui/theme/applyUiConfig.test.ts` | 删掉 `--side-default-width` / `--footer-default-height` / `--collapsed-*` / **`--right-split-basis`** 那批断言与 `base.css` 兜底一致性检查(几何不再走 CSS,见 E3/C14);**新增 `--window-header-height` 的一致性断言**;`UI_CONFIG.panel` 里只剩两个最小高度,`split*` 的上下限顺序断言随之删除 |
| `src/testing/domStub.ts` | **必须扩写**(旧稿没列):`StubElement.toggleAttribute`;`StubStyle.removeProperty`;`hidden` / `inert` 属性可读回.不补的话 `WindowManager.test.ts` 连第一次 `applyState` 都过不去 |

**必须保留,且新加入"不许变红"清单的既有契约**:

- `src/ui/editor/editorStyles.test.ts`(编辑区样式归属 + 高亮层不是滚动容器)与
  `src/ui/editor/EditorHighlight.test.ts`(滚动同步 / 结构缺失即报错).这两条
  是高亮层唯一的自动守卫,窗口化把它们从"重要"升级为"阶段 1 的红线":它们一红
  就说明动到了 §5.6 的东西,必须先解决再继续.
- `widgets.test.ts`,以及全部 WASM 相关的解析/编译/渲染测试.
  (`RightSplitController.test.ts` 不在此列:它随控制器一起删除,见上面的"改写"表.)

### 8.1 测试策略:什么能靠单测,什么只能真机

**必须写清这条,否则会写出注定失败的"布局测试".** 本仓库的单测跑在自制的
DOM 桩(`src/testing/domStub.ts`)上,它**不解析样式表,不做布局**:
`clientWidth` / `clientHeight` / `offsetWidth` 拿不到真实值,`getComputedStyle`
只反射元素上**行内**写过的属性(`domStub` 里 `getComputedStyle` 的替身只认
`element.style.cursor`,这就是 `PanelController.test.ts` 要在桩里手工
`handle.style.cursor = 'ew-resize'` 的原因).

两个前提要在阶段 0 先补:①桩现在**没有** `toggleAttribute`(`applyState` 必用)
与 `removeProperty`(几何清空必用);②几何一律走 `setProperty` /
`removeProperty`,**不要**用 `style.cssText`--`cssText` 在真 DOM 里会清空整个
行内声明块(把 `z-index` 一起清掉),在桩里也只是一个普通属性,两条路都不可断言.

所以分工是:

| 能靠单测(而且应当写) | 只能真机 |
| --- | --- |
| `WindowGeometry` / `WindowResize` 的全部算术:夹取,最大化,吸附判定,锚点换算,八向映射(纯函数,穷举边界) | CSS 是否真的让 `.window` / `.window-body` / 宿主填满高度(B5) |
| 状态机:五态转移,`restore` 往返,`reveal()` 的"先恢复可见再抬升",`focus(takeDomFocus)` 的两条路径,焦点下移,z 单调递增 | 编辑器高亮层与行号的对齐(§5.6) |
| DOM 契约:标题栏/正文/八根手柄齐全,`overlays` 落在标题栏,既有节点是搬进来的 | flex / `min-height: 0` / `overflow` 的实际表现 |
| Dock 按钮由清单生成,激活态跟随焦点 | 吸附预览的观感,拖动跟手性 |
| `classList` / `aria-*` / `inert` 的写入,以及四条几何属性(`applyState` / `applyGeometry` 断言类名与 `style.getPropertyValue('left'/'top'/'width'/'height')`;`z-index` 由 `focus` 写,拖动后仍应存在) | `cursor` 是否八向都对(桩不解析 CSS) |

**拖动路径可以在桩里跑**:`PanelController.test.ts` 已经证明
`bindDragGesture` 能在桩里走完整套(桩实现了 `setPointerCapture` 的重定向语义,
move/up 只在捕获元素上触发).所以 `WindowManager.test.ts` 里"拖标题栏移动
窗口""拖东边手柄变宽"这类用例**可以**写,做法与那个文件完全一致,包括**给
手柄手工写 `style.cursor`** 这一步.

**不要**写"窗口宽度等于 420"这类断言:桩里量不到布局,这种断言只能靠
`UI_CONFIG` 自己对自己,是假测试.默认几何的正确性交给 `WindowGeometry` 的
纯函数用例(§7 阶段 0 的验收里已经包含 1280×800 / 1920×1080 两组).

---

## 9 验收与核对项

**真机回归清单**(浏览器,建议 1280×800 与 1920×1080 各一遍):

1. 五个窗口默认几何互不重叠,不越界,**上沿都在顶部任务栏之下**,`view` /
   `process` / `objects` 的**底边线齐平**(`dH - edgeGap`),任务栏不被窗口压住.
2. 空桌面处拖拽转视角,滚轮缩放,右键平移全部照常(证明 `pointer-events`
   分层没做错).
3. 编辑器:**高亮层逐项核对**(这是本方案最该慢慢看的一条,方法见下)--
   输入任意多行,把编辑器窗口拖到很窄与很高,拖动正文/缩放到出现横纵滚动条,
   滚到最底部与最右端,然后确认:着色文字与光标/选区始终重合(尤其**右下角**,
   当年那 15.1px 的偏差就是在那里暴露的);行号与源码行严格对齐;IME 候选框
   贴在光标处;示例菜单开合与 `Esc` 关闭,`RUN` 生效.
4. 参数窗口:滑块拖动实时刷新 3D;窗口内只有参数行与诊断区,**没有**分隔条;
   诊断区在窗口变矮时仍能看清错误文本(**B3**).视图窗口单独拖到很矮时,
   视图控件自己出滚动条而不是把窗口撑破.
5. **拆三页**(§2.2):参数 / 视图 / 过程三个窗口**打开后都有内容**;三者可
   同屏;过程窗口能单独拖宽;**参数窗口里没有任何分隔条**(`#right-splitter`
   已删除),`#view-controls` 出现在视图窗口而不是参数窗口里;从对象列表点
   "过程"时,被最小化的过程窗口会先恢复再抬升聚焦,且参数窗口的几何与
   数值不变.
6. **示例菜单完整展开**(B2):点"示例",菜单必须完整可见,不被窗口边缘或
   面板边缘切掉(它有意超出标题栏),滚到底部能选中最后一项;`Esc` 关闭并
   归还焦点.
7. **任务栏不挡手柄**:窗口北边手柄贴在工作区上沿时仍能命中(任务栏那条带自己
   收指针,但它的下沿不压住手柄);全部窗口最小化后任务栏仍可点.
8. 对象列表:两栏,公式 KaTeX 渲染,点击复制 TeX,显隐开关生效.
9. 窗口:拖动,八向缩放(八个方向各试一遍,重点看**西/北**方向是否"看着不动
   右边在跑"),最小化/还原,最大化/还原(双击标题栏与标题栏按钮两条路径都试).
10. 窗口**隐藏后恢复**:最小化再还原之后,编辑器高亮与行号**仍然
    对齐**(这条专门防"用 `display: none` 隐藏导致尺寸量到 0",见 §5.6).
11. 视口 resize(改浏览器窗口大小):窗口不越界,3D 画面不变形
    (`renderController.resize()` 仍被调用).
12. 全部窗口最小化后 3D 仍可操作,任务栏仍在.
13. `index.html` 里**没有**任何 `.window` 结构(窗外壳只在 TS 里);把
    `UI_CONFIG.window.windows` 里某个窗口的 `title` 改一行,刷新后标题栏与
    任务栏文案同时变(证明清单是唯一真相源).
14. 拆页没有留下残留:界面上**没有任何**"参数/过程"标签按钮,
    `#right-tabs` / `#right-panel` / `#right-splitter` 都不出现在 DOM 里,
    两个 `.right-page` 上没有 `role="tabpanel"` 残留,`getComputedStyle` 里
    也没有任何元素在消费 `--right-split-basis`.
15. **标题栏只有一个**(B8):五个窗口各只有一层标题栏,界面上没有"窗口标题
    + 面板标题"两行的重复,也没有两层边框/阴影;`source code` / `视图` /
    `参数` / `过程` / `对象` 五个文案与任务栏上的按钮文案对得上.

**高亮层核对的具体做法**(比"看起来对"更可靠):把开发者工具的 Elements 面板
里 `#dsl-editor-highlight` 与 `#dsl-editor` 并排选中,读各自的盒模型;两者的
`width`/`height` 必须相等(滚动条出现时也只差滚动条本身,而 transform 那条路
正是为此存在).再在 console 里对两个元素各取一次
`getComputedStyle(el).fontFamily/fontSize/lineHeight/padding`,逐项对比.

**需要实测确认的待验点**(写下来是因为它们**可能**需要补丁):

- 窗口尺寸变化后 `EditorLineNumbers` 的行号槽宽是否需要重新量一次:槽宽按
  `--code-gutter-width` 由字体度量得出,**与窗口宽度无关**(1000 行与 100 行
  可能不同,窗口变窄不会不同),所以理论上不需要;但前提是窗口隐藏态没有把它
  量成 0 宽--这也正是 §5.6 要求不用 `display: none` 的原因.若真发现异常,
  `WindowManager.onGeometryChange` 就是给它预留的钩子,接一个
  `lineNumbers.refresh()` 即可.
- **拆页之后**:`#right-page-params` / `#right-page-process` 的父节点从
  `#right-panel` 的 flex 列换成"窗口正文"(`.window-body`),两个 `.right-page`
  的 `flex: 1 1 auto; min-height: 0` 需要在新父节点下仍然生效;`#view-controls`
  的宿主从"参数页下半块"变成"视图窗口正文",它自己的 `flex: 1 1 auto` 与
  `min-height` 也要在新父节点下成立.理论上没问题(`.window-body` 也是 flex
  列且给了确定高度),但这条要在阶段 1 真机确认;若不生效,给
  `.window-body > *` 显式补一条规则(§5.4 已写).

---

## 10 明确不做(一期)

- **视口变成窗口**:3D 视口保持铺满,不参与窗口管理(W1).
- **窗口局部缩放**(`transform: scale`):与命中区域脱节,收益低.
- **界面内容可编辑**:不做参考项目那种 `contenteditable` 编辑模式.
- **布局持久化**:不落 localStorage(W4).
- **键盘窗口管理**:阶段 5(W3).
- **多显示器/多工作区,窗口分组,标签合并,窗口阴影动效体系**.
- **自动平铺**:小视口下允许窗口重叠,不做自动重排.
- **触摸端的双击标题栏**:双击走 Pointer Events 的 `dblclick`,触屏不保证
  触发,可接受(按钮路径始终可用).
- **窗口数量的运行期增长**:一期固定五个窗口(source code / 视图 / 参数 / 过程 / 对象).
  `WindowManager` 的注册表按"可注册多个"设计,但不提供"新建自定义窗口"入口.
- **把过程窗口做成参数窗口的附属面板**(内嵌/抽屉/跟随):两页已经拆开,不再
  引入"主窗 + 从窗"的联动关系,各自独立.

---

## 11 阻碍与订正(动手前先读)

这一节是"做方案的过程中真正查出来的东西",分两类:**必须先在阶段 1 解决的硬性
阻碍**(B 系列),和**方案自己写错,已经在本稿订正的地方**(E 系列).B 系列
每一条都有明确的判据,不解决就会以"某个面板一片空白""浮层被切掉"这种形式
出现,而且不报错.

### 11.1 硬性阻碍(阶段 1 必须先处理)

**B1 两个页容器的 `hidden` 只有一个写入者,就是 `RightPanelTabs` 自己.**

`RightPanelTabs` 在构造期就调 `_applyPages(DEFAULT_RIGHT_TAB)`,写
`#right-page-params` / `#right-page-process` 的 `hidden` 属性.但**`index.html`
里这两个页容器本来就没有 `hidden` 初值**(HTML 刻意不留副本,由
`RightPanelTabs.test.ts` 守着).所以:

- 删掉 `RightPanelTabs` 就消除了全部写入者,**不需要**去摘一个不存在的属性;
- 旧稿把这一条写成"必须显式摘掉 `index.html` 里的 `hidden`,最硬的一条",
  是不准确的(§11.2 E12).它只在 vite 开发态 HMR **不整页刷新**,旧 DOM 残留
  的情况下才会出现,刷新即消失;
- 真正要做的是两件小事:①删 `.right-page[hidden] { display: none }`
  这条规则(页容器不再互相隐藏);②`.right-page` 的 `role="tabpanel"` 也删掉,
  标签页不存在了,留着就是指向空气的语义.

回归清单第 5 项继续测"两个窗口都有内容",这条不变.

**B2 `#example-menu` 必须搬进窗口标题栏,而且窗口层不能裁切.**

浮层由 CSS 定位:`.panel-header { position: relative }` +
`.example-menu { position: absolute; top: 100% }`.它**有意超出标题栏**,盖住
正文.窗口化之后有三件事同时成立才不会坏,缺一件就是"点示例没反应":

1. **节点要搬家**:`#example-menu` 现在在 `#left-panel > .panel-header` 里,
   而窗口化把它画在窗口标题栏下(§5.4).按"面板本体一行不改"照做,它会留在
   窗口正文里,再改 CSS 锚点就直接废掉浮层.做法:阶段 1 把它从
   `.panel-header` 摘出来,经 `WindowFrameSpec.overlays` 挂到 `.window-header`
   (`#example-btn` / `#run-btn` 同理,走 `spec.actions`).
2. **`.window` 不能裁**:如果 `.window` 为了裁掉正文溢出而写 `overflow: hidden`,
   浮层会被**直接切掉**.裁切职责下沉到 `.window-body`,`.window` 保持
   `overflow: visible`.
3. **`.panel` 也不能裁**:`css/layout.css:28` 现在是
   `.panel { overflow: hidden }`.它是浮层的第一道裁切边界,就算 `.window`
   不切,留在 `.panel` 里的浮层也出不去.`.panel` 那条规则搬进 `panels.css`
   时**不要带上 `overflow`**(旧稿只提了 `.window`,漏了这条).

(这一条是核对 `Popover.ts` 与 `layout.css` 之后才确认的:`Popover` 本身**不做
任何定位计算**,它只管 `.is-open` / `aria-expanded` / 点外部关闭 / 焦点归还,
位置全在 CSS 里.所以"窗口化会不会破坏浮层"这个问题,**答案完全取决于节点在
哪棵树里 + CSS 的 overflow 与 position**,而不是 JS.)

**B3 `#diagnostics` 的高度基准会变,需要重新判断.**

`css/diagnostics.css` 给的是 `flex: 0 1 auto; max-height: 34%`,那个 34% 的基准
是 `#right-page-params` 的高度.窗口化后它仍是同一个父节点,所以**不是 bug**;
但参数窗口的默认高度只有约半个桌面(§2.1 的 `0.55`),诊断区从"右栏通高的
34%"变成"半高窗口的 34%",可用行数明显变少.阶段 1 真机看过之后再决定是否
调这个比例或给诊断区一条自己的最小高度(它是错误提示,不该被压到看不见).

**B4 Dock 不能通栏,且窗口底边必须留在 Dock 之上.**

> **后续修订:这条以"任务栏在底部"为前提,现已作废.**任务栏移到顶部且通栏:
> 它占的是工作区之上的预留带(`dockReserve`),窗口几何被夹在它下面,所以不存在
> "窗口手柄压在任务栏底下";与此同时窗口上沿不能进任务栏,这一条由夹取的 `y`
> 下界(`y >= dockReserve`)保证,见文首修订块与 §11.2 E37.下面保留原始记录.

两个条件要同时成立,少一个都会表现为"底边拖不动":

1. Dock 是 `z-index: 200` 的实心条,如果它铺满整个宽度,任何窗口的南边/角部
   手柄只要落在底边就会被它挡住(`pointer-events: auto`).要求:Dock 用居中
   布局且**自身的盒子只占内容宽度**(`display: flex; justify-content: center`
   的容器 + 内容宽度的内层,或直接 `width: fit-content; margin: auto`),
   两侧留出真正可点的桌面.单窗口全屏时 Dock 自动隐藏,这条才不会在最大化
   态下变成"整个底边都拖不动".
2. **窗口默认几何的底边线必须在 Dock 的 100px 之上**(§2.1 规定五个窗口共用
   `dH-116`).Dock 居中,`objects` 也居中,所以只要 `objects` 的底边落进
   Dock 的范围,它的南边手柄就**正好**压在 Dock 底下,第 1 条救不了它.
   旧稿的 `y=dH-292` 就是这个问题(§11.2 E13),已改成 `y=dH-376`.

**B5 宿主移出 `#right-panel` 后,宿主自己的尺寸来源要显式补齐.**

`#right-page-params` / `#right-page-process` 现在是 `#right-panel` 的 flex 子项,
`#view-controls` 是 `#right-page-params` 的 flex 子项,高度都由父级给.搬进
`.window-body` 后需要同时成立,缺一条就塌成 0 高:

| 宿主 | 需要的约束 |
| --- | --- |
| `#left-panel` | `flex: 1; min-height: 0`(它自己是 flex 列容器) |
| `#view-controls` | `flex: 1 1 auto; min-height: 0`(它自己已有 `flex` 与 `overflow-y: auto`,只确认在新父节点下仍生效) |
| `#right-page-params` | `flex: 1 1 auto; min-height: 0`(已有) |
| `#right-page-process` | 同上 |
| `#bottom-panel` | `flex: 1; min-height: 0` |

外加 `.window-body { display: flex; flex-direction: column; min-height: 0;
overflow: hidden }`.这一条已经在 §5.4/§5.6 写过,这里重复是因为它是**最容易被
漏的一条**:漏了不会报错,只是内容高度变成 0,看起来像"面板坏了".

**B6 `#right-panel` 会变成空壳,应当从 DOM 里删掉.**

它当前唯一的用途就是"两个页容器的共同父节点 + `layout.css` 里的绝对定位".
两页各自进窗口之后它既没有内容也没有样式,留着只会让后面读代码的人以为那里
还有布局.做法:把两个 `.right-page` 直接搬进各自的 `.window-body`,
`#right-panel` 从 `index.html` 删除(它没有任何 CSS 之外的引用:全仓库只有
`css/layout.css` 与 `css/base.css` 的注释提到它,`grep` 结果见本节的核对记录).

**B7 `#app` 上那三个派生变量随 `PanelController` 一起删.**

`--left-panel-width` / `--right-panel-width` / `--footer-height` 的唯一写入点
是 `PanelController._applyLayout`,唯一消费者是 `layout.css`.三者一起走.
留着它们会让人以为窗口几何还有 CSS 那一半.

**B8 三个面板自带的 `.panel-header` 与窗口标题栏重复--已按 W6 拍板:全删.**

窗口标题栏给出 `source code` / `参数` / `视图` / `过程` / `对象`,而面板本体里
还各有一层 `.panel-header`:源码面板的 `.panel-title` 是 "source code",底部
面板的是 "对象",参数页里还有一条 "视图".`#left-panel` / `#bottom-panel` 还带着
`.panel` 的 border 与 box-shadow,与窗口外壳会叠成两层.

**拍板(A 案,用户 2026-09)**:这三个文案直接上移为窗口标题,面板自带的那层
`.panel-header` 整个删除;`.panel` 只保留"填满窗口正文"的骨架,底色/边框/阴影
归窗口外壳那一层.于是:

- `#left-panel` 的 `.panel-header` 整块删(示例/RUN 由 `windowChrome.ts` 建,
  落在 `.window-actions`,`#example-menu` 落在 `.window-header`);
- `#bottom-panel` 的 `.panel-header` 整块删(`#formula-copy-hint` 由
  `windowChrome.ts` 建,落在对象窗口的 `slots.title`);
- `#right-page-params` 里的 `<header class="panel-header">视图</header>` 整块删
  (它变成**视图窗口**的标题,而 `#view-controls` 从参数页搬出去,见 B10).

判据:**界面上不能出现两行功能重复的标题,也不能有两层边框/阴影**
(回归清单第 15 项).

**B9 配置里的 `hostId` 与 `index.html` 会静默漂移.**

`UI_CONFIG.window.windows[].hostId` 是一个字符串,装配期要用它换到真实节点.
`index.html` 里删/改名一个宿主,配置不会跟着报错;最坏的情况是某个 `!` 把错误
推迟到运行期,变成 `frame.body.append(null)` 抛一个读不懂的 TypeError.

处理(E34 定稿):取节点只有一处--`app/appHosts.ts` 的 `readAppHosts()` 按
`hostId` 取齐五个正文宿主,取不到就抛一条**带 id** 的错误;`WindowManager` 收
一张已经取好的表,自己完全不碰 `document`.守卫测试三条:纯文本解析
`index.html` 断言每个 `hostId` 都存在(`desktopHosts.test.ts`),用 HTML 的 id
集合构造桩树断言 `readAppHosts()` 不抛且缺一个就报出那个 id
(`appHosts.test.ts`),节点结构归 `windowChrome.test.ts`.这也顺手把"配置是
唯一真相源"从注释变成断言.

**B10 `#view-controls` 要从参数页里搬出来当视图窗口的宿主.**

`#view-controls` 现在是 `#right-page-params` 的第二个 flex 子项(在分隔条与
"视图" header 之后).W6 之后它是**视图窗口**的宿主,必须:

- 在 `index.html` 里成为 `#app` 下的独立宿主(与 `#left-panel` 同级),
  不再嵌在 `#right-page-params` 里;
- `css/panels.css` 里 `#right-page-params` 的注释与任何"参数区占多少,
  视图区占多少"的规则一起清理(C14);
- `createViewPanel(document.getElementById('view-controls')!)` 的调用不变,
  但它的父节点从"参数页"变成"视图窗口正文",`flex` 约束按 B5 检查.
- `#diagnostics` **留在参数窗口**(它是参数/编译诊断,不是视图控件);
  这条要写进 §5.2,别顺手把它一起搬走.

不搬的后果:`WindowManager` 会把整个 `#right-page-params`(含视图控件)塞进
参数窗口,于是"视图窗口"要么是空的,要么两个窗口抢同一个节点--都是静默错.

### 11.2 订正:本方案自己写错的地方

| # | 原稿写的 | 实际情况 | 订正 |
| --- | --- | --- | --- |
| E1 | "`WindowManager` 按 `hostId` 从文档里取宿主";理由写成"两个页容器搬进 `.window` 后不再是 `#app` 的后代" | **理由错了**:`#window-layer` 是 `#app` 的子节点,页容器搬进窗口后**仍然是** `#app` 的后代;`layer.querySelector` 取不到宿主,只是因为取宿主的时机在"把宿主 append 进 frame"**之前** | 结论不变(取宿主走 `document.getElementById`),理由订正为"先取宿主,再 append,那一刻它还没进窗口层".W6 之后 `RightSplitController` 已经删除,不再有"分栏根节点"这一说 |
| E2 | "`#right-panel` 保留,只是不再是窗口本身" | 它会被清空,且 `layout.css` 删除后连定位规则都没了(见 B6) | 从 DOM 删除;两个 `.right-page` 直接进窗口正文 |
| E3 | "默认几何写到 `base.css` 的 `:root` 兜底,`applyUiConfig.test.ts` 锁一致性" | **多此一举**:窗口是 JS 建的,在 JS 跑之前窗口层是空的,"CSS 首帧兜底"没有首帧可兜.而"默认几何 = 视口宽高的函数"本来也无法在 CSS 里表达(见 E4) | 删掉这套兜底与对应断言;默认几何只由 `UI_CONFIG.window.windows` + `WindowGeometry` 的行内样式给出,`WindowFrame` 建完元素,插入窗口层之后立即写几何 |
| E4 | `UI_CONFIG.window.windows` 的 `defaultGeometry` 直接写死 `w/h` 数字 | 右列高度,中列宽度都依赖桌面尺寸(§2.1 的 `dH-116` / `clamp(360, 720, dW-2*436-32)`),写死的数字只能在某一个视口下正确 | 改成**锚点 + 夹取**的描述(`{ x: { at: 16 }, y: { at: 16 }, w: { at: 420 }, h: { from: 'bottom', inset: 116 } }` 这类),由 `resolveDefaultGeometry(spec, desktop, resolved)` 纯函数算出 px;**`from: 'bottom'` 的语义只有一条,写在 §4.1 的 `AxisSpec` 注释里**;这也让默认几何能被阶段 0 的穷举测试覆盖 |
| E5 | `#example-menu` 的 `max-height: calc(100vh - 64px)` | 浮层挂在窗口标题栏下,量的是**视口**高度:窗口比视口矮时浮层会超出窗口(配合 B2 的裁切问题,表现是"菜单被切一半") | 改按参数/所属窗口正文的高度算(`max-height: calc(100% - ...)` 或由 CSS 变量给出窗口正文高度);`panels.css` 那条注释"左面板通高,所以按视口高度留余量"随之作废 |
| E6 | W3 写"列入本文件的设计与阶段 3" | 键盘窗口管理实际排在**阶段 5** | 已订正为阶段 5(本稿早前改过一处,漏了 W3 那一行) |
| E7 | 第 11 章里"把 §3 的状态机与 §3.4/§3.5 的数值当成跨端口径" | 前提是"与桌面端对齐"那一章;该章已按作者要求删除(本次不考虑桌面端) | 整节删除,原来那条"与桌面端分叉"的风险行也一并删掉 |
| E8 | §4.5 `applyGeometry` 用 `element.style.cssText = geometryToCss(...)` 写几何 | `cssText` 赋值会**清空整个行内声明块**,连同 `focus()` 写的 `z-index` 一起清掉--拖动第一帧,被拖的窗口就掉到其它窗口后面;`domStub` 里 `cssText` 也只是个普通属性,断言不到 | 几何改走 `writeGeometry()`(逐条 `setProperty`)与 `clearGeometry()`(逐条 `removeProperty`);`z-index` 归 `focus()` 独占;`geometryToCss` 只留作断言/日志,并写明"不要拿它写 `cssText`"(§4.4/§4.5) |
| E9 | §4.5 最大化的分支直接 `return`,只清 / 切类,不动行内几何 | 行内 `left/top/width/height` **压过**类规则里的 `inset: 0`,所以"点最大化没反应"(代码注释写了要清,代码没清) | 进入 maximized/fullscreen 前先 `clearGeometry(element)`;`.window` 上的类统一由 `applyState` 独占写(§4.5/§3.1) |
| E10 | §5.3 又抄了一份 `WindowFrameSpec` / `WindowManager` API,与 §4.4 不完全一样(有 `handles` 无 `geometry`,`focus(id)` 无选项,构造参数是 `root`) | 同一层结构两份签名,与本文自己"标记只有一份真相源"的硬约束冲突,实现时按哪份都可能 | §5.3 只留三条约定,签名**唯一一份在 §4.4** |
| E11 | §5.4 的 DOM 契约里画了 `div.window-snap`(每个窗口一个吸附高亮) | 与 §3.5/§4.5 冲突:高亮是窗口层里的**一个** `#snap-preview`,由构造参数传入 | 从契约里删掉该节点,改为一句"吸附高亮是层里的 `#snap-preview`";并给 `#snap-preview` 补 `pointer-events: none`(§4.6) |
| E12 | B1 被写成"最硬的一条:必须显式摘掉 `index.html` 上两个页容器的 `hidden`" | `index.html` 从来没写过 `hidden` 初值(由 `RightPanelTabs.test.ts` 守着);写它的只有 `RightPanelTabs` 自己,删掉控制器就消除了全部写入者 | B1 订正为"删规则 + 删 `role=tabpanel`",并说明只在 HMR 残留时才是问题(§11.1 B1) |
| E13 | §2.1 的 `source h=dH-116`(通高)/ `objects y=dH-292`,以及 §4.1 的 `AxisSpec` 没定义 `from:'bottom'` 在 `h` 上的语义 | 同一份 spec 算不出自己给的两组期望值;三处底边线分别是 100 / 116 / 32,`objects` 的底边落进 Dock 的 100px 里(与 B4 冲突,南边手柄必被压住) | 定义唯一语义`该边落在距桌面该侧 inset 处`;所有窗口共用底边 `dH-116`;`objects y=dH-376`;阶段 0 的用例按新表写(§2.1/§4.1) |
| E14 | §4.5 的 `WindowState` 没有 `'fullscreen'`;`focus()` 伪代码无条件 `element.focus()`;`bind()` 五步里没有"pointerdown 提升"与 `window.resize` | 前两条一条编译不过,一条与 §3.2/§6 的核心口径矛盾(照抄就把编辑器光标弄丢);第三条是"规则写了没接线",窗口 resize 后不重新夹取,点窗口不提升 | `window` 态加 `'fullscreen'`;`focus(id, { takeDomFocus })` 默认 `false`,`reveal` 传 `true`;`bind()` 补 `bindWindowRaise` 与 `window.resize -> onDesktopResize`(§3.1/§4.5/§5.2) |
| E15 | §4.3 的 `bindWindowResize` 签名是 `read: { geometry(); limits() }`,实现里写 `read.state()` | 签名与实现不一致;`limits()` 在实现里根本没用;`direction` 在实现里是自由变量 | 签名改为 `(handle, signal, direction, onGeometry, read: { geometry(); state() })`,并写明夹取由调用方做,`limits` 不进本模块(§4.3) |
| E16 | §5.2 的修改清单里没有 `src/testing/domStub.ts`,§8.1 却写"可断言行内 `style.cssText`" | 桩没有 `toggleAttribute`(`applyState` 必用)与 `removeProperty`,`WindowManager.test.ts` 第一次 `applyState` 就会抛异常;`cssText` 也断言不到 | 把 `domStub.ts` 列进修改清单与阶段 0;断言改为四个几何属性 + `z-index`(§5.2/§8/§8.1) |
| E17 | 阶段 1 写"可最小化/还原",但 Dock 整块排在阶段 3 | 阶段 1 没有任何"还原"入口,这一期不可验收 | Dock 的**最小版**(按钮 + 还原 + 全部还原)进阶段 1,阶段 3 只留吸附/磁吸;阶段 1 再拆成 1a/1b/1c(§7) |
| E18 | `UI_CONFIG.window.headerHeight` 注释写"与 css/window.css 一致" | 这是本仓库唯一没有守卫的 TS↔CSS 同值(别的同值都有测试锁),改一处会出现"标题栏被夹到只剩半行" | 改为经 `applyUiConfig` 写 `--window-header-height`,`css/window.css` 用 `var()` 消费,并加一致性断言(§4.1/§5.5) |
| E19 | 全文按"四个窗口"写(§1/§2/§4.1/§5.2/§7/§8/§9/§11/§12),`source` 是通高窗口,`RightSplitController` 被列在"不动的"清单里 | W6 拍板**五个窗口**(`参数` 与 `视图` 也拆开)之后,这些全部失效:通高的 `source` 没有位置给 `view`;参数与视图不再共用一栏高度,分栏控制器与 `--right-split-basis` 没有存在理由;`#view-controls` 必须从参数页里提出来当宿主 | 全文按五个窗口重写:默认几何改成"左列 source/view,右列 params/process,底部 objects"(§2.1),`RightSplitController` / `#right-splitter` / `--right-split-basis` / `UI_CONFIG.panel.split*` 进删除清单(C14),`#view-controls` 列为新宿主(B10),窗口标题取原面板文案(W6/B8 A 案) |
| E21 | §2.1 写"五个窗口共用同一条底边线 `dH-116`",并在 §7 阶段 0 的验收里要求"五个窗口的底边一起断言" | 与 §2.1/§4.1 自己给出的期望值表冲突:`source` 与 `params` 用 `fraction` 取高(0.68 / 0.55),它们的底边在 `dH-116` **之上**(1920×1080 下分别是 672 与 546,不是 964).真正常在底线上的只有 `view` / `process` / `objects` 三个 | 订正为:**三块的下沿共用底线 `dH-116`**,其余窗口的底边必须 `≤ dH-116`(不能进 Dock 的 `dockReserve`).阶段 0 的用例按这条写:`view` / `process` / `objects` 的 `y+h === dH-116`,`source` / `params` 只断言 `≤` |
| E20 | `#formula-copy-hint`(在底部面板 header 里)与 `#example-menu` 只被当成"面板内部元素" | B8 A 案要删掉三处 `.panel-header`,这两条链路的载体正好都在里面:`FormulaCopyController` 要一个节点回显复制提示,`ExampleLoaderController` 要一个浮层容器;删 header 而不安置它们等于静默删功能 | `#example-menu` 走 `slots.overlays` 挂窗口标题栏(B2),`#formula-copy-hint` 走 `slots.title` 挂对象窗口标题(§4.4/§5.4;当时叫 `overlays` / `titleContent`,E34 统一为槽位词汇);两者的控制器与监听不变 |

**实现记录(落地时新增,补在 E 系列之后)**:

| # | 落地时的补充 | 说明 |
| --- | --- | --- |
| E22 | 三层容器的 `z-index` 必须由 `WindowManager.bind()` 从 `UI_CONFIG.window.z` 写成**行内样式** | 只靠 DOM 顺序不行:`#dock` 是 `z-index: auto`,而 `.window` 有正 `z-index`,CSS 的绘制顺序会让窗口整块盖住 Dock(而且点不到).另外 `snapPreview` 取 **50**:吸附预览是"窗口会落到哪里"的底图,画在窗口层(100)之上会盖住正在拖的窗口 |
| E23 | §5.5 第 2 条的"唯一例外是标题栏高度"扩成**三条** | 除 `--window-header-height` 外,还必须有 `--dock-reserve`(`.window.is-maximized` 的 `bottom` 消费,否则最大化盖住 Dock)与 `--window-body-height`(示例浮层的 `max-height` 要按所属窗口正文算,而浮层在标题栏里,百分比解析不到窗口高度,见 E5).三者都由 JS 写入,CSS 只读,数值只有一份(前两条经 `applyUiConfig`,第三条由 `_applyGeometry` 写) |
| E24 | `bindDragGesture` 的 `onStart` / `onDelta` 增加"原始 `PointerEvent`"参数 | §3.5 的吸附判据是"**指针**距桌面边缘 ≤ `SNAP_EDGE`",而拖动件的回调原本只有增量.给回调补上事件是向后兼容的(`onStart: () => {}` 这类实现照旧可编译),因此不需要第二份手势实现 |
| E25 | 四个既有节点(`#example-btn` / `#run-btn` / `#example-menu` / `#formula-copy-hint`)在 `index.html` 里放进一个 `hidden` 的 `#window-staging` 暂存区 | 方案只说"交给窗口标题栏",没说它们在启动前待在哪儿.它们必须在 `new DslApp()` **之前**就在文档里(控制器按 id 取节点),所以先集中在暂存区,`WindowFrame` 建好外壳后原样搬走;搬完由 `DslApp` 摘掉这个空壳,不留一个"看起来还是结构"的空 div(§11.2 E31).**已作废,见 E33**:暂存区整块删除,连"启动前必须在文档里"这个前提一起作废 |
| E27 | 标题栏双击最大化不用 `dblclick`,改判"两次 `pointerdown` 的间隔" | 拖动件在 `pointerdown` 里 `preventDefault()`(为了不选中标题文字),浏览器正是在这一步决定要不要继续派发兼容鼠标事件,`dblclick` 能不能到就成了实现细节;按间隔判定不依赖兼容事件,触屏也成立(§10 原本担心的正是这个).另外"从最大化状态拖出来"改成**第一次真的移动时**才还原:单纯点一下标题栏不该把最大化窗口还原掉 |
| E28 | 删除 `src/ui/widgets/Tabs.ts` 与其测试(`createTabs` 的唯一消费者是 `RightPanelTabs`) | 拆页之后它没有任何消费者,对应的 `.panel-header .tabs` 规则也已随标签栏删除.按本仓库"不留死代码"的惯例一并删除;要恢复标签页控件时从提交历史里取回即可 |
| E26 | `.panel` 只保留"填满窗口正文"的骨架,连 `background` 与 `border-radius` 也不留 | B8 的 A 案要求"不要两层边框/阴影";底色由 `.window` 给,面板再写一遍是看不见的第二份来源 |

| E29 | §4.5 的 `onDesktopResize()` 只写"所有 normal 窗口重新夹取",§3.4 的夹取又刻意允许窗口挂出桌面边缘(`x ≤ dW - edgeKeep`) | 两者合起来的行为是:视口变小之后,右列窗口**大半截留在屏幕外**(1280->1000 时 `params` 仍有 264px 在外面),而 §9 第 11 项要求"视口 resize:窗口不越界" | 新增纯函数 `fitGeometry(g, limits)`:在 `clampGeometry` 之后再尽量把窗口**整体**收进桌内(`x ∈ [0, max(0, dW - w)]`),`onDesktopResize` 与 `restoreAll` 用它.分工写清楚:**拖动**仍按 §3.4 的夹取(允许挂出去,否则"推到边上"做不到),**外部变化**(resize/复位)用 fit |
| E30 | §4.2 写"半屏的高度与最大化一致(减去 `dockReserve`)",但 `resolveEdgeSnap` 的签名里没有 `dockReserve`,`Desktop` 又只有 `bottomReserve = dockReserve + edgeGap` | 照字面实现会算成 `dH - 116`(684),与最大化的 `dH - 100`(700)差 16px,半屏与最大化观感不一致 | `Desktop` 改成直接携带 `dockReserve` 与 `edgeGap`(`usableHeight = h - dockReserve - edgeGap`,数值仍是 `dH - 116`),半屏与最大化都用 `h - dockReserve`;`maximizedGeometry` 后来随"最大化交给 CSS"一起删除了(§11.2 E31) |
| E31 | 落地后复查发现一批**编译得过,单测也全绿**的死代码:`maximizedGeometry` / `fullscreenGeometry`(最大化/全屏其实由 CSS 类接管,这两个函数只被自己的单测调用),`geometryToCss`,`SnapPreview` 的 `is-left` / `is-right` / `is-maximize` 类,`WindowManager` 写的 `.is-closed`,`Dock` 的 `is-normal`,`WindowFrameHandle.setTitle` / `header`,`DockButtonHandle.icon` / `label` / `stateDot`,`DockHandle.element`,以及 `resolveEdgeSnap` 那个"为将来保留"的未用参数 | tsc 只查**文件内**未使用的局部符号:导出成员,只写不读的类名,断头 JSDoc 都照不到.更糟的是它们的单测给出了"这个行为被覆盖"的假象(例如 `maximizedGeometry` 的用例,而真正生效的 `inset` + `--dock-reserve` 反而没被它们守住) | 全部删除;`SnapPreview.show(target)` 只保留 `is-open`;两个句柄只暴露生产代码真正读的成员;`Dock` 的初始状态改走与运行期同一个 `setState` 入口;`geometryToCss` 的"不要写 `cssText`"那条约定改由注释与 `writeGeometry` 的实现守住 |
| E32 | 状态机复查发现三处"真机上多操作几次才出现,且不报错"的问题:①`restore` 还原后不清空,连续两轮"最大化/还原"会把中途挪过的位置丢掉;②`onDesktopResize` 只收 `normal` 窗口,最小化/关闭期间桌面变小,恢复后窗口停在桌外再也抓不回来;③`bind()` 直接写 `resolveDefaultGeometry` 的结果,小视口下 `view` 低于 `minSize`(1280x700 时 159 < 180),`objects` 的 `y` 甚至为负(标题栏被顶出桌顶) | 三者都属**状态序列**与"初始态是唯一例外"的盲区:现有单测只覆盖单次最大化循环与大视口,`clampGeometry` 的文档口径(`y ∈ [0, dH - headerMinVisible]`)在初始布局上根本没被走一遍 | ①进入 maximized/fullscreen 时**无条件**记录 `entry.geometry`,退出时用完即置 `null`;②隐藏态在 `onDesktopResize` 里也走 `fitGeometry`;③`bind()` 的默认几何过 `fitGeometry`.三条各补一条回归用例(`WindowManager.test.ts`),另加"`bind()` 只能调用一次"的守卫 |
| E33 | 标题栏四个节点仍留在 `index.html`:一个 `#window-staging` 暂存区 + `DslApp` 里按 window id 写 if 链的 `_windowContent()` + 一条"这四个 id 还在 HTML 里"的守卫测试 | 四个消费者的**签名本来就是收节点**(`ExampleLoaderController` 收 `{button, menu}`,`FormulaCopyController` 收 hint,`runButton` 是 `DslApp` 自己的),查 id 的只有装配层:同一个 `#example-btn` 在 5 行内被查了两次.也就是说"id 与监听归控制器"这条理由撑不住--**创建点**才是错的,所有权一直很清楚 | 三个节点并入 `ui/desktop/windowChrome.ts` 的 `createWindowChrome()`(用 `el()` 建,文案进 `UI_CONFIG.window.chrome`),以构造参数注入控制器;`index.html` 删掉暂存区,`DslApp` 删掉 if 链与 `window-staging` 摘除;`desktopHosts.test.ts` 的旧守卫反向改成"这四个 id 不许再出现在 HTML 里".`aria-haspopup` / `aria-labelledby` 等静态属性随节点一起搬,`Popover` 独占的状态属性不变 |
| E34 | "谁搬去哪"散在三个文件里:`UI_CONFIG` 只写窗口清单,`WindowFrameSpec` 用 `titleContent` / `actions` / `overlays` 三个平行字段,`DslApp._windowContent()` 用 if 链把它们接起来;槽位词汇在每个文件里各叫一个名字 | 同一件事三处各说一半,加一个标题栏节点要同时改配置示例,spec 字段与 if 链;而且 `titleContent` 按"是什么"命名,`actions` / `overlays` 按"是什么东西"命名,读代码必须来回跳 | 引入唯一的槽位词表 `WindowSlot = 'title' | 'actions' | 'overlays'`(定义在 `uiConfig.ts`,`WindowFrameSpec.slots` 用同一套键),采用关系收成 `UI_CONFIG.window.adopted` 一张表,由 `windowSlotsProvider(chrome)` 一次解析成 provider;`DslApp` 不再参与"谁搬去哪".节点名的强类型由 `WindowChrome = Record<ChromeNodeId, HTMLElement>` 在编译期守住 |
| E35 | `index.html` 里散着 26 处 `document.getElementById`(视口 / 参数面板 / 诊断 / 七个对象列表 / 编辑器四个槽 / 过程面板 / `#app` / 窗口三容器),旁边还有 `WindowManager` 自己按 `hostId` 查宿主 | `!` 非空断言把"HTML 改名或删节点"推迟到运行期的 `Cannot read properties of null`;而 `ui/widgets/dom.ts` 与 `ui/view/ViewPanel.ts` 早就把"id 当全局注册表"写成淘汰做法,窗口化等于在最后一公里把它请了回来 | 新增 `app/appHosts.ts`:`readAppHosts()` 是全应用唯一按 id 取节点的地方,取不到就抛带 id 的错误,五个正文宿主也在这里按 `hostId` 取好交给 `WindowManager`(此后 `DslApp` 与 `WindowManager` 都不碰 `document`);配两向守卫:`desktopHosts.test.ts`(配置 ↔ HTML)与 `appHosts.test.ts`(HTML ↔ 取节点,用 HTML 的 id 集合构造桩树).`index.html` 的准入清单同时写进 §5.3 |
| E36 | §3.6 的 Dock 按钮写"标题 + 状态点",窗口清单里另有一枚 per-window 字形图标(`dock.icon`) | 两个装饰件都不承担信息:①图标(✎ / ◫ / ▤ / ≡ / ☰)与按钮文字同义;②状态点的 5 个分支里,`minimized`/`closed` 与按钮自身的 `data-state` 淡化重复(二者本就行为等价),"`normal`"是恒亮的默认灰点,`maximized` 与"窗口铺满桌面"重复,`fullscreen` 更是**永远画不出来**--全屏时 `#dock` 整条 `display: none`,那条 `background: var(--color-accent)` 没有观测者 | 删掉 `dock.icon` 字段(`WindowConfigEntry.dock` 只剩 `label`)与 `dock-btn-icon` 元素 + CSS;删掉状态点元素,`stateClass()` 函数与 `.dock-btn-state` 四条规则,只保留 `data-state`(CSS 按它写 `opacity: 0.6`).状态表达收敛为按钮自身两态:聚焦 = `.is-active`,最小化/关闭 = `data-state` |
| E37 | §3.1–§3.3/§3.6 的状态机与 Dock:五个状态(`normal`/`maximized`/`fullscreen`/`minimized`/`closed`),四个动作(`minimize`/`maximize`/`fullscreen`/`close`),Dock 贴底且是"内容宽度 + 指针穿透"的浮岛,全屏时整条 `display: none`;外壳尺寸(`--dock-reserve`/`--window-header-height`)由消费者用 `applyTheme` 再传一份 | ①没有真正的进程可关:`closed` 与 `minimized` 都是"藏起来",多一个按钮只是语义重复;②`fullscreen` 与 `maximized` 的差别也只剩"遮不遮任务栏",而任务栏不该被遮;③浮岛的"内容宽度 + 整层 `pointer-events: none`"只服务"两侧要留出能点到的桌面",通栏任务栏不需要;④同一份尺寸被 JS 几何与 CSS 各存一份,改一处忘另一处会出现"窗口盖住任务栏/任务栏下多一条缝",且不报错 | ①`WindowState` 收成 `normal \| maximized \| minimized`,删 `setClosed`/`setFullscreen`/`hasFullscreen`/`exitFullscreen`,`.is-fullscreen` 与 `.is-closed` 系列规则,`Esc` 退出全屏的键盘绑定,Dock 的"退出全屏"按钮与 `is-fullscreen` 隐藏态;②`WindowActionId` 收成 `minimize \| maximize`(`Dock`/`WindowFrame` 的类型同步);③Dock 改成**顶部通栏任务栏**:`.dock` 本身是那个盒子,`WindowManager` 挂载时把 `--dock-reserve`/`--window-header-height` 从 `DesktopConfig` 写到桌面根,`styles/tokens.css` 只留兜底,并加 `theme/tokens.test.ts` 守住三者同值;④`WindowGeometry` 的 y 轴原点改成工作区上沿(`dockReserve`),夹取/收拢/吸附/最大化都从那里量起,顶部吸附阈值改成"任务栏下沿 + `snap.edge`".连带应用侧:`UI_CONFIG.window.dockReserve` 100->40,三处底边 `inset` 116->16(测试逐字断言 tokens.css 与 `UI_CONFIG` 一致,这条改动由它兜住) |

### 11.3 查过但**不是**阻碍的(留个记录,省得再查一遍)

| 看起来可疑 | 结论 |
| --- | --- |
| `Popover` / `ExampleLoaderController` 会不会因为按钮换位置而失效 | 不会.`Popover` 不做定位计算,只认 `trigger` / `panel` 两个节点与 `bind(root)`;只要 `#example-btn`,`#example-menu` 仍在 `#app` 子树内(搬进窗口标题栏后仍在),`.window-header` 给了 `position: relative` 就成立.**前提是浮层节点真的被搬进了 `.window-header`**,见 B2 第 1 条 |
| `#viewport` 的 canvas 会不会盖住窗口 | 不会.canvas 无定位无 z-index,在 `#viewport`(`z-index: 0`)内绘制;窗口层是 100 |
| `createViewPanel` / `ObjectListController` / `ProcessPanel` 会不会拿不到节点 | 不会.`ObjectListController` 用构造参数收容器,`ProcessPanel` 用 `root` 参数,`createViewPanel(host)` 用 `#view-controls` 元素--全都不依赖"节点的父级是谁",只依赖 id 仍在 |
| `EditorLineNumbers` 的槽宽会不会随窗口变窄而变 | 不会.它按**字体度量与最大行号位数**定宽,与容器宽度无关;构造期还先写默认字体再 `refresh`,没有测量顺序陷阱 |
| 参数/视图原来那根分隔条会不会留下残留 | 不会.W6 已把它整条链路(`RightSplitController` / `#right-splitter` / `--right-split-basis` / `split*`)列入删除清单,回归清单第 14 项专测残留 |
| 窗口拖动会不会触发 3D 的 `resize()` | 不会,也不该.`DslApp.onResize` 只挂在 `window.resize` 上;视口始终铺满,不需要跟着窗口动 |
| `#formula-copy-hint` / 对象列表 / 参数滑块 / 视图控件 会不会受影响 | 不会.`#formula-copy-hint` 从底部面板 header 移进对象窗口标题,其余三者在各自窗口的正文里,id 与结构不变;`createViewPanel(#view-controls)` 的调用方式也不变 |

---

## 12 风险登记

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | `#window-layer` 的 `pointer-events` 处理错 | 3D 完全不能转,是 W1 的致命伤 | 分层规则只有一条,阶段 1 的真机回归第 2 项专测 |
| R2 | `PanelController` / `RightPanelTabs` / `RightSplitController` 删除时漏改某个消费者 | 面板不再响应折叠/尺寸,或"模型与 DOM 分叉",或残留一根消费 `--right-split-basis` 的规则 | §1.2 的 C1–C14 表逐条核对;`grep` 清单见该表 |
| R3 | 新增 `css/window.css` 漏进 `cssPalette.test.ts` 的 `CSS_FILES` | 新文件不受色板约束,颜色开始分叉 | §5.5 已写成硬约束;阶段 0 先改测试列表 |
| R4 | 窗口 `hidden` 恢复后编辑器度量到 0 宽 | 行号槽宽错乱 | §8 待验点 1;`onGeometryChange` 是为此预留的挂钩 |
| R5 | 最大化的"全屏高亮"与窗口状态不同步 | 预览与落地不一致,用户困惑 | 吸附判定是 `WindowGeometry` 的纯函数,预览与落地**调同一个函数** |
| R6 | 标题栏拖动与动作按钮争事件 | 按钮点不动,或拖动起不来 | 拖动起手就是 `.window-title`,与 `.window-actions` / `.window-controls` 是兄弟而非父子;不靠运行期 `closest` 判断(§5.4) |
| R7 | 窗口默认几何在小视口下越界 | 首次打开就抓不到某个窗口 | §3.4 的夹取规则 + `bind()` 的 `fitGeometry`(§11.2 E32)+ `resize` 时重算;回归清单第 1 项 |
| R10 | 窗外壳由 JS 建之后,有人"顺手"往 `index.html` 里手写一份 `.window` | 标记有两份真相源,改一处漏一处不报错 | §5.3 的硬约束 + §7 的 `WindowFrame.test.ts` DOM 契约守卫 |
| R11 | 拆页只改了"谁在哪个窗口",漏改"点过程"那条链路 | 点"过程"没反应(窗口被最小化),或悄悄改掉了参数窗口的几何 | §3.7 的三步口径 + `reveal()` 是唯一入口;回归清单第 5 项专测 |
| R12 | 有人把"两页共用一份宽度/一次只看一页"或"参数区与视图区共用一个高度"的旧口径当成仍需维护的约束 | 拆页被当成回退,或又加回标签页 / 分隔条 | §2.2 写明那两条口径的前提都是"右栏只有一份空间",窗口化后前提消失;R24 是它的落地检查 |
| R13 | 窗口化改动了编辑器外层容器,高亮层与 textarea 错位 | **最贵的一类 bug**:文字是透明的,错位直接表现为"编辑不了",而且不容易定位到是哪一层 | §5.6 的定位契约(五条对齐轴 + 不许碰清单)+ 阶段 1 把 `editorStyles.test.ts` / `EditorHighlight.test.ts` 列为红线;回归清单第 3 项与第 8 项专测(含右下角与隐藏后恢复) |
| R14 | 西/北方向的缩放手势写错(只改尺寸不改坐标) | 窗口"看着不动,右边却在跑",并且撞到最小尺寸时窗口整体位移 | §3.4 的三条细节 + `WindowResize.test.ts` 按方向逐个断言 |
| R15 | 窗口隐藏态被写成 `display: none` | 编辑器/行号在隐藏期间量到 0 尺寸,恢复后对齐错乱;且错误发生在"另一次交互之后",很难联想起是隐藏方式导致的 | §5.6 明确要求 `opacity` + `inert`;`editorStyles.test.ts` 扩写一条断言扫 `css/window.css` 不许出现该隐藏态下的 `display: none` |
| R16 | 页容器上残留的 `hidden`(B1) | 参数/过程窗口打开后一片空白,而且不报错 | `index.html` 本无 `hidden` 初值,写入者只有 `RightPanelTabs`(随它删除);回归清单第 5 项专测"三个窗口都有内容" |
| R17 | 有人给 `.window` 补一条 `overflow: hidden`(为了"干净地裁掉正文溢出") | 示例菜单被整块切掉,表现为"点示例没反应" | §11.1 B2 写明裁切职责在 `.window-body`;回归清单第 6 项专测菜单完整展开 |
| R18 | 几何写入用 `style.cssText`(或将来有人图省事改回去) | **拖动时窗口掉到所有窗口后面**,而且只在"拖一下"时出现,极难联想到是样式写入方式 | §11.2 E8;`WindowManager.test.ts` 断言"拖动一帧后 `z-index` 仍在";几何写入只有 `writeGeometry` 一个入口 |
| R19 | 最大化只切类不清行内几何 | 点最大化/全屏"没反应",窗口纹丝不动 | §11.2 E9;阶段 2 验收单列;`WindowManager.test.ts` 断言进入最大化后四条行内几何为空 |
| R20 | 默认几何把某个窗口的底边压到 Dock 之下(B4 的第 2 条) | 该窗口的南边手柄抓不到,且不报错 | §11.2 E13 订正了数值;阶段 0 的纯函数用例断言五个窗口底边同为 `dH-116`;回归清单第 1,7 项 |
| R21 | `.panel` 的 `overflow: hidden` 被原样搬进 `panels.css` | 示例菜单仍被裁掉(即使 `.window` 已放行),排查时会一直盯着 `.window` | §11.1 B2 第 3 条;搬运 `.panel` 规则时明确不带 `overflow` |
| R22 | 面板自带 header 与窗口标题栏重复(B8) | 两层标题,两层边框,加窗口越多越乱 | 已按 W6 拍板 A 案(全删,文案上移);回归清单第 15 项;`#example-menu` / `#formula-copy-hint` 的安置见 B2/E20 |
| R23 | `hostId` 与 `index.html` 漂移(B9) | 启动时抛一个读不懂的 TypeError,或宿主静默为空 | `readAppHosts()` 抛带 `hostId` 的错误(`WindowManager` 仍保留最后一道)+ `desktopHosts.test.ts` / `appHosts.test.ts` 纯文本与桩树守卫 |
| R24 | 分栏链路只删了一半(`RightSplitController` 删了,`--right-split-basis` 或 `.right-splitter` 规则还在) | 要么一条死 CSS 让下一个人以为还有分栏,要么 `#params-panel` 拿不到高度而塌成 0 | §1.2 C14 列全四处写入点;回归清单第 14 项;`desktopHosts.test.ts` 断言 `#right-splitter` / `data-split-page` 不存在 |
| R25 | `#view-controls` 没从参数页里搬出来(B10) | 视图窗口空白,或参数窗口与视图窗口抢同一个节点(后者更糟:节点只有一个父节点,先搬的赢) | §11.1 B10 + §5.2 的 `index.html` 行;阶段 1 验收要求"参数 / 视图 / 过程三个窗口都有内容" |

---

## 13 真机验收记录(阶段 0–4 之后)

**方法**:headless Chromium + DevTools Protocol(SwiftShader 软件 WebGL),把
`#app` 的视口用 `Emulation.setDeviceMetricsOverride` 钉成 1280×800 / 1920×1080
后**重新加载**(默认几何只在启动时算一次,改视口只夹取不重排),再用
`Input.dispatchMouseEvent` / `dispatchKeyEvent` 发**真实**指针与键盘事件,断言
直接读 `getBoundingClientRect` / `getComputedStyle` / `elementFromPoint`.

| 组 | 断言 | 结果 |
| --- | --- | --- |
| 默认几何 | 两组视口下五个窗口的 `x/y/w/h` 与 §4.1 的期望值表**逐像素相同**;`view`/`process`/`objects` 的底边同为 `dH-116`;`source`/`params` 不越过它;两列与中列不重叠 | 通过 |
| 层级与穿透 | `#window-layer` 的 `pointer-events: none`,三层 z 为 100/50/200(canvas 上的空桌面命中 `CANVAS`);Dock 自身的盒子居中且只占内容宽,Dock 左侧的桌面命中 `CANVAS`(B4) | 通过 |
| 拖动 | 标题栏拖动精确位移;拖动后 `z-index` 仍在(E8);松手摘掉 `.is-dragging` | 通过 |
| 八向缩放 | 西/北同时动坐标与尺寸,东/南只动尺寸;东边一路拖到最小宽度夹在 300(R14) | 通过 |
| 最小化/恢复 | 隐藏态 `opacity: 0` + `inert` + **`display: flex`**(R15);隐藏期间 `#dsl-editor` 的 `clientWidth/Height` 与行号槽宽仍然有效;Dock 恢复到原几何 | 通过 |
| 高亮层对齐(§5.6) | textarea 与高亮层的矩形,`font-*`/`line-height`/`tab-size`/`padding` 逐项相同;滚到最右/最下后 `transform == translate(-scrollLeft, -scrollTop)`;高亮层 `overflow: hidden` 且两侧 `scrollHeight` 相等(当年那 15.1px 的坑) | 通过 |
| 最大化/全屏 | 最大化 = `{0,0,dW,dH-100}` 且四条行内几何被清空(E9),`z-index` 仍在;还原逐像素一致;全屏 = `{0,0,dW,dH}`,Dock 自动隐藏,`Esc` 退出并还原 | 通过 |
| 边缘吸附 | 拖到左边缘预览亮起(`is-open`),松手落到左半屏 `{0,0,640,700}`(与最大化同高,见 E30);松手后预览层复位 | 通过 |
| 示例菜单(B2) | 打开后条目齐全,菜单完整可见(底线在窗口底边之上),内部可滚动,滚到底后最后一项可点中;`Esc` 关闭 | 通过 |
| 过程窗口(§3.7) | 被最小化的过程窗口在点条目"过程"后恢复可见,聚焦并载入内容(不最大化,不改几何) | 通过 |
| 视口 resize | 窗口整体收回桌内(E29),3D 画布尺寸跟着 `#app` 变 | 通过 |

**没有覆盖到的**(仍然只能人工看):吸附/拖动的跟手感与动画观感,触屏双击标题栏,
诊断区在变矮的参数窗口里是否够用(§11.1 B3),IME 候选框贴合,以及跨浏览器的
`pointer-events`/`:hover` 细节.
