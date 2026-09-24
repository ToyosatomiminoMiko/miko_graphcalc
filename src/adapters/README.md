# `src/adapters/` -- 领域数据 -> 展示数据

这一层只有一种活:**把编译产物(IR)翻译成"界面要显示的东西"**,纯函数,不碰 DOM,
不认识控件.

| 文件 | 输入 -> 输出 |
| --- | --- |
| `evaluationToSteps.ts` | 求值对象的 IR 结果(梯度/积分/求交/求解/原函数/微分方程)-> 过程文档(步骤列表) |
| `processSteps.ts` | 过程步骤的**视图模型**:类型,种类标签,截断与分区 |
| `entityText.ts` | `SceneObject` -> 实体行的文本(种类标签,表达式回退) |

与相邻两层的分工:

```text
contract/    领域数据的形状(IR / 事件 / 展示行 EvaluationDetailLine)
   │
adapters/    领域数据 -> 展示数据(本目录;纯函数,可在 node 里单测)
   │
views/       展示数据 + 控件 -> DOM(行/列表/面板;不认识编译器)
```

为什么单独一层(而不是让 `views/` 直接读 IR):`views/` 的职责是"渲染",
把"读哪些字段,拼成什么文本"混进去之后,渲染模块就没法在不构造 DOM 的情况下
单测,而且"库能不能不认识 IR"这条边界会从 `views/` 一路洇到 `miko_ui`
(docs/ui-library-extraction-plan.md D2).
