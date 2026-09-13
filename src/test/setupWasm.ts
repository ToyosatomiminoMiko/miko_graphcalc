/**
 * vitest 启动钩子:同步初始化 Rust/WASM 模块.
 *
 * 为什么需要:`runtime/wasmRuntime.ts` 的懒加载调用 wasm-bindgen 生成的
 * 默认初始化,Node 环境下它会 `fetch(new URL('*.wasm', import.meta.url))`,
 * 而 Node 的 fetch 不支持 file:// 协议(vitest 默认 environment 为 node),
 * 于是解析器集成测试直接 "fetch failed".
 *
 * 这里改成同步初始化:从磁盘读 .wasm 字节交给 wasm-bindgen 的 initSync.
 * 两个模块都是模块级单例,这里先初始化后,`ensureWasmReady()` 里的
 * `initCompiler()/initMath()` 会因实例已存在而立刻返回,不会重复实例化.
 */
import { readFile } from 'node:fs/promises';
import { initSync as initCompilerSync } from '../wasm/compiler_rs/compiler_rs';
import { initSync as initMathSync } from '../wasm/math_rs/math_rs';

const compilerWasm = await readFile(
    new URL('../wasm/compiler_rs/compiler_rs_bg.wasm', import.meta.url),
);
const mathWasm = await readFile(
    new URL('../wasm/math_rs/math_rs_bg.wasm', import.meta.url),
);

// wasm-bindgen 新签名收 `{ module }`;字节内容由 harness 包成 WebAssembly.Module.
initCompilerSync({ module: compilerWasm });
initMathSync({ module: mathWasm });
