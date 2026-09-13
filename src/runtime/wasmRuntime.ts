import initCompiler from '../wasm/compiler_rs/compiler_rs';
import initMath from '../wasm/math_rs/math_rs';

/**
 * @cache
 * 缓存目的:主线程只初始化一次 compiler/math 两个 WASM 模块.
 * 键/失效策略:模块级单例;首次调用时创建 Promise,之后复用,永不失效.
 * 生命周期:随页面模块存活,应用销毁时无需显式释放.
 *
 * 注意:render_rs 不在此初始化.它仅被 SurfaceWorker 在 Worker 内自持
 * (且其 wasm 因依赖 math_rs,导出面含整个 math 引擎),主线程没有任何
 * render_rs 导出函数的调用方,预载只会白下载/实例化一份冗余模块.
 * 若未来主线程确实需要渲染侧计算,再把它加回这里.
 */
let wasmReady: Promise<void> | null = null;

/**
 * @cache_access
 * 主线程共享的 WASM 初始化入口,保证 parser 和 compiler 不会重复初始化.
 */
export function ensureWasmReady(): Promise<void> {
    if (!wasmReady) {
        wasmReady = Promise.all([
            initCompiler(),
            initMath(),
        ]).then(() => undefined);
    }
    return wasmReady;
}
