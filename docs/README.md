# GraphCalc 文档

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
- [教学化改造路线图](teaching-roadmap.md) -- 规划文档:把 GraphCalc 从"能看
  结论的可视化器"做成**教学工具 + 自学教材**.含数学表达力与教学动线缺口
  清单,分阶段任务表(每项带依赖/工作量/验收/风险/降级),单课与习题设计
  模板,自学侧导读计划,以及"明确不要做的事"清单.
- [方程求解过程的展示设计](equation-solving-process.md) -- 设计文档:过程展示
  为什么要占"另一页"而不是"更大的盒子".含现有面板空间实测(底栏一屏约 14 行,
  右栏通高约 27 行),右栏改标签页的 DOM 结构与四个控制器耦合点,过程视图的
  递等式/依据分区/翻步交互,三级披露阈值,以及"一期展示层,二期几何联动,
  三期求解内核"的分期口径.对应路线图的 `B5`.

配套示例见 [`../example/README.md`](../example/README.md)(求导/偏导
示例为 `derivative_curve.scad`,`derivative_rules.scad`,
`partial_derivative_surface.scad`,`divergence_vector_field.scad`,
`curl_vector_field.scad`;隐式场梯度为 `sphere_gradient.scad`).
