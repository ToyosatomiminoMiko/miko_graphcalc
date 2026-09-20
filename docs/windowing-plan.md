# 面板窗口化设计计划

本文回答:**现在三个贴边固定面板的布局,怎么变成"桌面 + 浮动窗口 + Dock"?**

状态:**方案文档,不动代码**.本文件是本次窗口化工作的唯一交付物;所有分期
都是待立项,阶段 0 之前的任何改动都不应发生.

已拍板的口径(用户 2026-09 指定):

| # | 决定 | 内容 |
| --- | --- | --- |
| W1 | 形态 | **浮动窗口 + 3D 铺满背景**.Three.js 视口仍是铺满 `#app` 的一层,现有面板与右栏两个标签页变成悬在它上面的浮窗(共四个窗口) |
| W2 | 窗口外壳功能(一期) | 焦点/z-order 提升,关闭与最小化,**Dock/任务栏**,边缘吸附与磁吸对齐,最大化/单窗口全屏 |
| W3 | 键盘窗口管理 | **暂缓**,列入本文件的设计与阶段 5,一期不实现 |
| W4 | 布局持久化 | **不做**.README 已明确"界面偏好不落 localStorage";本方案不推翻该约定 |
| W5 | 启用方式 | 替换现有固定布局,不做新旧两套布局的运行时开关 |

参考物:`/mnt/IVSTINIANVS/__projects_web/xxx_VaporwaveDP/`(用户指定的方向).
该项目的窗口观感可用,但实现不严谨,本文**只借观感与交互骨架,不借其实现**;
下面 §3.8 逐条列出它的问题与我们的不同做法.

**怎么读这份文档**(实现者按这个顺序走即可,不必通读):

| 要干什么 | 读哪几节 |
| --- | --- |
| 先摸清现状与要替换的耦合点 | §1 |
| 知道最终长什么样,四个窗口的几何 | §2 -> §3 |
| **动手写**:类型,函数签名,算法,写入点 | §4(照抄即可) |
| 文件放哪,改哪些文件,DOM 契约,样式契约 | §5 |
| **动编辑器之前必读**(高亮层对齐) | §5.6 |
| 交互细节与边界(指针,焦点,隐藏,无障碍) | §6 |
| 按阶段推进 + 每阶段验收 | §7 |
| 测试写什么,什么只能真机 | §8(含 §8.1 测试策略) |
| 真机回归清单 | §9 |
| **动手前先看**:硬性阻碍 B1–B7,方案已订正的错误 E1–E7,查过但不是阻碍的 | §11 |
| 风险登记 | §12 |

一句话总结形态:`#viewport`(three.js)继续铺满当背景,四个浮动窗口
(源码 / 参数·视图 / 过程 / 对象)悬在它上面,Dock 在底部;窗口可拖可缩放可
最小化/关闭/最大化;固定布局的 `PanelController` 与右栏标签页
`RightPanelTabs` 一并删除,面板本体与其全部控制器不动.

---

## 1 现状与要动的东西

### 1.1 现状结构

`index.html` 的 `#app` 下是三个绝对定位面板 + 一个铺满视口的 3D 层:

| 元素 | 位置 | 尺寸来源 | 内容 |
| --- | --- | --- | --- |
| `#viewport` | `inset: 0`,z-index 0 | 铺满 `#app` | three.js canvas(`SceneManager` 构造时 `container.appendChild`) |
| `#left-panel` | 贴左通高 | `--left-panel-width` | 源码编辑器(textarea + 行号槽 + 高亮层)+ 示例浮层 |
| `#right-panel` | 贴右通高 | `--right-panel-width` | 标签页:参数/视图(带 `#right-splitter` 上下分割)与过程 |
| `#bottom-panel` | 底部横条 | `--footer-height` | 对象列表(实体/求值两栏) |

尺寸与折叠的唯一写入点是 `PanelController._applyLayout()`(写 `#app` 上的三个
CSS 变量);右栏内部"参数区 / 视图区"的比例由 `RightSplitController` 写成
`--right-split-basis`;**右栏标签页**由 `RightPanelTabs` 管 `hidden`;三根
`[data-resize-panel]` 分隔条与 `[data-panel-toggle]` 折叠按钮是标记与控制器
之间的连接点.全部拖动走全应用唯一一份 `src/ui/shared/dragGesture.ts`.

注意右栏这一格是**两件事共用一个栏位**:`#right-page-params`(滑块 + 视图控件)
与 `#right-page-process`(求解过程)是同一根侧栏的两个标签页,共用一份宽度,
一次只能看一页.窗口化把它们拆成两个独立窗口(§2.1),这是本次唯一一处
**结构净增**(三个窗口变四个),也是 `RightPanelTabs` 被删除的原因.

### 1.2 窗口化要替换的耦合点(逐条可查)

| # | 现有耦合 | 位置 | 窗口化后 |
| --- | --- | --- | --- |
| C1 | 三个面板的几何是 CSS 绝对定位 + 三个变量 | `css/layout.css` 全文 | 换成窗口几何(px 的 x/y/w/h),由 `WindowManager` 写行内样式 |
| C2 | 折叠 = 收成窄边 + 隐藏正文直接子元素 | `PanelController._applyLayout` | **删除**.最小化/关闭由窗口态表达,不再是"面板折叠";`_collectBindings` / `_bindToggleButtons` 随 `[data-panel-toggle]` 一起消失 |
| C3 | 拖动宽度/高度 | `PanelController._bindResizeHandles` | 换成窗口拖动与八向缩放(仍走 `bindDragGesture`) |
| C4 | `.panel.collapsed ...` 一整组 CSS | `css/panels.css` 57–66,830 | 换成 `.window.is-minimized` 等窗口态选择器 |
| C5 | 面板标题栏 `.panel-header`(含"示例/RUN/收起"按钮) | `index.html` + `css/panels.css` 14–67 | 变成**窗口标题栏**:拖动区 + 窗口按钮;"示例/RUN"移入窗口标题栏,标题栏本体不再是拖动区 |
| C6 | 右栏标签栏留在面板 header 内部(为折叠逻辑) | `index.html` 244 注释,`RightPanelTabs` | **整个删除**.参数页与过程页各自独立成窗口,`RightPanelTabs` 与 `#right-tabs` 一并消失;`.right-page[hidden]` 那条 `display:none` 也没了存在理由 |
| C7 | 面板通高 / 通宽靠绝对定位的 `top/bottom/left` | `css/layout.css` 32–55 | 窗口正文给确定高度,`.panel` 改成"填满窗口正文"(`flex:1;min-height:0`) |
| C8 | 示例浮层按视口高度留余量,折叠时隐藏 | `css/panels.css` 806–833 | 锚点改窗口标题栏;`max-height` 按窗口正文高度算 |
| C9 | 面板尺寸/夹取范围在 `UI_CONFIG.panel` | `src/config/uiConfig.ts` 66–85 | 换成 `UI_CONFIG.window` 的各窗口默认几何与最小尺寸;`panel` 里只留 `split*`(参数窗口内部"参数区/视图区"分割) |
| C10 | 面板尺寸初值的 CSS 兜底 + 测试锁一致性 | `css/base.css` 174–186,`applyUiConfig.test.ts` | **整套删掉**:窗口几何改由 `UI_CONFIG.window` + 行内样式给出,CSS 不再有副本(§11.2 E3) |
| C11 | "点条目行末的过程"= 切标签页 | `DslApp._openProcess` -> `rightPanelTabs.show('process')` | 改成"显示并聚焦过程窗口"(§3.7):源数据没变,变的只是"切页"->"抬窗口" |

**不动的**:`RightSplitController`,`EditorLineNumbers`,
`EditorHighlight`,`ObjectListController`,`ParamPanelController`,
`DiagnosticsController`,`ProcessPanel`,`FormulaCopyController`,
`ExampleLoaderController`,`ViewPanel`.它们全部通过 `document.getElementById`
或构造参数拿节点,窗口化只改**节点在树里的位置与祖先尺寸**,不改节点自身.

**删掉的**:`PanelController`(C1–C4)与 `RightPanelTabs`(C6).两者都是
"布局/页面归属"的控制器,而这两件事在窗口化之后分别由**窗口几何**与
**窗口显隐**表达,不再需要独立控制器.

这是本方案能收敛的前提:**窗口化是"给现有面板换一个容器",不是重写面板**.

---

## 2 目标形态

```text
┌─ #app (desktop) ───────────────────────────────────────────────┐
│  #viewport            铺满,z-index 0      ← three.js canvas    │
│                                                                │
│  #window-layer        inset:0,z-index 100,pointer-events:none  │
│  ┌ source ────────┐   ┌ params ────────┐                       │
│  │ 源码 + 示例/RUN │   │ 参数 / 视图     │                       │
│  │ #left-panel    │   ├ process ───────┤                       │
│  └────────────────┘   │ 过程            │                       │
│         ┌ objects ───┐│ #right-page-...  │                       │
│         │ 对象列表    │└────────────────┘                       │
│         └────────────┘                                         │
│  #dock                z-index 200,pointer-events:auto          │
└────────────────────────────────────────────────────────────────┘
```

每个 `.window` 的结构都相同:`.window-header`(标题 + 标题栏动作 +
窗口按钮,标题是拖动起手区)/ `.window-body`(承载上表里的宿主)/ 八根缩放
手柄.四个窗口的位置尺寸都来自 `UI_CONFIG.window.windows`(§2.1).

三层,职责互不重叠:

1. **`#viewport`**:不动一个字节.`SceneManager.resize()` 读
   `container.clientWidth/Height`,只要它继续 `inset: 0` 铺满,画布尺寸,
   相机 aspect,Line2 分辨率都不受影响.
2. **`#window-layer`**:新容器,`inset: 0`,`pointer-events: none`.它只负责
   建立窗口的定位参照与 z-order 层.**整层不拦截指针**,是 W1 能成立的关键:
   桌面空白处,窗口没盖住的地方,OrbitControls 照常收到事件(§3.4).
3. **`#dock`**:新容器,底部居中一条,`pointer-events: auto`.

窗口自身 `pointer-events: auto`,内部继续用现有 `.panel` 骨架.

**第 0 条约束:全程声明式**.窗口外壳这一层**不写进 `index.html`**,由
`el()` 声明式装配(与 `ViewPanel` 当年把 150 行手写 HTML 收回 TS 是同一条路),
`index.html` 只留面板本体与几个空宿主.装配形状,命名与 DOM 契约见
§5.3 / §5.4;这条不是风格偏好,它有测试守卫(§7 的 `WindowFrame.test.ts`).

### 2.1 四个窗口的默认几何

窗口数从三个变**四个**:右栏那两个标签页("参数 / 视图"与"过程")不再分页,
各自成一个窗口.这一步的目的与代价见 §2.2.

`#app` 的可用区(`desktopW × desktopH`).以下为真实 px(桌面端按窗口大小
重排,见 §3.4 的夹取规则).

| 窗口 | 标题 | 正文宿主 | 默认位置/尺寸 | 最小尺寸 |
| --- | --- | --- | --- | --- |
| `source` | 源码 | `#left-panel` | 左上,`x=16 y=16 w=420 h=dH-116` | 300 × 220 |
| `params` | 参数 / 视图 | `#right-page-params` | 右上,`x=dW-436 y=16 w=420 h=round((dH-116)*0.55)` | 280 × 200 |
| `process` | 过程 | `#right-page-process` | 右下,`x=dW-436 y=16+round((dH-116)*0.55)+12 w=420 h=余高` | 280 × 180 |
| `objects` | 对象 | `#bottom-panel` | 中下,居中 `y=dH-292 w=clamp(360, 720, dW-2*436-32) h=260` | 360 × 160 |

`dW`/`dH` 是桌面宽高;底部统一让出 100px 给 Dock(`--dock-reserve`).
`params` / `process` 上下叠在同一列(默认恰好填满右列),两列之外中间留出
3D 视口.**中列宽度是算出来的**,不是写死的:`dW-2*436-32` 是"两侧窗口各
420 加左右各 16 的间隙"之后剩下的宽度,再夹到 `[360, 720]`
(1280 -> 376,1920 -> 720).这条换算与 §3.4 的夹取共用同一组纯函数.

> **关于"不重叠"这条,核过一次**(数字可以直接当单测断言):
>
> ```text
> 1280×800: source 16...436 | objects 452...828 | right 列 844...1264   -> 无重叠
> 1920×1080: source 16...436 | objects 600...1320 | right 列 1484...1904 -> 无重叠
> ```
>
> 两条结论:**① 两个目标视口下都不重叠**;**② 更窄的视口下允许重叠**--窗口可以
> 拖,用户自己摆,这与 §10「明确不做」里的"不做自动平铺"是同一条取舍.真正
> 必须守住的不变量只有两条:**窗口不越界** 与 **标题栏永远在桌内**,它们由
> §3.4 的夹取保证.`x: 'center'` 的换算是
> `x = clamp(round((dW - w) / 2), 0, dW - w)`,窄视口下自然退化成贴边.

默认几何写在 `UI_CONFIG.window.windows`(锚点式描述,见 E4),由
`WindowGeometry.resolveDefaultGeometry()` 按当前桌面尺寸算出 px,在
`WindowFrame` 建完元素后立即写行内样式.**CSS 侧不留副本**,理由见 §11.2 E3.

### 2.2 为什么把"参数/视图"与"过程"拆开

当年把求解过程做成右栏**第二个标签页**(提交 `456daef`),理由是空间不够:
右栏一份宽度,一次只能看一页,好处是"手不动的东西可以让位给过程板书"
(`docs/equation-solving-process.md` 第 1 节).窗口化之后这条约束消失了:

- **一次只能看一页** -> 两个窗口可以同时看,拖滑块时过程里的"系数取值"那一步
  就在旁边,这正是求解示例(`example/solve_equations.miko`)最想让人看到的东西;
- **共用一份宽度** -> 过程窗口可以单独拖宽.当年文档 §3.3 记的"过程页默认
  300px 对递等式偏窄(一条链式展开要 400–500px)"由此有了出路:不用加"板书
  模式"按钮,也不用连累参数窗口(它 300px 就够);
- **切页** -> 两个窗口各自有最小/最大化/关闭,可以只要过程不要参数.

代价要写清楚:默认布局多一个窗口(小视口下四块可能重叠,但窗口可拖,用户
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

一个窗口的状态收敛成四个字段,全部由 `WindowManager` 持有:

```text
geometry   { x, y, w, h }          // 普通态几何(px,相对 #app)
state      'normal' | 'maximized' | 'minimized' | 'closed'
restore    geometry | null         // 进入 maximized 前的几何,还原用
focused    boolean                 // 与 z-order 一起维护
```

- **几何的唯一写入点**是 `WindowManager._applyGeometry(id)`:把
  `geometry` 写成该元素的行内 `left/top/width/height`,并在
  `state !== 'normal'` 时按状态改写(最大化走 CSS 类,不再写行内几何).
- **状态的唯一写入点**是 `WindowManager._applyState(id)`:切 class
  (`.is-maximized` / `.is-minimized` / `.is-closed`),刷新
  `aria-hidden`,刷新 Dock 按钮的激活态与文案.拖动,按钮,Dock,
  键盘(阶段 5)全部只改状态,由这两个函数落地.
- 这条"一个状态源 + 一个写入点"的约定是从 `PanelController` 继承的
  (它当年就是为了修 `UI-P3.3` 的分叉),必须照搬:窗口化把状态从 1 个
  布尔扩成 4 态 + 几何 + z-order,没有这条,分叉会成倍出现.

**状态转移**:

| 起点 | 事件 | 终点 | 备注 |
| --- | --- | --- | --- |
| normal | 拖标题栏 | normal | 只改 `geometry` |
| normal | 最大化按钮 / 拖到上边缘 / 标题栏双击 | maximized | 存 `restore` |
| normal | 最小化按钮 | minimized | `focused = false`,焦点下移 |
| normal | 关闭按钮 | closed | 同上;Dock 按钮保留 |
| maximized | 还原按钮 / 拖标题栏(拖即还原并跟手) | normal | 用 `restore` |
| maximized | 最小化 / 关闭 | minimized / closed | `restore` **保留**,再开还是最大化前的尺寸 |
| minimized | Dock 按钮 | normal | 回 `geometry` |
| closed | Dock 按钮 | normal | 同上;`closed` 与 `minimized` 在 Dock 上等价,只差动画与语义 |
| 任意 | 容器 `resize` | 同态 | 几何按比例夹回桌内,最大化重算 |

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

### 3.3 最大化与单窗口全屏

两档,刻意分开:

| 档 | 触发 | 效果 |
| --- | --- | --- |
| **最大化** | 标题栏右上的 `▣` 按钮;标题栏双击;拖到桌面上边缘 | 填满 `#app` 减去 `--dock-reserve` 的底部余量,**保留**窗口标题栏与 Dock |
| **单窗口全屏** | 标题栏右上的 `⤢` 按钮(或 `F11` 语义) | 填满整个 `#app`,标题栏变成一条可悬停浮现的窄条,Dock 自动隐藏,`Esc` 退出 |

两者都只写一个 CSS 类(`.is-maximized` / `.is-fullscreen`),几何从类里
`inset: 0` 得到,**不覆盖 `geometry`**;退出时 `restore` 或 `geometry` 原样
写回,所以"最大化前拖到一半的窗口"能精确还原.

`resize` 时若处于 maximized/fullscreen,只需重算类(几何被 CSS 接管),不需要
夹取;处于 normal 的窗口按 §3.4 夹取.

### 3.4 拖动,八向缩放与指针穿透

**拖动**:起手元素是 `.window-title`(标题文字 + 可选 `titleContent`),标题栏
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

- 高亮层是 `#snap-preview`(一个绝对定位 div,由类切换半屏/全屏两种形状),
  不做动画,拖动结束即隐藏.
- 磁吸只对**同一轴**的边生效,且吸附是"这一次移动的修正",下一次移动会先
  清掉修正再判--否则窗口会被永久吸住.
- 阈值进 `UI_CONFIG.window.snap`,不进 CSS(CSS 不消费,与现有
  `sideMinWidth` 那批值的处理一致).

### 3.6 Dock / 任务栏

一条固定在底边居中的横向容器,内容**由窗口清单生成**(不在 HTML 里手写
按钮,与"示例菜单由控制器渲染"同一约定):

- 每个窗口一个按钮:标题 + 状态点.点击语义按状态分派:normal -> 提升并聚焦
  (已是焦点则最小化);minimized/closed -> 恢复到 `geometry`;maximized ->
  还原到 `normal`.
- 当前焦点窗口的按钮带 `.is-active`.
- Dock 右侧另放一个**桌面动作区**:单窗口全屏退出(`Esc` 同样可退),以及
  一个"全部还原"入口(把四个窗口一键复位到默认几何,对应参考项目的
  "恢复默认").
- Dock 常驻:即使四个窗口全关也必须在,否则用户没有回到窗口的入口.
  窗口全关时桌面只剩 3D 视口,`:empty` 之外的提示不必做.

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

/** 默认几何:写"锚点",不写算出来的数字(见 E4). */
type WindowGeometrySpec = {
    readonly x: AxisSpec;
    readonly y: AxisSpec;
    readonly w: AxisSpec;
    readonly h: AxisSpec;
    /** 依赖另一个窗口:`y` 接在 `after` 的下方 `gap` 像素处. */
    readonly after?: { readonly id: string; readonly gap: number };
};

interface WindowConfigEntry {
    readonly id: 'source' | 'params' | 'process' | 'objects';
    /** 标题栏文案,同时是 Dock 按钮的 `title` 与无障碍名. */
    readonly title: string;
    /** 正文宿主 id:WindowManager 用 document.getElementById 取(见 E1). */
    readonly hostId: string;
    readonly dock: { readonly icon: string; readonly label: string };
    readonly defaultGeometry: WindowGeometrySpec;
    readonly minSize: { readonly w: number; readonly h: number };
}

window: {
    windows: readonly WindowConfigEntry[];   // 四个,顺序即 z 初始序与 Dock 顺序
    /** 标题栏上的窗口按钮:顺序即显示顺序,glyph 进配置不散在 TS 里. */
    actions: readonly {
        readonly id: 'minimize' | 'maximize' | 'fullscreen' | 'close';
        readonly label: string;   // aria-label / title
        readonly glyph: string;   // '─' '▣' '⤢' '✕'
    }[];
    /** 桌面几何常量(单位 px). */
    edgeKeep: number;      // 移动/缩放时至少留在桌内的宽度,建议 80
    headerMinVisible: number;  // 标题栏至少可见高度,建议 HEADER_HEIGHT
    dockReserve: number;   // 底部为 Dock 留出的高度,建议 100
    headerHeight: number;  // .window-header 高度,与 css/window.css 一致
    z: { windowLayer: number; first: number; snapPreview: number; dock: number };
    snap: { edge: number; magnet: number };   // 16 / 8
}
```

**四个窗口的数值**(就是 §2.1 那张表的机器可读版):

```ts
{ id: 'source',  title: '源码',      hostId: 'left-panel',
  dock: { icon: '✎', label: '源码' },
  defaultGeometry: { x: { at: 16 }, y: { at: 16 }, w: { at: 420 },
                     h: { from: 'bottom', inset: 116 } },        // = dH - 116
  minSize: { w: 300, h: 220 } }

{ id: 'params',  title: '参数 / 视图', hostId: 'right-page-params',
  dock: { icon: '▤', label: '参数' },
  defaultGeometry: { x: { from: 'right', inset: 16 }, y: { at: 16 }, w: { at: 420 },
                     h: { fraction: 0.55, of: 'usableHeight' } }, // = round((dH-116)*0.55)
  minSize: { w: 280, h: 200 } }

{ id: 'process', title: '过程',      hostId: 'right-page-process',
  dock: { icon: '≡', label: '过程' },
  defaultGeometry: { x: { from: 'right', inset: 16 }, y: { at: 0 },
                     w: { at: 420 }, h: { from: 'bottom', inset: 116 },
                     after: { id: 'params', gap: 12 } },          // y = params.y + params.h + 12
  minSize: { w: 280, h: 180 } }

{ id: 'objects', title: '对象',      hostId: 'bottom-panel',
  dock: { icon: '☰', label: '对象' },
  defaultGeometry: { x: 'center', y: { from: 'bottom', inset: 292 },
                     w: { clamp: [360, 720], inset: 2 * 436 + 32 },  // = dW - 904
                     h: { at: 260 } },
  minSize: { w: 360, h: 160 } }
```

`params` 的 `h` 与 `process` 的 `y` 有依赖,**计算顺序固定**:数组顺序即依赖
顺序(§4.5 的 `bind()` 就是按数组顺序遍历的),`process` 用 `after: { id: 'params' }`
表达"接在它下面".**不要**同时写死 `y` 数字又写 `after`--二选一.
`resolveDefaultGeometry(spec, desktop, resolved)` 的第三个参数就是"已经算出来的
前几个窗口",`after` 从里面取.

两条换算例子(可以直接当单测用例):

```text
1920×1080: source h=964 | params h=530 y=16 | process y=558 h=406 | objects w=720
1280×800 : source h=684 | params h=376 y=16 | process y=404 h=280 | objects w=376
```

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

/** 默认几何:锚点/夹取 -> px.四个窗口的依赖顺序由调用方保证(见 §5.1). */
export function resolveDefaultGeometry(
    spec: WindowGeometrySpec, desktop: Desktop, resolved: ReadonlyMap<string, Geometry>,
): Geometry;

/** 夹取:尺寸 [min, max(min, desktop)],x/y 按 edgeKeep / headerMinVisible. */
export function clampGeometry(g: Geometry, limits: Limits): Geometry;

/** 移动:k -> k+1 的唯一入口.delta 是原始像素增量. */
export function moveGeometry(g: Geometry, dx: number, dy: number, limits: Limits): Geometry;

/** 最大化/全屏:填满桌面减去底部余量. */
export function maximizedGeometry(desktop: Desktop, dockReserve: number): Geometry;
export function fullscreenGeometry(desktop: Desktop): Geometry;

/** 吸附判定:返回落点几何或 null(不吸附). */
export function resolveEdgeSnap(
    g: Geometry, pointer: { x: number; y: number },
    desktop: Desktop, snap: { edge: number },
): { readonly target: Geometry; readonly kind: 'left' | 'right' | 'maximize' } | null;

/** 磁吸:把被拖的边贴到其它窗口的对应边.只改一个轴. */
export function magnetize(
    g: Geometry, others: readonly Geometry[], magnet: number,
): Geometry;
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

`maximizedGeometry` = `{ x: 0, y: 0, w: desktop.w, h: desktop.h - dockReserve }`;
`fullscreenGeometry` = `{ x: 0, y: 0, w: desktop.w, h: desktop.h }`.两者都
**不经过 `clampGeometry`**(否则会被 `min` 下限干扰,且最大化本身就允许超出).

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
    onGeometry: (next: Geometry) => void,
    read: { geometry(): Geometry; limits(): Limits },
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
   真相源(§3.1).
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
    readonly titleContent: readonly Child[];   // 一期为空
    readonly actions: readonly Child[];        // 现成节点:示例按钮 / RUN
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
    readonly header: HTMLElement;
    readonly title: HTMLElement;   // 拖动起手元素
    readonly body: HTMLElement;
    readonly handles: readonly { readonly direction: ResizeDirection;
                                  readonly element: HTMLElement }[];
    readonly controls: ReadonlyMap<string, ButtonHandle>;
    setTitle(text: string): void;             // 最大化/还原时改按钮文案用不到,留口
    dispose(): void;
}
export function createWindowFrame(spec: WindowFrameSpec): WindowFrameHandle;
```

装配顺序(照 §5.4 的 DOM 契约):

```ts
const element = el('section', { class: 'window', attrs: { 'data-window': spec.id } });
element.tabIndex = -1;
element.hidden = false;               // 由状态类控制显隐,不用 hidden
element.style.cssText = geometryToCss(spec.geometry);   // 立即写,避免一帧闪在左上角

const title = el('span', { class: 'window-title' }, el('span', { text: spec.title }), ...spec.titleContent);
const actions = el('div', { class: 'window-actions' }, ...spec.actions);
const controls = el('div', { class: 'window-controls' },
    ...spec.controls.map(c => createButton({ class: 'window-control-btn', text: c.glyph,
                                             ariaLabel: c.label, title: c.label })
        .also(b => b.onClick(c.onClick)).element));
const header = el('header', { class: 'window-header' }, title, actions, controls);
const body = el('div', { class: 'window-body' });
element.append(header, body, ...RESIZE_HANDLES.map(direction => {
    const handle = el('div', { class: 'resize-handle', attrs: { 'data-window-resize': direction } });
    return { direction, element: handle };
}));
```

两个必须做的细节:

- **`el()` 不支持 `style`**:几何用 `element.style.cssText = ...` 或逐条
  `style.setProperty`,与现有代码一致.
- **`spec.actions` 里的节点是搬过来的,不是重建的**(`#run-btn` 的监听不能丢).
  用 `append` 而不是 `replaceChildren`.

`geometryToCss` 是唯一把几何写成 CSS 的地方(与 `WindowGeometry` 一起放,
便于单测):

```ts
export function geometryToCss(g: Geometry): string {
    return `left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px`;
}
```

### 4.5 `WindowManager.ts`(状态与写入点)

```ts
export type WindowState = 'normal' | 'maximized' | 'minimized' | 'closed';

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

    bind(): void;                  // 建 frame + 搬宿主 + 建 Dock + 起初始焦点
    focus(id: string, options?: { takeDomFocus?: boolean }): void;   // 唯一抬升入口(§3.2)
    reveal(id: string): void;      // 恢复可见 + focus(id, { takeDomFocus: true })(§3.7)
    getState(id: string): WindowState;
    getGeometry(id: string): Geometry;
    onGeometryChange(listener: (id: string) => void): () => void;
    dispose(): void;
}
```

`layer` / `dock` / `snapPreview` 三个节点由调用方传入(与 `EditorHighlight`
"节点由装配层取好传入"同一约定),本类不自己去 `getElementById` 找它们;
宿主节点则相反,**必须**由本类按 `spec.hostId` 走 `document.getElementById`
(见 E1:两个页容器搬进 `.window` 后不再是 `#app` 的后代,用 `layer.querySelector`
找不到).

`bind()` 的顺序(不能换):

```text
1. desktop = { w: root.clientWidth, h: root.clientHeight }
2. resolved = new Map()
   for spec of UI_CONFIG.window.windows:          // 数组顺序即依赖顺序
       g = resolveDefaultGeometry(spec, desktop, resolved)
       resolved.set(spec.id, g)
3. for spec: createWindowFrame({ ..., geometry: g })   // actions 里的现成节点在这里被 append
       host = document.getElementById(spec.hostId)     // 见 E1,不是 layer.querySelector
       frame.body.append(host)                          // 宿主是搬过来的,不是重建
       frame.element.appendTo(layer)
       bindWindowMove(id)                               // .window-title 上的拖动
       bindWindowResize(每根手柄, ...)                   // 八向缩放(§4.3)
       applyGeometry(id); applyState(id)                 // 立即写,避免首帧闪在左上角
4. buildDock()      // 每个窗口一个按钮,点击调 focus/reveal/setMinimized
5. focus('source', { takeDomFocus: false })  // 初始焦点必须有一个,否则 z 序没有参照
```

**几何的唯一写入点**:

```ts
private applyGeometry(id: string): void {
    const entry = this.entries.get(id)!;
    // 最大化/全屏的几何由 CSS 类负责(inset:0),这里只在 normal 态写行内样式,
    // 但要先把行内样式清干净,否则退出最大化后会带着旧值.
    if (entry.state === 'maximized' || entry.state === 'fullscreen') {
        entry.frame.element.classList.toggle('is-maximized', entry.state === 'maximized');
        entry.frame.element.classList.toggle('is-fullscreen', entry.state === 'fullscreen');
        return;
    }
    entry.frame.element.classList.remove('is-maximized', 'is-fullscreen');
    entry.frame.element.style.cssText = geometryToCss(entry.geometry);
    for (const listener of this.geometryListeners) listener(id);
}
```

**状态的唯一写入点**(与 `PanelController._applyLayout` 同一条理由):

```ts
private applyState(id: string): void {
    const entry = this.entries.get(id)!;
    const hidden = entry.state === 'minimized' || entry.state === 'closed';
    entry.frame.element.classList.toggle('is-hidden', hidden);
    entry.frame.element.classList.toggle('is-closed', entry.state === 'closed');
    entry.frame.element.toggleAttribute('inert', hidden);     // 挡 Tab 序与点击
    entry.frame.element.setAttribute('aria-hidden', String(hidden));
    // 最大化/最小化按钮的文案在最大化态要变成"还原",两个入口(按钮/双击)共用这里
    entry.frame.controls.get('maximize')?.setText(
        entry.state === 'maximized' ? '❐' : '▣');
    ...
    // Dock 按钮的激活态与 aria-pressed 也在这里刷新(唯一写入点)
}
```

**焦点与 z**(`focus` 与 `reveal` 的唯一区别就是后者先恢复可见):

```ts
focus(id) {
    const e = this.entries.get(id)!;
    if (e.state === 'minimized' || e.state === 'closed') return;   // reveal 才有权改状态
    this.focusedId = id;
    e.frame.element.style.zIndex = String(++this.z);
    for (const other of this.entries.values())
        other.frame.element.classList.toggle('is-focused', other.spec.id === id);
    e.frame.element.focus({ preventScroll: true });
}

reveal(id) {
    const e = this.entries.get(id)!;
    if (e.state === 'minimized' || e.state === 'closed') {
        e.state = 'normal';
        this.applyState(id);
    }
    this.focus(id);
}
```

**注意 `focus()` 里的 `element.focus()`**:`pointerdown` 落在正文输入框上时,
浏览器的默认聚焦行为会把焦点交给那个输入框;而 `focus()` 是**指针路径**上被
调用的,如果它无条件抢焦点,编辑器光标就会丢.所以规则是:

- **指针路径**(`pointerdown` 提升)只改 z 与类,**不**调 `element.focus()`;
- **程序路径**(`reveal()`,Dock 点击)才调 `element.focus()`.

实现上让 `focus(id, options?: { takeDomFocus?: boolean })` 带上这个开关,默认
`false`(指针路径用默认值),`reveal()` 传 `true`.这条是 §6 表格里"点击正文
不夺焦点"的落地方式,别省.

**状态转移**(§3.1 那张表的代码化,每个方法都是"改状态 + 调
`applyGeometry`/`applyState`"):

```ts
setMinimized(id, minimized: boolean): void
    // 进入:state='minimized';focusedId 交给可见窗口中 z 最高者,没有则 null
    // 退出:state='normal';geometry 不变;然后 focus(id, { takeDomFocus: true })
setMaximized(id, maximized: boolean): void
    // 进入:restore ??= geometry;state='maximized'
    // 退出:geometry = restore ?? geometry;state='normal'
setFullscreen(id, on: boolean): void      // 同 setMaximized,但用 'fullscreen'
setClosed(id, closed: boolean): void      // 与 setMinimized 同形,state 用 'closed'
setGeometry(id, next: Geometry): void     // 过 clampGeometry,写回 entry.geometry
onDesktopResize(): void                   // 重算 desktop,所有 normal 窗口重新夹取;
                                          // maximized/fullscreen 只需重算 CSS 类
```

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
| `.panel { position:absolute; z-index:10; display:flex; flex-direction:column; background/border/box-shadow }` | `layout.css` | **拆开**:`position/z-index` 删掉(几何归窗口);`display:flex` 等留成 `.window-body > *`;颜色/边框/阴影保留在这条规则里 |
| `#left-panel / #right-panel / #bottom-panel` 的 `top/left/right/bottom/width/height` | `layout.css` | 全删(几何由 JS 写).`#right-panel` 整个删除(B6) |
| `.panel.collapsed *` | `layout.css` + `panels.css` | 全删(折叠语义不存在了) |
| `.resize-handle` + `.resize-handle-{right,left,top}` | `layout.css` | 基类保留并搬到 `css/window.css`,三条方向类删除;新增八条 `[data-window-resize="..."]` 的 `cursor` 与命中区 |
| `#app { --left-panel-width ... }` 与 `:root` 的 `--side-default-width` 等 | `base.css` | 全删(B7) |
| `.window-header` / `.window-body` / `.window` / `.window-controls` / `.window-actions` | 新 | `css/window.css` |
| `#right-tabs` 全部规则,`.right-page[hidden]` | `panels.css` | 删除 |
| `.example-menu` 的锚点与 `max-height` | `panels.css` | 改锚点(`.window-header` 需要 `position: relative`)与 `max-height`(E5) |

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
建结构,`WindowManager` 只管把结果写进 DOM.这条分工与 `RightSplitController`
把 `computeSplitRatio` 导出成纯函数,`ViewPanel` 只建控件不订阅 EventBus 是
同一手法.

### 5.2 修改

| 文件 | 改动 |
| --- | --- |
| `index.html` | 新增 `#window-layer` / `#dock` / `#snap-preview` 三个空宿主(§5.3);面板本体留原处,删三个 `[data-panel-toggle]` 按钮,三根 `[data-resize-panel]` 分隔条,右栏标签栏 `#right-tabs`(§2.2),外层空壳 `#right-panel`(§11.1 B6),并摘掉两个页容器身上的 `hidden`(§11.1 **B1**);`.window` 外壳**不写进 HTML**,由 `createWindowFrame` 建 |
| `css/layout.css` | **删除**.三件事各有去向:三个面板的绝对定位 -> 窗口几何(§3.1);`.resize-handle` 基类与四向光标规则 -> **`.resize-handle` 类名保留**,连同八向光标一起搬进 `css/window.css`;`.panel` 的底色/边框/阴影 -> `css/panels.css`(或 `window.css` 的 `.window-body > *`) |
| `css/window.css` | 新增(见上),含保留的 `.resize-handle` 与八向 `cursor`;`.window` 保持 `overflow: visible`,`.window-body` 负责裁切(**B2**) |
| `css/panels.css` | 删 `.panel.collapsed` 组(57–66,830)与 `#right-tabs` 全部规则,`.right-page[hidden]`;示例浮层锚点改 `.window-header`,`max-height` 改按窗口正文算(E5);新增 `.window-body` 的 flex 列与 `.window-body > * { flex: 1; min-height: 0 }`(B5) |
| `css/base.css` | **只删不加**:`--side-default-width` / `--footer-default-height` / `--collapsed-*` 与 `#app` 的三个派生变量(`--left/right-panel-width`,`--footer-height`)全部删除(B7,E3).**不新增 `--window-*`**:窗口是 JS 建的,没有"CSS 首帧"这回事 |
| `css/diagnostics.css` | 高度基准随参数窗口变矮,`max-height: 34%` 是否合适要真机看过再定(B3) |
| `css/editor.css` | **只改高度基准的来源,不改任何对齐规则**(§5.6 的清单).编辑器窗口的正文高度由 `.window-body` 给出,`#editor-panel { flex: 1; min-height: 0 }` 与 `#dsl-editor-box { height: 100% }` 原样保留 |
| `src/config/uiConfig.ts` | `panel` 段收敛为 `split*` 三个比例;新增 `window` 段(窗口清单 / 默认几何的锚点描述 / 最小尺寸 / 吸附阈值 / 桌面余量 / 标题栏按钮清单,§4.1 与 E4) |
| `src/ui/theme/applyUiConfig.ts` | 变量映射表**删掉**面板几何那几条(没有 `--window-*` 要写,见 E3) |
| `src/app/DslApp.ts` | 见下面的接线清单 |
| `src/ui/panels/PanelController.ts` | **删除**.职责被窗口态吸收:宽度/高度 -> 窗口几何(§3.1),折叠 -> 最小化/关闭(§3.3,§3.6) |
| `src/ui/panels/PanelController.test.ts` | **删除**;两条有价值的断言迁进 `WindowManager.test.ts`(§8) |
| `src/ui/panels/RightPanelTabs.ts` | **删除**(拆页后不存在).`#right-tabs` 与两个页容器的 `hidden` 写入点是它,删它的同时处理 §11.1 B1 |
| `src/ui/panels/RightPanelTabs.test.ts` | **删除**;两条断言换对象继续守,见 §8 |

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

// start():窗口装配 + 右栏内部分割(标签页那两行删掉)
this.windowManager.bind();          // 建 frame + 搬宿主 + 建 Dock + 初始焦点
this.rightSplitController.bind(document.getElementById('app')!);   // 不变
// 删:this.panelController = new PanelController(); panelController.bind(...);
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

`#example-btn` / `#run-btn` **不需要在这里搬**:它们是"窗口清单里 source 那一项
的 `actions`",由 `WindowFrame` 按 `UI_CONFIG` 组装时 append 进
`.window-actions`(§4.4).`ExampleLoaderController` 与 `_wireEditor()` 拿这两个
节点的时机(构造函数里 `getElementById`)不受影响,监听也照旧.

**顺序上的两条约束**(错了会在启动时报"缺少结构"或量到 0):

1. `WindowManager` 的**构造**必须在最后(它要用到 `#window-layer` 等宿主);
   但宿主的搬运发生在 `bind()` 里,也就是 `start()` 阶段,那时代码都已经拿到
   了节点引用--所以 `EditorLineNumbers` / `EditorHighlight` 的构造期度量
   (它们读 `#dsl-editor` 的字体)不受影响.
2. `windowManager.bind()` 必须在 `rightSplitController.bind(#app)` **之前或
   之后都行**,但**必须在 `processPanel` 构造之后**--`_openProcess` 会用到它.
   推荐顺序:`windowManager.bind()` -> `rightSplitController.bind()` ->
   `processPanel = new ProcessPanel(...)`,与现在的顺序一致,只把标签页那两行
   换掉.

### 5.3 构造方式:全程声明式(硬约束)

窗口外壳**不写进 `index.html`**.本项目已经把"结构进 HTML,逻辑进控制器"的
旧做法改成"HTML 只留宿主与默认数据,结构由 `el()` 声明式建出来",窗口化必须
沿用,不能因为它是新代码就退回手写标记.

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
            title: '源码',
            hostId: 'left-panel',          // 已存在的元素,原样搬进窗口正文
            dock: { icon: '✎', label: '源码' },
            // 默认几何是**锚点 + 夹取**,不是写死的数字:右列高度与中列宽度
            // 都依赖桌面尺寸,由 WindowGeometry.defaultGeometry() 算出 px
            // (见 §11.2 E4).h: { anchor: 'bottom', inset: 116 } 即 dH-116.
            defaultGeometry: { x: 16, y: 16, w: 420, h: { anchor: 'bottom', inset: 116 } },
            minSize: { w: 300, h: 220 },
        },
        { id: 'params',  title: '参数 / 视图', hostId: 'right-page-params', ... },
        { id: 'process', title: '过程',        hostId: 'right-page-process', ... },
        { id: 'objects', title: '对象',        hostId: 'bottom-panel', ... },
    ],
    actions: [                                // 标题栏上的窗口按钮,顺序即显示顺序
        { id: 'minimize',   label: '最小化', glyph: '─' },
        { id: 'maximize',   label: '最大化', glyph: '▣' },
        { id: 'fullscreen', label: '全屏',   glyph: '⤢' },
        { id: 'close',      label: '关闭',   glyph: '✕' },
    ],
}
```

字符字形进配置,不在 TS 里散落**字面量**(与 `UI_CONFIG.view.viewCube` 的
`label` 同一处理;`DOM_ICONS` 那类"TS 里一堆字符常量"的写法不引入).

装配 API 与现有控件同一副骨架(`element` / `get` / `on...` / `dispose`),
具体形状:

```ts
// WindowFrame.ts -- 唯一的窗口结构入口
export interface WindowFrameSpec {
    readonly id: string;
    readonly title: string;
    readonly titleContent: readonly Child[];   // 标题里的额外内容(一期没有,留口)
    readonly actions: readonly Child[];        // 标题栏动作,如"示例"/"RUN"(HTML 里的节点)
    readonly controls: readonly WindowActionButton[];  // 窗口按钮,由 UI_CONFIG 生成
    readonly handles: readonly WindowResizeDirection[];
}
export interface WindowFrameHandle {
    readonly element: HTMLElement;
    readonly header: HTMLElement;   // 拖动起手元素就是它的 .window-title
    readonly body: HTMLElement;
    readonly controls: ReadonlyMap<WindowActionId, ButtonHandle>;
    dispose(): void;
}
export function createWindowFrame(spec: WindowFrameSpec): WindowFrameHandle;

// WindowManager.ts -- 状态与几何,不建结构
export class WindowManager {
    constructor(root: HTMLElement);
    bind(): void;                                  // 按 UI_CONFIG 建 frame + 挂 Dock
    /** 抬升并聚焦(唯一入口;`_openProcess` 与 Dock 点击都走这里). */
    focus(id: string): void;
    /** 显示并抬升:被最小化/关闭时先恢复可见,再抬升. */
    reveal(id: string): void;
    onGeometryChange(listener: (id: string) => void): () => void;
    dispose(): void;
}
```

三个要点:

- `createWindowFrame` 建出 `.window` / `.window-header` / `.window-body` /
  八根手柄,并把 `spec.actions` 里的**已存在节点**(如 `#run-btn`)原样 append
  进去--不是按 innerHTML 重建一份.这样 `#run-btn` / `#example-menu` /
  `#params-panel` 这些既有节点与其监听全部原样保留,`DslApp` 拿它们的方式不变.
- 宿主节点(`#left-panel` / `#right-page-params` / `#right-page-process` /
  `#bottom-panel`)由 `WindowManager` 从 `document` 取到后 `body.append(host)`;
  宿主与其全部内容一行不改(§1.2).
- `data-*` 属性统一走 `el()` 的 `attrs`(`el('section', { attrs: { 'data-window': id } })`),
  与 `evaluationDom.ts` / `rowDom.ts` 一致;不用 `innerHTML`,不拼字符串标记.
  唯一允许 `document.createElement` 的地方是 `WindowFrame.ts` 内部若碰到
  `el()` 覆盖不到的标签(现状里没有),且必须像 `evaluationDom.ts` 那样就地
  写明理由.

于是 `index.html` 的改动收成"删三个按钮 + 加三个空宿主 + 右栏拆页":

```html
<div id="app">
    <div id="viewport"></div>

    <!-- 新增:窗口宿主层 / 吸附高亮 / Dock(内容由 WindowManager 装配) -->
    <div id="window-layer"></div>
    <div id="snap-preview" aria-hidden="true"></div>
    <div id="dock" role="toolbar" aria-label="窗口"></div>

    <!-- 四个正文宿主留在这里;启动时由 WindowManager 搬进各自的
         .window-body,内容一行不改(只删折叠按钮与三根分隔条) -->
    <aside id="left-panel" class="panel"> ... </aside>
    <!-- 右栏原来那层 #right-panel 删除(见 §11.1 B6):
         两个页容器各自成为"参数"/"过程"窗口的正文 -->
    <div id="right-page-params" class="right-page"> ...参数 + 视图... </div>
    <div id="right-page-process" class="right-page"> ...过程... </div>
    <footer id="bottom-panel" class="panel"> ... </footer>
</div>
```

- 两个 `.right-page` 各自直接进一个窗口正文(**不再包一层 `#right-panel`**):
  它当前唯一的用途就是"共同父节点 + `layout.css` 的绝对定位",窗口化后两者
  都不需要,留着会变成空壳.右栏的内部骨架(`.right-page` 的 `flex` 列,分隔条,
  两个 `min-height`)一个字符都不用改.
- 标签栏 `#right-tabs` 与它下面的"过程/参数"两个按钮整块删除;
  `.right-page[hidden]` 的 `display:none` 规则随之删除(两页不再互相隐藏,
  它们在不同窗口里),同时两个页容器身上的 `hidden` 属性也要摘掉
  (**§11.1 B1**,这是最容易漏的一条:不摘就是"打开窗口一片空白").

三个要点:

- **`.panel` 为什么仍留在 HTML 而不是也搬进 TS**:`#dsl-editor` 的默认源码
  是 HTML textarea 的文本内容,`editorStyles` / 示例相关那批测试按"源码不参与
  缩进,不搬动"的约定守着它(§7 保留清单).面板本体留在原处,只由 JS 改挂载
  点,是最小改动且不触碰那条约定;窗口外壳这一层**没有**这类约束,所以它必须
  声明式地建.
- **宿主节点由谁 append**:`WindowManager` 按 `hostId` 取到 `.panel`,再
  `frame.body.append(host)`.`.panel` 与其内部一切一行不改,§1.2 那批控制器
  照旧通过 `getElementById` 拿节点.
- **删除清单**:三个 `[data-panel-toggle]` 按钮(在三个 `.panel-header` 里)
  与三根 `[data-resize-panel]` 分隔条.删掉后 `.panel-header` 就不再是折叠
  语义的承载者,源码面板的标题栏动作(示例 / RUN)改挂窗口标题栏的
  `.window-actions`(见 §5.2).

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
section.window[data-window="<id>"][tabindex="-1"]
├── header.window-header
│   ├── span.window-title            ← 拖动起手元素(bindDragGesture)
│   │   └── (titleContent,一期为空)
│   ├── div.window-actions           ← 面板自带的动作(示例 / RUN),由调用方传入
│   ├── div.window-controls          ← 最小化 / 最大化 / 全屏 / 关闭
│   └── (actions 里的浮层,如 #example-menu)
├── div.window-body
│   └── <host>                        ← #left-panel / #right-page-params /
│                                       #right-page-process / #bottom-panel
├── div.resize-handle[data-window-resize="n|s|e|w|ne|nw|se|sw"]  × 8
└── div.window-snap                   ← 半屏/全屏吸附高亮的落点
```

- **拖动起手就是 `.window-title` 元素本身**,不需要"覆盖整个标题栏的拖动层".
  理由:标题里只有文字(一期 `titleContent` 为空),没有需要点击的按钮,
  `bindDragGesture` 的 `preventDefault()` 不会踩到任何交互;`.window-actions`
  与 `.window-controls` 是它的**兄弟**而非子节点,天然不在拖动区内,
  `closest('button')` 这类运行期判断可以直接删掉.
- 类名分工:`window-actions` 是**面板动作**(示例 / RUN),`window-controls` 是
  **窗口按钮**(最小化 / 最大化 / 全屏 / 关闭).两者不同名,避免"动作"一词
  同时指两件事.
- `tabindex="-1"` 让窗口可被脚本聚焦(`reveal()` 的落点,§3.7),但不进 Tab 序.
- `.window-body` 是 `display: flex; flex-direction: column; min-height: 0`(窗口
  正文的确定高度由它给出),里面那个宿主由 `.window-body > * { flex: 1;
  min-height: 0 }` 拉满--这是 §11.1 **B5** 的一条,漏了宿主会塌成 0 高.

### 5.5 样式契约(必须遵守现有两条硬约束)

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
| 右栏"参数区/视图区"分割 | `RightSplitController` 的基准是 `#right-page-params` 的实际高度,窗口化后它就是"参数"窗口正文高度,逻辑不需要改;窗口太矮时两条 `min-height` 先夹住,与现在一致 |
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

### 阶段 0:几何纯函数(零 DOM 风险)

**内容**:`WindowGeometry.ts`(夹取 / 最大化换算 / 吸附判定 /
`defaultGeometry(desktop, spec)` 锚点换算)+ 单测.

**验收**:边界穷举用例全绿:窗口比桌面大,桌面比最小尺寸小,负位移,吸附
阈值开闭,最大化往返几何一致,**以及四个窗口在 1280×800 / 1920×1080 下的
默认几何互不重叠,不越界**(§2.1 的断言是纯函数用例,不需要打开浏览器).

**为何先做**:这一步没有任何 DOM 与样式风险,却把最容易算错的几个公式
(含 E4 的锚点换算)先钉死.后面阶段都是在它之上接线.

### 阶段 1:窗口骨架,拆页与焦点

**内容**:`#window-layer`,四个 `.window` 包装,`css/window.css`,窗口
标题栏与四个窗口按钮,拖动(标题栏),z-order 与焦点,`WindowManager` 接管
`DslApp` 的装配/释放;**拆页**(§2.2:删除 `RightPanelTabs`,把
`#right-page-params` / `#right-page-process` 分别挂进两个窗口,`_openProcess`
改走 `reveal()`,并处理 §11.1 的 **B1/B2/B5/B6**);删除 `PanelController`
与 `#right-panel`.**缩放,吸附,Dock 暂不做**(窗口用默认几何,关掉就回不来,
先只做最小化,或给一个临时的"全部还原"按钮).

**验收**:真机(浏览器)上:四个窗口可拖动,可提升,可最小化/还原;空桌面
处能转 3D 视角;编辑器输入/行号/高亮/参数联动全部照常;**示例菜单能完整展开
而不被窗口切掉**(B2);**参数窗口与过程窗口打开后都有内容**(B1);
从对象列表点"过程"能让过程窗口可见并到最前;`npm test` 与 `npm run typecheck`
全绿.

**高亮层是这一阶段的红线**:编辑器窗口是唯一"内容对容器几何敏感"的窗口,
`editorStyles.test.ts` 与 `EditorHighlight.test.ts` 必须保持绿;它们一红就说明
动到了 §5.6 的五条对齐轴,先回退那一步再继续,不要在红的基线上往下走.

**为什么把"拆页"放进阶段 1 而不是单独一期**:拆页本身就要求窗口已经存在
(两页要各有各的窗口),而 `RightPanelTabs` 与 `PanelController` 又有共享的
断言文件(§7),分两次动反而要动两遍测试.这一阶段结束后**新旧结构就切换完
毕**,后面三个阶段都只是加交互能力.

**风险**:这是唯一会同时触到 HTML/CSS/装配层的阶段,最大风险是"某个控制器
拿不到节点".缓解:先只改 DOM 包装与样式,一次性跑通 `DslApp` 的全部入口,
再开始拆 `PanelController` 与 `RightPanelTabs`.

### 阶段 2:调整窗口大小 + 最大化/全屏

**内容**:把三根 `[data-resize-panel]` 换成八根 `[data-window-resize]`,
`WindowResize.ts`(纯几何解释),最大化与单窗口全屏态,`resize` 时的夹取.
机制仍走 `bindDragGesture`(§3.4),不新写手势实现.

**验收**:每个窗口八个方向都能拖动且夹在最小尺寸上;西/北方向拖动时窗口
"左边跟着走"而不是只往右长;最大化->还原的几何与最大化前逐像素一致;
全屏按 `Esc` 能退出;窗口标题栏在任何拖动下都没被拖出桌顶;
`WindowResize.test.ts` 的纯函数用例全绿.

### 阶段 3:Dock 与吸附

**内容**:`Dock.ts`,吸附高亮,半屏/最大化吸附,窗口间磁吸,"全部还原".

**验收**:四个窗口关光后能从 Dock 逐个恢复;拖动到左/右/上边缘的预览与落地
结果一致;磁吸不会在窗口之间反复抖动.

### 阶段 4:收尾与回归

**内容**:`PanelController` / `RightPanelTabs` 残留清理(含 `#right-tabs` 与
`.right-page[hidden]` 的样式回收),`css/layout.css` 删除,文档与 README
同步(布局章节,`UI_CONFIG` 章节,`docs/equation-solving-process.md` 的
"右栏标签页"口径),测试补齐(§7),真机回归(§8).

### 阶段 5(暂缓,W3):键盘窗口管理

设计先记下,一期不实现:

- 进现有 `KeyboardController` 的**唯一键盘出口**,不另绑 `keydown`.
- 建议绑定:`Alt+方向键` 把焦点窗口按磁吸步长移动;`Alt+M` 最小化,
  `Alt+Enter` 最大化,`Alt+F` 单窗口全屏,`Alt+Tab` 在可见窗口间轮换焦点,
  `Alt+1..4` 直取四个窗口(源码 / 参数 / 过程 / 对象);`Esc` 退出全屏
  (这条一期就要做,它属于全屏的出口而不是窗口管理).
- 前提是先定义"窗口快捷键是否在编辑器获得焦点时生效"--`KeyboardController`
  现在对 textarea 有明确的键位策略,窗口快捷键必须与它对齐,否则 `Alt+方向键`
  会和文本导航打架.

---

## 8 测试清单

**新增**:

| 文件 | 锁什么 |
| --- | --- |
| `src/ui/desktop/WindowGeometry.test.ts` | 夹取边界,最大化往返,吸附判定(纯函数,穷举) |
| `src/ui/desktop/WindowFrame.test.ts` | **DOM 契约**(§5.4):`.window` / `.window-header` / `.window-title` / `.window-actions` / `.window-controls` / `.window-body` / 八根 `[data-window-resize]` 齐全;传入的既有节点(如 `#run-btn`)是**被搬进去**而不是被重建;窗口按钮的 `aria-label` 来自 `UI_CONFIG.window.actions`.这条测试是"标记真相源在 TS"的守卫 |
| `src/ui/desktop/WindowManager.test.ts` | 焦点/z-order 单调;最小化->还原回原几何;关闭后 `aria-hidden` 与 Dock 态;三种状态转移的分支;`reveal()` 对被最小化/关闭的窗口先恢复再抬升,对可见窗口只抬升;`dispose()` 复位(照搬 `PanelController.test.ts` 的桩式写法,它已经证明 `bindDragGesture` 能在 DOM 桩里完整走一遍拖动) |
| `src/ui/desktop/WindowResize.test.ts` | 八个方向的"增量 -> 几何改变"解释(纯函数),以及**西/北方向同时动 `x/w`**,单轴方向只动一条,角 = 两轴之并这三条;最小尺寸与 `EDGE_KEEP` 夹取 |
| `src/ui/desktop/Dock.test.ts` | Dock 按钮由清单生成(不是手写);按状态分派的点击语义;激活态跟随焦点 |
| `src/ui/editor/editorStyles.test.ts`(扩写,不是新建) | §5.6 的四条新守卫:高亮层与 textarea 的 `font-*`/`line-height`/`tab-size`/`padding` 逐项相等;`#dsl-editor.is-highlighted + #dsl-editor-highlight` 相邻兄弟选择器存在;`#dsl-editor-highlight` 是 `inset: 0` + `overflow: hidden`;`css/window.css` 的隐藏态不含 `display: none` |

**改写**:

| 文件 | 改动 |
| --- | --- |
| `src/ui/panels/PanelController.test.ts` | 删除;其中"折叠态只有一个状态源 + 一个写入点""`dispose` 先复位 DOM"两条**有价值的断言迁进 `WindowManager.test.ts`** |
| `src/ui/panels/RightPanelTabs.test.ts` | **整份删除**(`RightPanelTabs` 不存在了).其中两条断言换个对象继续守:`index.html` 的页容器不写 `hidden` 初值 -> 改成"`index.html` 里没有 `.window` 结构";`.panel.collapsed #right-tabs` 的隐藏清单 -> 改成"`.right-page` 不再有 `[hidden]` 规则"(防止有人把标签页逻辑残留下来) |
| `src/ui/process/ProcessPanel.test.ts` | `refreshEcho()` 的触发点从"切回过程页"变成"参数值变化",需要确认它现在按哪个入口测(§3.7 第三条) |
| `src/ui/theme/cssPalette.test.ts` | `CSS_FILES` 加 `window.css`,删 `layout.css` |
| `src/ui/theme/applyUiConfig.test.ts` | 删掉 `--side-default-width` / `--footer-default-height` / `--collapsed-*` 那批断言与 `base.css` 兜底一致性检查(几何不再走 CSS,见 E3);`UI_CONFIG.panel` 的上下限顺序断言(`min ≤ default ≤ max`)保留 |

**必须保留,且新加入"不许变红"清单的既有契约**:

- `src/ui/editor/editorStyles.test.ts`(编辑区样式归属 + 高亮层不是滚动容器)与
  `src/ui/editor/EditorHighlight.test.ts`(滚动同步 / 结构缺失即报错).这两条
  是高亮层唯一的自动守卫,窗口化把它们从"重要"升级为"阶段 1 的红线":它们一红
  就说明动到了 §5.6 的东西,必须先解决再继续.
- `RightSplitController.test.ts`(分割比例),`widgets.test.ts`,以及全部 WASM
  相关的解析/编译/渲染测试.

### 8.1 测试策略:什么能靠单测,什么只能真机

**必须写清这条,否则会写出注定失败的"布局测试".** 本仓库的单测跑在自制的
DOM 桩(`src/testing/domStub.ts`)上,它**不解析样式表,不做布局**:
`clientWidth` / `clientHeight` / `offsetWidth` 拿不到真实值,`getComputedStyle`
只反射元素上**行内**写过的属性(`domStub` 里 `getComputedStyle` 的替身只认
`element.style.cursor`,这就是 `PanelController.test.ts` 要在桩里手工
`handle.style.cursor = 'ew-resize'` 的原因).

所以分工是:

| 能靠单测(而且应当写) | 只能真机 |
| --- | --- |
| `WindowGeometry` / `WindowResize` 的全部算术:夹取,最大化,吸附判定,锚点换算,八向映射(纯函数,穷举边界) | CSS 是否真的让 `.window` / `.window-body` / 宿主填满高度(B5) |
| 状态机:四态转移,`restore` 往返,`reveal()` 的"先恢复可见再抬升",焦点下移,z 单调递增 | 编辑器高亮层与行号的对齐(§5.6) |
| DOM 契约:标题栏/正文/八根手柄齐全,既有节点是搬进来的 | flex / `min-height: 0` / `overflow` 的实际表现 |
| Dock 按钮由清单生成,激活态跟随焦点 | 吸附预览的观感,拖动跟手性 |
| `classList` / `aria-*` / `hidden` 的写入(`applyState` / `applyGeometry` 可断言类名与行内 `style.cssText`) | `cursor` 是否八向都对(桩不解析 CSS) |

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

1. 四个窗口默认几何互不重叠,不越界,Dock 不被窗口压住.
2. 空桌面处拖拽转视角,滚轮缩放,右键平移全部照常(证明 `pointer-events`
   分层没做错).
3. 编辑器:**高亮层逐项核对**(这是本方案最该慢慢看的一条,方法见下)--
   输入任意多行,把编辑器窗口拖到很窄与很高,拖动正文/缩放到出现横纵滚动条,
   滚到最底部与最右端,然后确认:着色文字与光标/选区始终重合(尤其**右下角**,
   当年那 15.1px 的偏差就是在那里暴露的);行号与源码行严格对齐;IME 候选框
   贴在光标处;示例菜单开合与 `Esc` 关闭,`RUN` 生效.
4. 参数窗口:滑块拖动实时刷新 3D;"参数区/视图区"上下分割条在新高度下仍跟手;
   诊断区在窗口只有半高时仍能看清错误文本(**B3**).
5. **拆页**(§2.2):参数窗口与过程窗口**打开后都有内容**(B1--两个页容器的
   `hidden` 必须已摘掉);两者可同屏;过程窗口能单独拖宽;从对象列表点"过程"时,
   被最小化/关闭的过程窗口会先恢复再抬升聚焦,且参数窗口的几何与数值不变.
6. **示例菜单完整展开**(B2):点"示例",菜单必须完整可见,不被窗口边缘切掉
   (它有意超出标题栏),滚到底部能选中最后一项;`Esc` 关闭并归还焦点.
7. **对象窗口的底边能拖**(B4):Dock 两侧的桌面区域与窗口南边手柄都要能命中,
   最小化/关闭后 Dock 仍可点.
8. 对象列表:两栏,公式 KaTeX 渲染,点击复制 TeX,显隐开关生效.
9. 窗口:拖动,八向缩放(八个方向各试一遍,重点看**西/北**方向是否"看着不动
   右边在跑"),最小化/还原,关闭/恢复,最大化,全屏与 `Esc`.
10. 窗口**隐藏后恢复**:最小化再还原,关闭再恢复之后,编辑器高亮与行号**仍然
    对齐**(这条专门防"用 `display: none` 隐藏导致尺寸量到 0",见 §5.6).
11. 视口 resize(改浏览器窗口大小):窗口不越界,3D 画面不变形
    (`renderController.resize()` 仍被调用).
12. 关掉全部窗口后 3D 仍可操作,Dock 仍在.
13. `index.html` 里**没有**任何 `.window` 结构(窗外壳只在 TS 里);把
    `UI_CONFIG.window.windows` 里某个窗口的 `title` 改一行,刷新后标题栏与
    Dock 文案同时变(证明清单是唯一真相源).
14. 拆页没有留下残留:界面上**没有任何**"参数/过程"标签按钮,
    `#right-tabs` 与 `#right-panel` 都不出现在 DOM 里.

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
- 窗口正文高度变化后 `RightSplitController` 的比例基准是否仍是"页高度"
  (它每次拖动现量 `clientHeight`,理论上自然正确;若发现冻结在旧比例,
  检查是否有地方缓存了高度).
- **拆页之后**:`#right-page-params` / `#right-page-process` 的父节点从
  `#right-panel` 的 flex 列换成"窗口正文"(`.window-body`),两个 `.right-page`
  的 `flex: 1 1 auto; min-height: 0` 需要在新父节点下仍然生效.理论上没问题
  (`.window-body` 也是 flex 列且给了确定高度),但这条要在阶段 1 真机确认;
  若不生效,给 `.window-body > *` 显式补一条规则(§5.4 已写).

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
- **窗口数量的运行期增长**:一期固定四个窗口(源码 / 参数 / 过程 / 对象).
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

**B1(最硬的一条)两个页容器身上带着 `hidden` 属性,拆页后必须显式摘掉.**

`RightPanelTabs` 在构造期就调 `_applyPages(DEFAULT_RIGHT_TAB)`,它会写
`#right-page-params` / `#right-page-process` 的 `hidden` 属性(`DslApp.start()`
里 `new RightPanelTabs(...)` 之后才有 `bind()`,但构造已经写了).
窗口化删掉 `RightPanelTabs` 之后,上一轮运行留在 DOM 上的 `hidden` 就成了
**孤儿状态**:过程窗口打开后正文是一片空白,参数窗口正常.而
`.right-page[hidden] { display: none }` 是 `css/panels.css` 的显式规则,不会
靠 UA 默认值救回来.

处理:阶段 1 删 `RightPanelTabs` 的同时,删掉 `#index.html` 里两个页容器的
`hidden` 属性(并删掉 `.right-page[hidden]` 规则).回归清单第 5,6 项专测:
**两个窗口的内容都要有东西**.

**B2 `.example-menu` 的溢出会被窗口裁掉,必须让窗口层不裁切.**

浮层由 CSS 定位:`.panel-header { position: relative }` +
`.example-menu { position: absolute; top: 100% }`.它**有意超出标题栏**,盖住
正文.窗口化之后:

- 锚点必须是 `.window-header`(它得是 `position: relative`);
- 如果 `.window` 为了裁掉正文溢出而写 `overflow: hidden`,浮层会被**直接切掉**,
  表现为"点示例没反应"(菜单实际上开着,只是看不见).
  所以裁切职责必须下沉到 `.window-body`,`.window` 保持 `overflow: visible`.

(这一条是我核对 `Popover.ts` 之后才发现的:`Popover` 本身**不做任何定位计算**,
它只管 `.is-open` / `aria-expanded` / 点外部关闭 / 焦点归还,位置全在 CSS 里.
所以"窗口化会不会破坏浮层"这个问题,**答案完全取决于 CSS 的 overflow 与
position**,而不是 JS.)

**B3 `#diagnostics` 的高度基准会变,需要重新判断.**

`css/diagnostics.css` 给的是 `flex: 0 1 auto; max-height: 34%`,那个 34% 的基准
是 `#right-page-params` 的高度.窗口化后它仍是同一个父节点,所以**不是 bug**;
但参数窗口的默认高度只有约半个桌面(§2.1 的 `0.55`),诊断区从"右栏通高的
34%"变成"半高窗口的 34%",可用行数明显变少.阶段 1 真机看过之后再决定是否
调这个比例或给诊断区一条自己的最小高度(它是错误提示,不该被压到看不见).

**B4 Dock 不能通栏,否则底部窗口的边抓不到.**

Dock 是 `z-index: 200` 的实心条.如果它铺满整个宽度,任何窗口的南边/角部手柄
只要落在底边就会被它挡住(`pointer-events: auto`),表现为"底边拖不动".
要求:Dock 用居中布局且**自身的盒子只占内容宽度**(`display: flex;
justify-content: center` 的容器 + 内容宽度的内层,或直接 `width: fit-content;
margin: auto`),两侧留出真正可点的桌面.单窗口全屏时 Dock 自动隐藏,这条才
不会在最大化态下变成"整个底边都拖不动".

**B5 宿主移出 `#right-panel` 后,`.right-page` 的尺寸来源要显式补齐.**

`#right-page-params` / `#right-page-process` 现在是 `#right-panel` 的 flex 子项,
高度由父级给.搬进 `.window-body` 后需要三条同时成立,缺一条就塌成 0 高:

| 宿主 | 需要的约束 |
| --- | --- |
| `#left-panel` | `flex: 1; min-height: 0`(它自己是 flex 列容器) |
| `#right-page-params` | `flex: 1 1 auto; min-height: 0`(已有) |
| `#right-page-process` | 同上 |
| `#bottom-panel` | `flex: 1; min-height: 0` |

外加 `.window-body { display: flex; flex-direction: column; min-height: 0 }`.
这一条已经在 §5.4/§5.6 写过,这里重复是因为它是**最容易被漏的一条**:漏了不会
报错,只是内容高度变成 0,看起来像"面板坏了".

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

### 11.2 订正:本方案自己写错的地方

| # | 原稿写的 | 实际情况 | 订正 |
| --- | --- | --- | --- |
| E1 | "`WindowManager` 按 `hostId` 从文档里取宿主";`RightSplitController` 的绑定根不动 | 4.1 那版 API 里 `WindowManager` 的构造参数是 `root: HTMLElement` 并 `root.querySelector(hostId)`.两个页容器搬进 `.window` 之后,`#app` **不再是它们的祖先**,`querySelector` 找不到它们 | `WindowManager` 取宿主统一走 `document.getElementById(hostId)`;`RightSplitController.bind(#app)` 保持不变(它找的 `#right-page-params` 仍在 `#app` 子树内) |
| E2 | "`#right-panel` 保留,只是不再是窗口本身" | 它会被清空,且 `layout.css` 删除后连定位规则都没了(见 B6) | 从 DOM 删除;两个 `.right-page` 直接进窗口正文 |
| E3 | "默认几何写到 `base.css` 的 `:root` 兜底,`applyUiConfig.test.ts` 锁一致性" | **多此一举**:窗口是 JS 建的,在 JS 跑之前窗口层是空的,"CSS 首帧兜底"没有首帧可兜.而"默认几何 = 视口宽高的函数"本来也无法在 CSS 里表达(见 E4) | 删掉这套兜底与对应断言;默认几何只由 `UI_CONFIG.window.windows` + `WindowGeometry` 的行内样式给出,`WindowFrame` 建完元素,插入窗口层之后立即写几何 |
| E4 | `UI_CONFIG.window.windows` 的 `defaultGeometry` 直接写死 `w/h` 数字 | 右列高度,中列宽度都依赖桌面尺寸(§2.1 的 `dH-116` / `clamp(360, 720, dW-2*436-32)`),写死的数字只能在某一个视口下正确 | 改成**比例/锚点 + 夹取**的描述(`{ x: 16, y: 16, w: 420, h: { anchor: 'bottom', inset: 116 } }` 这类),由 `WindowGeometry.defaultGeometry(desktop, spec)` 纯函数算出 px;这也让默认几何能被阶段 0 的穷举测试覆盖 |
| E5 | `#example-menu` 的 `max-height: calc(100vh - 64px)` | 浮层挂在窗口标题栏下,量的是**视口**高度:窗口比视口矮时浮层会超出窗口(配合 B2 的裁切问题,表现是"菜单被切一半") | 改按参数/所属窗口正文的高度算(`max-height: calc(100% - ...)` 或由 CSS 变量给出窗口正文高度);`panels.css` 那条注释"左面板通高,所以按视口高度留余量"随之作废 |
| E6 | W3 写"列入本文件的设计与阶段 3" | 键盘窗口管理实际排在**阶段 5** | 已订正为阶段 5(本稿早前改过一处,漏了 W3 那一行) |
| E7 | 第 11 章里"把 §3 的状态机与 §3.4/§3.5 的数值当成跨端口径" | 前提是"与桌面端对齐"那一章;该章已按作者要求删除(本次不考虑桌面端) | 整节删除,原来那条"与桌面端分叉"的风险行也一并删掉 |

### 11.3 查过但**不是**阻碍的(留个记录,省得再查一遍)

| 看起来可疑 | 结论 |
| --- | --- |
| `Popover` / `ExampleLoaderController` 会不会因为按钮换位置而失效 | 不会.`Popover` 不做定位计算,只认 `trigger` / `panel` 两个节点与 `bind(root)`;只要 `#example-btn`,`#example-menu` 仍在 `#app` 子树内,`.window-header` 给了 `position: relative` 就成立(位置问题见 B2) |
| `#viewport` 的 canvas 会不会盖住窗口 | 不会.canvas 无定位无 z-index,在 `#viewport`(`z-index: 0`)内绘制;窗口层是 100 |
| `createViewPanel` / `ObjectListController` / `ProcessPanel` 会不会拿不到节点 | 不会.`ObjectListController` 用构造参数收容器,`ProcessPanel` 用 `root` 参数,`createViewPanel(host)` 用 `#view-controls` 元素--全都不依赖"节点的父级是谁",只依赖 id 仍在 |
| `EditorLineNumbers` 的槽宽会不会随窗口变窄而变 | 不会.它按**字体度量与最大行号位数**定宽,与容器宽度无关;构造期还先写默认字体再 `refresh`,没有测量顺序陷阱 |
| `RightSplitController` 在窗口被隐藏时会不会崩 | 不会.它每次拖动现量 `clientHeight` 并在 `<= 0` 时跳过;最小化态它根本不参与交互 |
| 窗口拖动会不会触发 3D 的 `resize()` | 不会,也不该.`DslApp.onResize` 只挂在 `window.resize` 上;视口始终铺满,不需要跟着窗口动 |
| `#formula-copy-hint` / 对象列表 / 参数滑块 会不会受影响 | 不会.它们都在下窗口 / 参数窗口正文里,id 与结构不变 |

---

## 12 风险登记

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | `#window-layer` 的 `pointer-events` 处理错 | 3D 完全不能转,是 W1 的致命伤 | 分层规则只有一条,阶段 1 的真机回归第 2 项专测 |
| R2 | `PanelController` / `RightPanelTabs` 删除时漏改某个消费者 | 面板不再响应折叠/尺寸,或"模型与 DOM 分叉" | §1.2 的 C1–C11 表逐条核对;`grep` 清单见该表 |
| R3 | 新增 `css/window.css` 漏进 `cssPalette.test.ts` 的 `CSS_FILES` | 新文件不受色板约束,颜色开始分叉 | §5.5 已写成硬约束;阶段 0 先改测试列表 |
| R4 | 窗口 `hidden` 恢复后编辑器度量到 0 宽 | 行号槽宽错乱 | §8 待验点 1;`onGeometryChange` 是为此预留的挂钩 |
| R5 | 最大化的"全屏高亮"与窗口状态不同步 | 预览与落地不一致,用户困惑 | 吸附判定是 `WindowGeometry` 的纯函数,预览与落地**调同一个函数** |
| R6 | 标题栏拖动与动作按钮争事件 | 按钮点不动,或拖动起不来 | 拖动起手就是 `.window-title`,与 `.window-actions` / `.window-controls` 是兄弟而非父子;不靠运行期 `closest` 判断(§5.4) |
| R7 | 窗口默认几何在小视口下越界 | 首次打开就抓不到某个窗口 | §3.4 的夹取规则 + `resize` 时重算;回归清单第 1 项 |
| R10 | 窗外壳由 JS 建之后,有人"顺手"往 `index.html` 里手写一份 `.window` | 标记有两份真相源,改一处漏一处不报错 | §5.3 的硬约束 + §7 的 `WindowFrame.test.ts` DOM 契约守卫 |
| R11 | 拆页只改了"谁在哪个窗口",漏改"点过程"那条链路 | 点"过程"没反应(窗口被最小化),或悄悄改掉了参数窗口的几何 | §3.7 的三步口径 + `reveal()` 是唯一入口;回归清单第 5 项专测 |
| R12 | 有人把"两页共用一份宽度/一次只看一页"的旧口径当成仍需维护的约束 | 拆页被当成回退,或又加回标签页 | §2.2 写明当年(`456daef`)那条理由的前提是"右栏只有一份空间",窗口化后前提消失 |
| R13 | 窗口化改动了编辑器外层容器,高亮层与 textarea 错位 | **最贵的一类 bug**:文字是透明的,错位直接表现为"编辑不了",而且不容易定位到是哪一层 | §5.6 的定位契约(五条对齐轴 + 不许碰清单)+ 阶段 1 把 `editorStyles.test.ts` / `EditorHighlight.test.ts` 列为红线;回归清单第 3 项与第 8 项专测(含右下角与隐藏后恢复) |
| R14 | 西/北方向的缩放手势写错(只改尺寸不改坐标) | 窗口"看着不动,右边却在跑",并且撞到最小尺寸时窗口整体位移 | §3.4 的三条细节 + `WindowResize.test.ts` 按方向逐个断言 |
| R15 | 窗口隐藏态被写成 `display: none` | 编辑器/行号在隐藏期间量到 0 尺寸,恢复后对齐错乱;且错误发生在"另一次交互之后",很难联想起是隐藏方式导致的 | §5.6 明确要求 `opacity` + `inert`;`editorStyles.test.ts` 扩写一条断言扫 `css/window.css` 不许出现该隐藏态下的 `display: none` |
| R16 | 页容器身上残留的 `hidden` 没摘(B1) | **参数/过程窗口打开后一片空白**,而且不报错,控制台干净 | 阶段 1 清单里单列;回归清单第 5 项专测"两个窗口都有内容" |
| R17 | 有人给 `.window` 补一条 `overflow: hidden`(为了"干净地裁掉正文溢出") | 示例菜单被整块切掉,表现为"点示例没反应" | §11.1 B2 写明裁切职责在 `.window-body`;回归清单第 6 项专测菜单完整展开 |
