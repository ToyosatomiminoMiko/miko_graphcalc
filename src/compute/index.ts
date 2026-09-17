/**
 * compute 层对外入口(信息隐藏的收口处).
 *
 * 这一层负责"IR 里的表达式 -> Worker + Rust/WASM 的数值结果":调度原语,
 * WASM 粘合与领域编组都在内部(`scheduling/` 内部调度,`domain/` 领域编组,
 * Worker 粘合在 `wasm/` 与各 `*Worker` 模块).渲染层/应用层只需要记住这一条
 * import 路径,不必知道内部分目录.
 *
 * 只导出**跨层需要**的东西:
 * - `ComputeFacade` 与领域 client 单例/请求函数(渲染层的调用面);
 * - `*WorkerRequest` / `*WorkerResponse` 线协议类型(渲染层给请求定型);
 * - 结果类型(`CurveSampleResult` / `IntegralResult` 等).
 *
 * 刻意**不**导出 `ComputeWorkerClient` 这类调度内部实现:它们只在 compute 层
 * 内部与单元测试的深路径里出现(测试 mock 具体 client 时继续用
 * `vi.mock('@/compute/domain/...')`,barrel 只是 re-export,按路径拦截依然生效).
 * 通用的 latest-only 调度原语 `LatestRequestExecutor` / `RequestClient` 属
 * 跨层原语,已上移到 `core/LatestRequestExecutor`,需要时直接从那里导入.
 *
 * 注意:**从 barrel 导入不会提前创建 Worker**.各领域 client 的
 * `new Worker(...)` 都在 `() => ...` 工厂闭包里,只有第一次 `request` 才
 * fork(见 scheduling/ComputeWorkerClient 的 `_getWorker`).
 *
 * `*Worker` 模块一律用 `export type *`:它们在顶层调用 `createWasmWorker`,
 * 只有 Worker 线程里才有 `self`;运行时 re-export 会让 node 环境的测试
 * 一 import barrel 就 "self is not defined".类型 re-export 会被完全擦除.
 */
export * from './ComputeFacade';
export * from './domain/curve/CurveComputeClient';
export * from './domain/surface/SurfaceComputeClient';
export * from './domain/vectorField/VectorFieldComputeClient';
export * from './domain/integral/IntegralCompute';
export * from './domain/intersection/IntersectionComputeClient';
export type * from './domain/curve/CurveWorker';
export type * from './domain/surface/SurfaceWorker';
export type * from './domain/vectorField/VectorFieldWorker';
export type * from './domain/integral/IntegralWorker';
export type * from './domain/intersection/IntersectionWorker';
