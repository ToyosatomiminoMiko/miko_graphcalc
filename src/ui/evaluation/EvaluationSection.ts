/**
 * 一个求值子列表(一种 kind):DOM 行缓存 + 顺序 + item 构造 + 数值缓存 +
 * 异步回填入口.
 *
 * 与类型无关:一类条目长什么样,异步数值怎么落到行上,全在传入的
 * {@link EvaluationItemClass}(即 item 类本身)里;行缓存/顺序那套增删复用循环由
 * {@link KeyedRowList} 承担(与实体列表共用同一份,见 UI-P3.8).`EvaluationList`
 * 的三个子列表(分析/积分/求交)各是一个 `EvaluationSection`,于是"增删行,保持
 * 顺序,替换行时保留展开态,数值回填命中缓存"这套逻辑只有一份.
 *
 * 行句柄就是 item 实例本身:不再有 `{ row, result, bodyLatex }` 这种与行为分离
 * 的数据袋,`resolve`/`reject` 直接调实例方法.
 *
 * 两层缓存:
 * - `KeyedRowList` 的 `rows`:条目名 -> { item, 内容键, 任务 };内容键一致就整行
 *   复用(KaTeX 不重排,用户展开态不丢);
 * - 本类的 `results`:条目名 -> { 内容键, 数值 };异步结果回来时按当时的键存,
 *   行被改写(键变了)后旧数值自然作废--列表回到"计算中",不会先显示上一次的答案.
 *
 * 过期结果的边界(与 UI-P3.12 一致,别把防线记在这一层):本层只在条目**已被删除**
 * 时丢弃回填;同名条目被改写(键变了)但旧请求的结果仍然到达的情形,由计算层的
 * latest-only 语义(`LatestRequestExecutor`)在上游丢弃.这里没有"请求发出时的键"
 * 可比较,因此注释不再承诺本层能识别改写.
 */
import { KeyedRowList } from '@/ui/shared/keyedRowList';
import {
    EvaluationItem,
    type EvaluationContext,
    type EvaluationItemClass,
} from './EvaluationItem';

export class EvaluationSection<
    TTask extends { name: string },
    TResult,
    TItem extends EvaluationItem<TTask, TResult>,
> {
    /** 条目名 -> 最近一次异步结果(带内容键,键变即作废). */
    private readonly results = new Map<string, { key: string; value: TResult }>();

    /** 行缓存与顺序由共用引擎负责(与实体列表同一份,见 UI-P3.8). */
    private readonly list: KeyedRowList<TTask, TItem>;

    constructor(
        container: HTMLElement,
        private readonly itemClass: EvaluationItemClass<TTask, TResult, TItem>,
    ) {
        this.list = new KeyedRowList(container);
    }

    /** 按 item 类增量刷新:删消失的,复用键相同的,重建键变了的. */
    render(tasks: readonly TTask[], context: EvaluationContext): void {
        this.list.sync(tasks, {
            // 三类任务的 IR 都有 `name`,条目标识直接用字段(item 类不再各写一遍).
            name: (task) => task.name,
            // 内容键必须在建行之前算出来:先建再比会让每次 sync 都白排一遍 KaTeX.
            key: (task) => this.itemClass.cacheKey(task, context),
            // 条目从 DSL 里消失(删除或改名)时必须连数值缓存一起删:只删 DOM 行
            // 会让 `results` 变成只增不减的 Map -- 每个用过的名字都永久留下一份
            // `IntersectionOutput`/积分值,来回改名就一直涨.这条钩子正是
            // KeyedRowList 提供给"调用方清自己的缓存"的唯一时机.
            onRemove: (name) => {
                this.results.delete(name);
            },
            build: (task, previous, key) => {
                // 只认与当前键一致的数值;键不一致时按"尚无结果"重新建行.
                const cached = this.results.get(task.name);
                const restored = cached !== undefined && cached.key === key
                    ? cached.value
                    : null;
                const item = new this.itemClass(task, context, restored);
                // 行被替换时把 <details> 的展开态带过去:数值变化必然重建行,
                // 但"用户把它展开了"与内容无关,不该在拖滑块时每帧重置.
                if (previous !== null) item.preserveExpandedStateFrom(previous);
                return item;
            },
        });
    }

    /**
     * 异步数值回填:存进数值缓存后交给 item 自己刷新 DOM.
     *
     * 条目已被删除时直接丢弃过期结果(同名条目被改写的过期判定在上游
     * latest-only,见文件头).
     */
    resolve(name: string, value: TResult): void {
        const entry = this.list.entry(name);
        if (!entry) return;
        this.results.set(name, { key: entry.key, value });
        entry.handles.renderValue(value);
    }

    /** 异步失败回填:先丢掉该条目的数值缓存(不让旧值残留在细节里). */
    reject(name: string, message: string): void {
        const entry = this.list.entry(name);
        if (!entry) return;
        this.results.delete(name);
        entry.handles.renderError(message);
    }

    /** 清空子列表容器与其全部 DOM/数值缓存. */
    clear(): void {
        this.list.clear();
        this.results.clear();
    }
}
