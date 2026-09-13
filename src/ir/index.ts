/**
 * IR 统一入口.
 *
 * `src/ir/**` 是零依赖叶子:不 import `math/`,`compiler/`,`config/`,
 * `render/`.语言层与渲染层都从这里取"纯数据"契约.
 */
export * from './types';
