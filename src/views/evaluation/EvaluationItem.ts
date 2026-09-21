/**
 * 求值 item 的基类与构造契约.
 *
 * 行即对象:摘要/细节/结果行/类型专属的中间态都由实例持有,异步数值回填就是实例
 * 方法(`renderValue`/`renderError`)--不再有 `{ row, result, bodyLatex }` 这种
 * "数据在句柄里,行为在自由函数里"的平行结构.加一类求值对象 = 加一个子类文件.
 *
 * 列表引擎只认两件与类型无关的事(见 {@link EvaluationItemClass}):
 * - `cacheKey`:**建 DOM 之前**算出的内容指纹,决定行能否整行复用.必须是静态
 *   方法:先建行再比键会让每次 `sync` 都白排一遍 KaTeX,恰好破坏"复用 = KaTeX
 *   不重排"这条不变量;
 * - 构造函数本身即工厂(带"本次键匹配的缓存数值"),于是类就是这一类的全部定义.
 *
 * `name(task)` 不在契约里:三类求值任务的 IR 都有 `name` 字段,列表引擎直接用
 * 字段取,不再要求每个 kind 各写一遍同样的函数.
 */
import type { SceneObject } from '@/contract/ir';
import type { ProcessDocument } from '@/adapters/processSteps';
import { carryDetailsOpen } from '@miko/ui';

/**
 * 打开过程页的请求:已经重组好的过程文档.
 *
 * 过程数据由条目自己在点击时构建(它知道自己的 IR 字段),应用层只负责切页
 * 与载入,不需要认识"梯度/积分"的差别.条目名不单独带一份--文档标题
 * (`ProcessDocument.title`)已经含它,回链用的也是同一个名字.
 */
export interface ProcessRequest {
    readonly document: ProcessDocument;
}

/**
 * 渲染求值 item 时的场景上下文.
 *
 * - `objects`:域对象解析(积分条目要把 `objectId` 还原成对象名)之类的跨条目
 *   依赖走这里,不往 item 里塞全局状态;
 * - `toggleHidden`:行末显隐按钮的回调,由 `EvaluationList` 按子列表绑到对应的
 *   `toggleAnalysis/toggleIntegral/toggleIntersection`.item 只负责把按钮建出来
 *   并接上它,不关心"隐藏后要重新编译"的流程;
 * - `openProcess`:行末"过程"入口的回调(三级披露的 L2).item 只负责按披露
 *   判据决定要不要建按钮,并在点击时给出过程文档,切页由应用层做.
 */
export interface EvaluationContext {
    readonly objects: readonly SceneObject[];
    /** 点击该条目的显隐按钮:切换隐藏态(不渲染 + 不参与计算). */
    readonly toggleHidden: (name: string) => void;
    /** 点击该条目的"过程"入口:切到过程页并载入该条目的过程. */
    readonly openProcess: (request: ProcessRequest) => void;
}

/**
 * item 类的构造契约(描述的是**静态侧**,所以约束写成"类必须长这样").
 *
 * @typeParam TTask   该类型的 IR 条目(如 `IntegralTask`);必须有 `name`.
 * @typeParam TResult 异步回填的数值类型(`number` 积分 / `IntersectionOutput`
 *                    求交);同步类型(分析)用 `void`.
 * @typeParam TItem   该类自己的实例类型,`EvaluationSection` 据此保留类型.
 */
export interface EvaluationItemClass<
    TTask extends { name: string },
    TResult,
    TItem extends EvaluationItem<TTask, TResult>,
> {
    readonly prototype: TItem;
    /** 会被渲染的内容指纹;变了就重建 DOM 行. */
    cacheKey(task: TTask, context: EvaluationContext): string;
    new (
        task: TTask,
        context: EvaluationContext,
        cached: TResult | null,
    ): TItem;
}

/**
 * 求值 item 基类:`row` 就是列表引擎要的句柄,展开态迁移与异步回填是本类/子类
 * 的方法,列表侧不再知道任何行内结构.
 */
export abstract class EvaluationItem<
    TTask extends { name: string },
    TResult = void,
> {
    /**
     * 本行是否给出 L2"过程"入口(即 `.row-actions` 里有没有那颗"过程"按钮).
     *
     * 入口的**有无**由三级披露判据决定(见 `ui/process/disclosure.ts`),与
     * 条目是否隐藏无关:隐藏只把本来存在的入口置灰,绝不凭空多出一颗按钮.
     *
     * 为什么是实例状态而不是构造参数:分析条目的判据来自**会被渲染的细节行数**,
     * 而隐藏项在编译期就跳过数值计算,隐藏后的 IR 里已经算不出这个长度.行重建
     * 时由 {@link preserveExpandedStateFrom} 从同名旧行继承这一事实--它正是
     * "重建行时带走与内容无关的用户可见状态"这条既有约定的第二个用例(第一个
     * 是 `<details>` 展开态).
     *
     * 默认 false:行末没有"过程"入口的条目(求交,实体)不必声明.
     */
    protected processEntryOffered = false;

    protected constructor(
        readonly task: TTask,
        readonly row: HTMLElement,
    ) {}

    /**
     * 行被替换时把 `<details>` 的展开态带到新行上.
     *
     * 数值变化必然重建行,但"用户把它展开了"与内容无关,不该在拖动滑块时被
     * 每帧重置.这条过去散在 `EvaluationSection` 里,现在任何 item 子类(以及
     * 将来的实体行,若它也有展开态)都直接用基类这一份.
     *
     * 子类可以覆写它多带一件同类状态(如"本行有没有'过程'入口",见
     * {@link processEntryOffered}),覆写时先调 `super`.
     */
    preserveExpandedStateFrom(previous: EvaluationItem<TTask, TResult>): void {
        carryDetailsOpen(previous.row, this.row);
    }

    /**
     * 异步数值回填:把结果排进自己这一行(等式行/状态行怎么变由子类决定).
     *
     * 默认空实现留给同步类型:分析条目的数值在编译期就算好了,`EvaluationList`
     * 不给它暴露回填入口,因此这里的空实现不会被调用.
     */
    renderValue(_value: TResult): void {}

    /** 异步失败回填:子类自己决定错误文案挂在哪一行;同步类型同 `renderValue`. */
    renderError(_message: string): void {}
}
