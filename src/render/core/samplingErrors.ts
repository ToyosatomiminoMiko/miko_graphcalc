/**
 * 渲染层内部采样错误上报通道.
 *
 * 曲线/曲面/向量场各自持有 Worker + LatestRequestExecutor,失败点分散在
 * renderer 内部.这里提供轻量发布/订阅,把采样失败统一交给应用层
 * (RenderController 转成诊断条目),不需要给每个渲染器构造函数注入回调.
 *
 * 本模块只做错误转发,不操作 DOM/诊断区,避免渲染层反向依赖 UI.
 */

export interface SamplingFailure {
    kind: 'curve' | 'surface' | 'vector_field';
    /** 对象名,例如曲线声明里的 `c1`. */
    name: string;
    message: string;
}

export type SamplingFailureListener = (failure: SamplingFailure) => void;

/**
 * @cache
 * 缓存目的:保存采样失败监听器注册表,供渲染器上报时逐个转发.
 * 键/失效策略:监听器集合;unsubscribe 时删除.
 * 生命周期:模块级,随页面存活.
 */
const listeners = new Set<SamplingFailureListener>();

/** 订阅采样失败事件,返回取消订阅函数(应用层 dispose 时必须调用). */
export function onSamplingFailure(
    listener: SamplingFailureListener,
): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** 渲染器在异步采样失败时调用,统一上报给应用层. */
export function reportSamplingFailure(failure: SamplingFailure): void {
    for (const listener of [...listeners]) {
        listener(failure);
    }
}
