/**
 * 求值条目的"结构定义"契约.
 *
 * 背景:求值对象有三类(分析/积分/求交),它们要展示的数值形态完全不同--
 * - 分析:编译期就拿到全部数值,没有独立结果行,细节里全是数学公式;
 * - 积分:数值异步回来,要一条状态行(`计算中...`/数值/错误),细节里
 *   公式行 + 域/方法/分段等纯文本元信息;
 * - 求交:异步回来的是"交点/交线数量",只有一条纯文本结果行,细节是
 *   对象与采样分段.
 *
 * 过去这些差异全部内联在 `ui/ObjectListController.ts` 里(三份几乎重复的
 * 增删/排序/缓存循环 + 三份各自为政的建行函数),加一类求值对象就要动
 * 控制器本身.现在把"这一类条目长什么样"收敛成每类一份
 * {@link EvaluationKindSpec}:
 *
 * - **结构差异**(有哪些块,哪些是公式,哪些是元信息,有没有结果行)
 *   全部由该类型的 `build` 决定,定义在该类型自己的文件里;
 * - **列表差异**(DOM 行缓存,顺序,展开态保留,数值缓存,异步回填入口)
 *   由 `EvaluationSection` 统一处理,与类型无关.
 *
 * 新增一类求值对象 = 写一个 spec 文件 + 在控制器里挂一个 Section,
 * 不再需要复制那套增删/排序/缓存逻辑.
 */
import type { SceneObject } from '../../compiler/ir/types';
import type { KeyedRowHandles } from '../keyedRowList';

/**
 * 渲染求值条目时的场景上下文.
 *
 * - `objects`:目前只有域对象解析(积分条目要把 `objectId` 还原成对象名)需要它;
 *   以后有别的跨条目依赖(如求交的源对象标签)也走这里,不再往 spec 里
 *   塞全局状态;
 * - `toggleHidden`:行首显隐按钮的回调,由控制器按子列表绑定到对应的
 *   `toggleAnalysis/toggleIntegral/toggleIntersection`.spec 只负责把按钮
 *   建出来并接上它,不关心"隐藏后要重新编译"这些流程.
 */
export interface EvaluationContext {
    readonly objects: readonly SceneObject[];
    /** 点击该条目的显隐按钮:切换隐藏态(不渲染 + 不参与计算). */
    readonly toggleHidden: (name: string) => void;
}

/**
 * 折叠态摘要:彩色类型标签 + 变量名 + 一行公式.
 *
 * 公式排不出来时 `latex` 为 null,由 `text` 回退成纯文本(积分源对象被
 * 删除时就是这条路径),避免给半个公式.
 */
export interface EvaluationSummarySpec {
    /** 完整 class,如 `kind-analysis kind-analysis-gradient`. */
    badgeClass: string;
    badgeLabel: string;
    /** KaTeX 公式;null 时用 `text`. */
    latex: string | null;
    /** `latex === null` 时的纯文本回退. */
    text?: string;
}

/** 结果/状态行初态:`className` 决定 `计算中...`/`已隐藏`/`错误` 的配色. */
export interface EvaluationResultSpec {
    className: string;
    text: string;
}

/**
 * 行句柄:各类型可在 `build` 里返回自己的扩展句柄.
 *
 * `result` 可空是刻意的--积分条目的完整等式一旦由展开细节承载,独立状态
 * 行就会被摘掉,此时它是 null;求交/分析则各有各的形态.
 */
export interface EvaluationRowHandles extends KeyedRowHandles {
    /** 状态/结果行的落点;没有独立状态行时为 null. */
    result: HTMLElement | null;
}

/**
 * 一种求值对象的 HTML 结构定义.
 *
 * @typeParam TTask   该类型的 IR 条目(如 `IntegralTask`).
 * @typeParam TResult 异步回填的数值类型(`number` 积分 / `IntersectionOutput`
 *                    求交);同步类型(分析)用 `void`.
 * @typeParam THandles 该类型自己的行句柄,可携带 `bodyLatex` 这类只对它有
 *                     意义的中间态.
 */
export interface EvaluationKindSpec<TTask, TResult, THandles extends EvaluationRowHandles> {
    /** 类型标识,只用于诊断/调试. */
    readonly kind: string;
    /** 条目标识:DOM 行缓存与数值缓存的键(三种类型都叫 `name`). */
    name(task: TTask): string;
    /**
     * 会被渲染的内容指纹;变了就重建 DOM 行.
     *
     * 约定:键必须跟着**实际渲染出来的内容**走(摘要公式/细节行/启用态),
     * 不要罗列 IR 字段--漏字段会导致"源表达式变了细节不刷新",把只影响
     * 三维叠加层的字段算进来又会让纯视觉变化收起用户展开的细节.
     *
     * 隐藏态(`enabled === false`)由各类型的 `build` 自己呈现(加 `is-hidden`
     * 并给出"已隐藏"文案):列表引擎不读任务的启用位,所以这里也没有
     * `enabled(task)` 这类没有消费者的成员(见 UI-P3.4).
     */
    cacheKey(task: TTask, context: EvaluationContext): string;
    /**
     * 构建整行 DOM:摘要 + 可展开细节 + 结果行.
     *
     * "这一类长什么样"的全部差异都在这里;`result` 是与当前键匹配的
     * 已缓存数值(首次/失效时为 null).
     */
    build(task: TTask, context: EvaluationContext, result: TResult | null): THandles;
    /** 异步数值回填;同步类型不实现(如分析). */
    resolve?(handles: THandles, task: TTask, result: TResult): void;
    /** 异步失败回填;同步类型不实现. */
    reject?(handles: THandles, task: TTask, message: string): void;
}
