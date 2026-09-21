# 曲面非有限(NaN)三角形:四条通路的收口与两条已知边界

面向维护者.回答两个问题:

1. "曲面出现了 NaN 三角形 / 一片黑亮斑"这类症状,现在有哪几条成因,各自修在哪;
2. 哪些是**有意保留**的边界(不是没修完,是设计代价),免得后人把它当 bug 再修一遍.

一句话结论:**四条非有限通路已全部封死,并有可证的全局不变量 --
`positions` 与 `normals` 的每个分量都是有限 f32**;定义域边界与极点附近
留有一条一个网格步宽的缺失带,这是"整格证明"判据的固有代价.

涉及文件(按数据流向):

| 文件 | 角色 |
| --- | --- |
| `src/math/math_rs/src/symbolic/eval.rs` | 逐点求值;非有限 -> `None`(掩码语义) |
| `src/math/math_rs/src/sampling_core.rs` | 网格采样;掩码写回 `NaN` 占位 |
| `src/math/math_rs/src/interval_core.rs` | **区间算术 + 三值定义域判定**(新增) |
| `src/render/render_rs/src/surface_utils.rs` | 顶点装配,有效性过滤,索引,法线 |
| `src/render/visualization/SurfaceMesh.ts` | 缓冲写入与包围体;刻意容忍 NaN 顶点 |

---

## 1. 四条通路

### P1 采样点无定义(z = f(x, y) 在该点无实值)

- **症状**:曲面上一块块黑斑;或(旧版)相邻正常三角形的高光/阴影整体异常.
- **成因**:`sqrt(x)` 在 `x < 0`,`ln(x)` 在 `x <= 0`,`1/x` 在 `x = 0`,
  `tan(x)` 在 `π/2 + kπ`,负底数的偶分母有理指数 ...... 求值层把这些点的结果
  按掩码语义折成 `None`,采样层写回 `f64::NAN`.
- **为什么不能只靠"删掉 NaN 顶点"**:含 NaN 顶点的三角形其面法线是 NaN,而
  法线按共享顶点累加,NaN 会**顺着顶点平均扩散**到整片相邻的正常三角形.
- **收口**:两道闸门串联.
  1. 顶点有限性(4 个角全有限才考虑)--`compute_valid_cells`;
  2. 整格定义域证明 -- `interval_core::certify_surface_cells`(见 §2).
- **不变量**:`z_vals` 里只有"有限 f64"或 `NaN` 两种值,不会出现 `±Inf`.
  因为 `symbolic::eval::finite_value` 在**每一步运算**上就把非有限折成了
  `None`,溢出与无定义在下游是同一种表现.
- **回归用例**:`nan_surface_still_masks_cells`(render_rs),
  `square_root_domain_is_respected` / `logarithm_domain_is_respected` /
  `tangent_pole_is_detected_by_cosine_interval`(interval_core).

### P2 f64 -> f32 投影溢出(有限 f64 变成 `f32::INFINITY`)

- **症状**:极点/陡峭区出现 `Inf` 顶点;随之而来的是 P3 的 NaN 法线.
- **成因**:闸门开在了错误的类型上.旧版判据是 `z.is_finite()`(f64),而真正
  写出去的是 `z as f32`.`f64 as f32` **不保有限**:

  ```
  exp(x² + y²) 在 (10, 10) 处 = e²⁰⁰ ≈ 7.23e86   (f64 有限,过闸)
                              -> f32  = INFINITY   (f32::MAX ≈ 3.4028235e38)
  ```

  `x` / `y` 同理:区间是用户填的,`range = ±1e40` 直接溢出.
- **收口**:`saturate_to_f32` 把三个分量都**钳**进 `±f32::MAX` 再写.
  `clamp` 是单调保序投影:有限进,有限出,`±Inf` 映到 `±f32::MAX`,
  `NaN` 保持 `NaN`(其所在单元已被 P1 剔除).
- **为什么是饱和而不是丢格**:饱和不改变单元有效性,不会在溢出区额外制造
  空洞;丢格会把本可连续逼近的极限面变成破洞.饱和后的几何仍然单调.
- **注意**:这一步只保证**有限**,不保证**尺度可看**.z 全量被撑到 `1e30`
  时场景尺度仍会被包围盒拉爆 -- 那是"几何 z 区间"的问题,与 NaN 无关.
- **回归用例**:`finite_f64_beyond_f32_range_never_becomes_infinite_vertex`,
  `out_of_f32_range_axes_saturate_instead_of_overflowing`.

### P3 f32 面法线溢出(`Inf - Inf = NaN`)

- **症状**:与 P1 相同(法线 NaN 扩散),但**采样值全部正常**,着色器里也查
  不出 NaN 来源.
- **成因**:叉积与逐顶点累加全程在 f32.两个 1e30 量级的边分量相乘即溢出:

  ```
  f32: 1e30 * 1e30 = inf;  inf - inf = NaN    -> 进 normals,再按顶点扩散
  ```

  这条通路和"函数有没有定义"完全无关,采样层的 NaN 闸门也管不到它.
- **收口**:叉积与累加改用 f64 中间量,归一化后写回 f32.这是**可证的**:
  只要顶点有限(由 P2 的饱和保证),则

  | 量 | 上界 |
  | --- | --- |
  | 两个有限 f32 之差 | `< 2^129` |
  | 叉积分量(两数之积) | `< 2^258` |
  | 每顶点累加(网格里至多 6 个有效三角形) | `< 2^261` |
  | f64 有限上界 | `≈ 2^1024` |

  余量约 700 个二进制数量级,所以 f64 路径上不可能产生 `Inf`,也就不可能
  出现 `Inf - Inf`.归一化结果落在 `[-1, 1]`,转回 f32 无损.
- **回归用例**:`vertex_normals_survive_coordinates_whose_cross_overflows_f32`
  (边长 1e30 的直角三角形,法线应为 `(0, 0, ±1)` 且有限).

### P4 GPU 侧:`normalize(vec3(0.0)) = 0/0 = NaN`

- **症状**:Rust 侧查不出任何非有限值,画面里仍有 NaN 光照.
- **成因**:零长度法线被原样保留.Rust 里"零向量"是合法值,GLSL 里
  `normalize` 会做除法.
- **收口**:长度过小时给稳定兜底方向 `(0, 0, 1)`.
  真正参与绘制的顶点必然属于某个 xy 面内非退化的网格三角形,其累加向量
  非零;拿到兜底的只有未被任何有效三角形引用的顶点(NaN 顶点,被剔除单元
  独占的顶点),它们不参与绘制.
- **回归用例**:`unreferenced_vertices_get_a_fallback_normal_not_zero`.

---

## 2. 定义域那一类:为什么必须换判据

### 2.1 点采样在原理上有盲区

旧判据是"采几个点看看":4 个角 + 遇变号时补一次边中点,再与"该方向相邻
跳变的中位数 × 16 倍"比较.它有一个**与采样密度无关**的盲区,任何有限点集
都躲不过:

对单元内的任意有限采样点集 `S`,取

```
g(x, y) = sqrt(ε² − ((x − x₀)² + (y − y₀)²)),   (x₀, y₀) 在单元内部
```

`g` 在 `S` 上处处有定义且光滑,但在单元内部一个开圆盘上无定义.反过来
(四角 NaN,内部处处有定义)也能构造.所以"采样点全有限 ⟹ 该单元不含奇异点"
是不可判定的.同一类问题还出现在"渐近线恰好落在两个采样点之间".

### 2.2 区间算术 + 三值判定

判据换成**对整格做证明**:把单元的坐标区间代进表达式,得到函数值的一个
**包含**区间;只要每层子表达式的定义域约束都被区间证据满足,就证明整格
处处有定义.

每个区间带一个三值标记,传播规则是 `Nowhere` 支配 `Partial`,两者都支配
`Everywhere`(依据:复合表达式只在**所有**子表达式都有定义的点上有定义):

| 结论 | 含义 | 处理 |
| --- | --- | --- |
| `Everywhere` | 整格处处有定义 | 出三角形 |
| `Nowhere` | 整格都落在定义域外 | 立即判无效(不细分) |
| `Partial` | 一部分有定义(边界/极点穿过) | 四分细分;仍证不出则不出三角形 |

细分深度上限 `config::CERTIFY_SUBDIVISION_DEPTH = 4`.细分的作用是化解
**区间算术自身的保守**(dependency problem,例如 `sqrt(x - x + 1)` 的
`x - x` 给出 `[-h, h]` 把 0 包了进去,细分一次即证明),它**逼近不了真实
边界** -- 真实极点细到任何深度仍是 `Partial`.因此任一子格判否立即短路
返回,边界附近的代价是"几次求值"而不是 `4^depth`.

区间扩张只允许**放宽**,任何不确定的情形都必须落到 `Partial` / `Nowhere`,
绝不能"猜一个更窄的区间":放宽只丢几何,收窄会把奇异点放进来.
区间算术自身溢出(`inf − inf`,`0 · inf`)的处理同理:放宽成 `(−∞, +∞)`,
而不是当成"函数无定义".

### 2.3 必须与 `real_pow` 的定义域逐条对齐

认证结论与逐点求值不一致就会出现"认证通过,求值给 NaN"的矛盾,那正是本
模块要消灭的东西.`interval_core::pow_interval` 与
`symbolic::eval::real_pow` 对齐的规则:

1. **整数指数**(含负整数):全实轴有定义;`0^负指数` 发散,含 0 的盒子判
   `Partial`,只在恰好是 0 那一点时判 `Nowhere`;
2. **奇分母有理指数**(`1/3`,`2/3` ......):`real_pow` 对负底也给实值,符号由
   约分后分子奇偶决定,故全实轴有定义;
3. **其它非整数指数**:只有 `base >= 0` 有实值;
4. **指数是一个区间**:只有 `base` 严格为正才能整盒下结论(负底区间里必然
   含非奇分母有理数的指数,那些点求值为 NaN).

### 2.4 恒有定义表达式的短路

表达式若不含任何可能无定义的运算(加法/减法/乘法/正整数字面量指数,以及
`sin`/`cos`/`atan`/`sinh`/`cosh`/`tanh`/`exp`/`cbrt`/`abs`),就没有奇异点可
找,逐格证明是空转,直接全通过.这在数学上与逐格证明**等价**(逐格结论也
全是 `true`),只是把常见光滑曲面的认证代价降到 O(1).

判定必须保守,`is_total` 拿不准就返回 `false`.它靠**穷尽 `match`** 保证不
漂移:新增任一 `IntervalOp` 变体,`apply_unary` 与 `unary_is_total` 都会编译
失败,强制表态"这个算子在实轴上是否全域有定义".

---

## 3. 已知边界(有意保留,不是待办)

### L1 定义域边界与极点附近有一条一个网格步宽的缺失带

- **表现**:`tan(x)` 的每一条渐近线少画一列;`sqrt(1 − x² − y²)` 的圆盘
  边缘少一圈;`1/x` 的 `x = 0` 两侧各少一列.
- **成因**:判据只能证明"整格有定义",证明不了"整格无定义".边界与极点
  所在的格子一律不出三角形 -- 这是判据保守性的必然结果,不是实现缺陷.
- **实测**(`sqrt(1 − x² − y²)`,128² = 16384 格):画出 316 格,其余是圆外
  (真实无定义)与边界带(设计代价).`sqrt(x)` 在 128² 下精确画出 x ≥ 0 的
  8192 格.
- **要连这条带都消掉,只有两条路**(都不在本次范围内):
  1. **有界化坐标渲染**:显示用 `w = (2/π)·arctan(z)` 之类把 `R ∪ {∞}` 压进
     有限区间,极点变成有限高的柱面,于是"哪一格都有值可画";代价是几何不再
     等距,法线要乘链式因子,上色要在着色器里反变换;
  2. **自适应网格**:在边界处加密而不是在均匀网格上取舍;代价是索引与缓冲
     从规则网格变成非规则结构,几何体重建逻辑要跟着改.

### L2 一维曲线仍是"跳变倍数"启发式,未迁移

- **位置**:`src/math/math_rs/src/sampling_core.rs` 的 `sample_curve`,
  判据是 `ASYMPTOTE_JUMP_FACTOR = 16` + 相邻跳变中位数,与本次移除的曲面
  启发式同源.
- **为什么本次不动**:曲线是折线,没有三角形,没有面法线,没有顶点平均,
  不产生 NaN 三角形;它的失效模式是"跨断点连出一条伪线段",与本文主题不同.
- **要迁移需要什么**:写一维版认证(区间盒退化成一维区间),把
  `sample_curve` 的断点判定换成"两个相邻采样点之间的区间是否可证明有定义";
  同时保留现有的"隔了未定义网格点必然断开"这条硬规则.工作量比曲面小
  (一维盒子,无 y 轴细分),但它有自己的一整套回归用例,建议独立立项.

---

## 4. 实测数字

### 4.1 判据本身:旧启发式 vs 区间认证(512² = 262144 格)

把旧实现原样抽出做对照(基准脚本跑完即删,未入库):

| 曲面 | 旧:判定耗时 | 新:判定耗时 | 旧:保留格子 | 新:保留格子 |
| --- | --- | --- | --- | --- |
| `x + y`(恒有定义) | 7.2 ms | **0.0 ms** | 262144 | 262144 |
| `sqrt(x)` | 4.3 ms | 6.8 ms | 131072 | 131072 |
| `tan(x)` | 10.1 ms | 20.4 ms | 260096 | 260096 |
| `1/((x−0.5)² + (y−0.5)² − 1e−4)`(格内极点圆) | 21.8 ms | 69.2 ms | **262144(全留)** | **262141** |

两处值得记住的结论:

- 前三行是**等价**的:新判据给出的掩码与旧启发式完全一致,但从"阈值巧合"
  变成了"构造性结论"(例如 `tan(x)` 在 512² 下恰好剔 4 列 × 512 行,与
  采样密度,跳变分布无关).
- 第四行是**能力差异**:半径 0.01 的极点圆完全落在单元内部,四个角与四个
  边中点的分母都显著为正,z 同号,旧启发式一个条件都不触发,整张网格
  262144 格全画出来(视觉上是一道贯穿极点的墙);区间认证只要看到分母区间
  含 0 就判该格无效.128² 下这个用例精确只剔 1 格,已有回归用例钉住.

### 4.2 端到端(真实 wasm,release + wasm-opt,含采样)

单次 `sample_and_process_surface` 调用:

| 曲面 | 128² | 256² | 256² 被剔格子 |
| --- | --- | --- | --- |
| `sin(x)·cos(y)` | 9.5 ms | 14.5 ms | 0 |
| `x² + y²` | 3.1 ms | 10.6 ms | 0 |
| `tan(x)` | 4.4 ms | 13.7 ms | 1024(= 4 列 × 256) |
| `sqrt(1 − x² − y²)` | 5.9 ms | 14.8 ms | 64188 |
| `sqrt(x)` | 1.7 ms | 7.5 ms | 32768(= 128 列 × 256) |
| `1/((x−0.5)² + (y−0.5)² − 1e−4)` | 7.5 ms | 29.0 ms | 1 |
| `ln(x) + tan(y)` | 4.2 ms | 18.2 ms | 33532 |

所有用例的 `positions` / `normals` 非有限分量计数均为 **0**(被剔除单元的
NaN 顶点仍留在 `positions` 缓冲里,但没有任何索引引用它们,见 §5).

**代价定位**:UI 的 `NUMERIC_CONFIG.limits.surface.maxSegments = 512`.512²
下,恒有定义曲面因短路而**不再有认证开销**;含除法的曲面认证本身约 70 ms,
叠在采样之上.若将来需要进一步压,优先考虑拖拽期间降分辨率,而不是放松
判据(放松判据等于把 §2.1 的盲区放回来).

---

## 5. 维护须知

**要守住的不变量**

1. `positions` 与 `normals` 的每个分量都是有限 f32.任何新增的顶点写出路径
   都必须过 `saturate_to_f32`(或等价的类型安全闸门);
2. 区间扩张只许放宽,不许收窄(§2.2);
3. 认证与 `real_pow` 的定义域语义必须一致(§2.3).

**改动入口**

- 新增一元内置函数:在 `builtins::MATH_FUNCTIONS` 的表项里补 `interval:` 字段
  (结构体字段,漏了编译不过),然后在 `interval_core::apply_unary` 与
  `unary_is_total` 里实现/表态 -- 这两个 `match` 是穷尽的,编译器会强制;
- 新增二元运算:改 `interval_core::evaluate_box` 的 `BinOp` 分支与
  `is_total`;
- 调细分深度:`config::CERTIFY_SUBDIVISION_DEPTH`(改大换覆盖率,代价见
  §4.1).

**不要做的事**

- 不要把 `SurfaceMesh._updateBounds` 里"跳过非有限顶点"改成"把非有限顶点
  清零":被剔除单元的 NaN 顶点**刻意**留在缓冲里,清零会把它们拉到原点,
  污染包围盒,而它们本就不该参与计算;
- 不要为了消除 L1 的缺失带而放宽判据(例如"格子中心有定义就算数"),那正好
  把 §2.1 的盲区请回来;
- 不要在 `compute_valid_cells` 里重新引入任何"跳变倍数"式阈值:曲面侧的
  那套常量已删除,重建即回退.

---

## 6. 复现与验证

```bash
# 认证内核(区间算术,三值判定,细分,totality 分析)
cargo test -p math_rs interval_core

# 四条通路 + 判据切换的回归
cargo test -p render_rs

# 全量门禁(fmt + clippy -D warnings + 全部测试)
npm run lint:rs
cargo test --workspace
npx vitest run

# 改完 Rust 后必须重建 wasm,否则 GUI 用的是旧产物
npm run build:wasm:render
```

回归用例与通路的对应关系:

| 通路 / 行为 | 用例 |
| --- | --- |
| P1 无定义 | `nan_surface_still_masks_cells`,`square_root_domain_is_respected`,`disk_domain_is_certified_cell_by_cell` |
| P2 f64->f32 溢出 | `finite_f64_beyond_f32_range_never_becomes_infinite_vertex`,`out_of_f32_range_axes_saturate_instead_of_overflowing` |
| P3 f32 法线溢出 | `vertex_normals_survive_coordinates_whose_cross_overflows_f32` |
| P4 GPU 零法线 | `unreferenced_vertices_get_a_fallback_normal_not_zero` |
| 判据:极点 | `tan_surface_drops_exactly_the_pole_cells`,`tangent_pole_is_detected_by_cosine_interval` |
| 判据:格内极点(旧版必漏) | `interior_pole_circle_inside_one_cell_is_dropped` |
| 判据:光滑过零不得误杀 | `smooth_zero_crossing_keeps_all_cells`,`gaussian_derivative_surface_keeps_all_cells`,`steep_smooth_surface_not_dropped`,`smooth_surface_keeps_all_cells` |
| 判据:幂的定义域对齐 | `integer_powers_accept_negative_bases`,`odd_rational_powers_accept_negative_bases` |
| 判据:细分化解 dependency | `dependency_problem_is_resolved_by_subdivision` |
| 判据:短路与全量一致 | `totality_analysis_is_conservative`,`total_shortcut_matches_full_certification` |
