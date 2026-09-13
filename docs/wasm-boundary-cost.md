# WASM 边界成本与求值迁移实测

本文回答两个问题,并记录 202609 重构/迁移后的实测数据.基准脚本是临时的
(放在 gitignored 的 `target/tmp/`),数字在本机 Node 22 + 当前 wasm 产物上取得;
原生数字用 `cargo test -p math_rs --release -- --ignored --nocapture` 复现.

## 一/积分早就迁到 Rust 了

数值积分**不在**主线程 JS 里,TS 侧只剩 Worker 调度与 payload 编组:

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 调度 | `math/compute/domain/integral/IntegralCompute.ts` | 每任务一个 latest-only executor,payload 组装 |
| Worker | `math/compute/domain/integral/IntegralWorker.ts` | 调 WASM 入口,回传样本 |
| WASM | `math/math_rs/src/lib.rs` | `integrate1d` / `integrate2d` / `integrate_region` / `integrate_solid` |
| 内核 | `math_rs/src/{sampling,integral,domain_integral}_core.rs` | 采样 + 求积 |

所以 `prompt/refactor-and-rust-migration.md` 第二部分讲的**不是**"把积分搬过去",
而是"已经在 Rust 但实现低效"的 `CompiledEvaluator`(每点一次
`HashMap<String, f64>` 插入 + `String` 分配)以及可选的 solid 可视化重复采样.

## 二/跨 WASM 边界拷贝到底贵不贵

**结论:大块数据拷贝不贵;贵的是每次调用的固定编组开销.**
"拷贝成本很大"这个前提对**批量入口不成立**,只对"逐点跨边界调用"成立.

固定开销(小参数往返,Node,单次):

| 调用 | ns/次 |
| --- | --- |
| `mat4_identity()` -> `Vec<f64>(16)`,0 参数 | ~1330 |
| `mat4_multiply(2×16 进,16 出)` | ~2760 |
| `evaluate_scalar(expr, 0 系数, 1 点)` | ~1940 |
| `JSON.stringify(integrate1d payload)`(纯 JS 对照) | ~1600 |

大数组拷贝(实测吞吐):

| 数据 | 大小 | 单次拷贝 |
| --- | --- | --- |
| `integrate1d n=4096` 的 `.samples` getter | 32 KiB | ~24 µs(含 per-call 开销) |
| `integrate_solid n=32` 的 `.samples` getter | 0.25 MiB | ~0.20 ms |
| `integrate_solid n=48` 的 `.samples` getter | 0.84 MiB | ~0.72 ms |
| 同尺寸纯 JS `Float64Array.slice()` 对照 | 6.75 MiB | ~1.44 ms(0.21 ms/MiB) |

即 wasm-bindgen 的 `getter_with_clone` 拷贝约 **0.8 ms/MiB**;应用里最大的
现实 payload 是 `integrate_solid n=96` 的样本(`96³ × 8B ≈ 7 MiB`),
一次拷贝约 **6 ms**--而同一件事的计算在 WASM 里是 **数百 ms** 量级
(见规划文档 §7.1/§7.2).所以:

- **不要**为了省拷贝去改返回结构(规划里的 P2,收益 1–6 ms,占 1% 量级);
- **要**保持批量入口.规划 §10 的反例仍然成立:把逐点求值改成一次一个
  `evaluate_scalar` 调用,每点固定 1–2 µs,比现在(每点几十 ns)慢 1–2 个
  数量级.

## 三/已做的 P0:求值器去 `HashMap<String, f64>`

实现:`math_rs/src/symbolic/eval.rs` 的 `bind_expression` 在构造期把符号解析
成 `SymBinding`(坐标槽/系数槽/常量/未绑定),`CompiledEvaluator` 每点只写
`EvalContext` 的 `f64` 槽位与维度位;`y`/`z` 作系数的历史语义用**运行期维度位**
表达,调用方零改动.旧查表版保留为 `#[cfg(test)]` 参照物,由 4032 点逐点对拍
(按位比较数值 + 比对错误文案)守住语义.

同一 payload,重建 wasm 前后(WASM 端到端):

| 场景 | 改造前 | 改造后 | 加速 |
| --- | --- | --- | --- |
| `integrate1d n=320` simpson | 0.104 ms | 0.047 ms | 2.2× |
| `integrate1d n=4096` simpson | 1.249 ms | 0.456 ms | 2.7× |
| `sample_vector_field 46³`(`x,y,z`) | 62.8 ms | 3.34 ms | 18.8× |
| `integrate2d 256×256`(`sin(x)*cos(y)+a*b`) | -- | 8.57 ms | -- |

原生冒烟(4096 点,`sin(a0*x)*cos(x)+a0`):**217 ns/点 -> 74 ns/点(2.95×)**,
两侧求和逐位相同.表达式越简单,收益倍数越大(省下的是每点固定记账成本);
复杂式的 `sin/cos` 占比高,倍数收敛.

## 四/明确不做的事

| 项 | 实测 | 结论 |
| --- | --- | --- |
| 把 `invertMat4` / `normalizeParamValue` / `latexResultNumber` 之类小函数搬进 Rust | 19 ns – 1 µs | 低于边界固定开销(~1.3–2.8 µs),搬了更慢 |
| 逐点跨边界 `evaluate_scalar` | 1.9 µs/点 | 比批量入口慢 1–2 个数量级 |
| P2 大数组零拷贝返回 | 1–6 ms | 相对计算是 1% 量级,优先级低 |
| P1 solid 可视化重复采样 | n=48 约 45% | 收益真实,但要改 Rust 返回结构与渲染查表契约,待设计确认 |
