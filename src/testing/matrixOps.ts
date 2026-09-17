/**
 * 测试注入用的矩阵后端:直接复用生产 WASM 实现.
 *
 * 为什么不再保留纯 JS 参考实现(202609 删除 `math/matrix/testBackend.ts`):
 * 矩阵公式的唯一真值是 Rust `math_rs::transform_core`,它的单测就在
 * `transform_core.rs` 的 `mod tests` 里.以前 JS/Rust 各有一份公式,两边都要
 * 维护,还可能悄悄分叉;现在测试注入的就是生产那一个后端,公式只在 Rust 里
 * 有一份,"JS 侧算得对"不再是一条独立的真值来源.
 *
 * 单独放在 `src/testing/` 而不是让每个测试各自 `import` 生产模块:一是
 * `render/**` 与 `compiler/**` 不必为了测试互相依赖(生产里两边都只通过
 * 注入的 `MatrixOps` 接口拿后端),二是"测试注入生产后端"这条约定只有一处声明.
 *
 * `testing/setupWasm.ts` 已在启动时同步初始化 WASM,所以模块级构造即可直接调用.
 */
import { createWasmMatrixOps } from '@/wasm/matrixOps';
import type { MatrixOps } from '@/math/matrix/MatrixOps';

/** 与生产同源的矩阵后端,供测试注入 `compileScene`/`AnimationPlayer`. */
export const testMatrixOps: MatrixOps = createWasmMatrixOps();
