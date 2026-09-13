# GraphCalc 文档

- [求导与偏导(微分分析)使用指南](derivatives-guide.md) -- DSL 用户文档:
  在 GraphCalc 里如何求一元导数,偏导数,散度,旋度,以及 `show` /
  `at` / 参数联动等用法.
- [求导与偏导实现梳理](derivatives-impl.md) -- 面向维护者的实现与
  检查记录:功能现状,与 gradient 的耦合方式,代码路径,未实现项与
  未提交的工作区改动.

配套示例见 [`../example/README.md`](../example/README.md)(求导/偏导
示例为 `derivative_curve.scad`,`derivative_rules.scad`,
`partial_derivative_surface.scad`,`divergence_vector_field.scad`,
`curl_vector_field.scad`;隐式场梯度为 `sphere_gradient.scad`).
