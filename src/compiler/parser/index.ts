import { parse_miko } from '../../wasm/compiler_rs/compiler_rs';
import { ensureWasmReady } from '../../runtime/wasmRuntime';
import type { AstProgram } from '../ast/types';

/**
 * parser (compiler/compiler_rs/src/lib.rs) 包对外的唯一解析入口:
 * 先初始化 WASM,再调用 Rust pest 解析器.
 *
 * 曾与 parseMiko 并存的 MATLAB 兼容层(parseMatlab + matlabCompat.ts,
 * 含 matlabCompat.test.ts)已整体删除;`.miko` 就是唯一输入语法,不再
 * 维护第二套归一化入口.若未来要支持 MATLAB 输入,应重新引入兼容层并
 * 真正接入 UI,而不是保留一个无人调用的公共出口.
 * WASM 矩阵后端见 `compiler/matrixOps.ts`,不在这里混入解析入口.
 */

/** 调用 Rust pest 解析器,把 `.miko` 源码解析成 JSON AST. */
export async function parseMiko(source: string): Promise<AstProgram> {
    await ensureWasmReady();
    // pub fn parse_miko(source: &str) -> Result<String, JsValue>
    return JSON.parse(parse_miko(source)) as AstProgram;
}
