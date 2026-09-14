/**
 * compute 层统一入口.
 *
 * 目的:渲染层/应用层只需要记住一条 import 路径 `math/compute`,不必知道
 * 调度原语,WASM 粘合与领域编组在内部怎么分目录
 * (`scheduling/` 调度原语,`wasm/` 粘合,`domain/` 领域编组).
 *
 * 注意:**从 barrel 导入不会提前创建 Worker**.各领域 client 的
 * `new Worker(...)` 都在 `() => ...` 工厂闭包里,只有第一次 `request` 才
 * fork(见 scheduling/ComputeWorkerClient 的 `_getWorker`).
 *
 * 测试要 mock 具体 client 时,请继续用深路径 `vi.mock('../domain/...')`:
 * barrel 只是 re-export,按路径拦截依然生效.
 *
 * `*Worker` 模块一律用 `export type *`:它们在顶层调用 `createWasmWorker`,
 * 只有 Worker 线程里才有 `self`;运行时 re-export 会让 node 环境的测试
 * 一 import barrel 就 "self is not defined".类型 re-export 会被完全擦除.
 */
export * from './ComputeFacade';
export * from './scheduling/ComputeWorkerClient';
export * from './scheduling/LatestRequestExecutor';
export * from './domain/curve/CurveComputeClient';
export * from './domain/surface/SurfaceComputeClient';
export * from './domain/vectorField/VectorFieldComputeClient';
export * from './domain/integral/IntegralCompute';
export * from './domain/intersection/IntersectionComputeClient';
export type * from './wasm/wasmWorkerRuntime';
export type * from './domain/curve/CurveWorker';
export type * from './domain/surface/SurfaceWorker';
export type * from './domain/vectorField/VectorFieldWorker';
export type * from './domain/integral/IntegralWorker';
export type * from './domain/intersection/IntersectionWorker';
