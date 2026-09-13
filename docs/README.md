# GraphCalc 文档

- [求导与偏导(微分分析)使用指南](derivatives-guide.md) -- DSL 用户文档:
  在 GraphCalc 里如何求一元导数,偏导数,散度,旋度,以及 `show` /
  `at` / 参数联动等用法.
- [求导与偏导实现梳理](derivatives-impl.md) -- 面向维护者的实现与
  检查记录:功能现状,与 gradient 的耦合方式,代码路径,未实现项与
  未提交的工作区改动.
- [架构重构与 Rust 迁移规划](refactor-and-rust-migration.md) -- 规划文档:
  `src/ir/` 破依赖倒置,`math/tensor` -> `math/matrix`,`math/compute` 三分,
  `MathComputeEngine` 去留的精确改动清单与执行顺序;
  以及把计算搬进 Rust/WASM 的**实测收益表**(边界固定开销 ~1.1 µs,
  `CompiledEvaluator` context 占求值成本 94–99%)与"哪些**不该**搬"的理由.
  执行状态见仓库根 README 的"架构"一节.
- [WASM 边界成本与求值迁移实测](wasm-boundary-cost.md) -- 回答"积分是否已迁到
  Rust""WASM↔JS 拷贝到底贵不贵";记录 P0(求值器去 `HashMap<String, f64>`)
  的前后实测数字,以及明确不该迁移的项.

配套示例见 [`../example/README.md`](../example/README.md)(求导/偏导
示例为 `derivative_curve.scad`,`derivative_rules.scad`,
`partial_derivative_surface.scad`,`divergence_vector_field.scad`,
`curl_vector_field.scad`;隐式场梯度为 `sphere_gradient.scad`).
