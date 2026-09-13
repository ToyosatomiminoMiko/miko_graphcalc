/**
 * 一个求值子列表的通用引擎:DOM 行缓存 + 顺序 + 展开态 + 数值缓存 +
 * 异步回填入口.
 *
 * 与类型无关:结构差异全在传入的 {@link EvaluationKindSpec} 里;行缓存/顺序那套
 * 增删复用循环由 {@link KeyedRowList} 承担(实体列表与这里共用同一份).控制器的
 * 三个子列表(分析/积分/求交)各是一个 `EvaluationSection`,于是"增删行,保持顺序,
 * 替换行时保留展开态,数值回填命中缓存"这套逻辑只有一份.
 *
 * 两层缓存:
 * - `KeyedRowList` 的 `rows`:条目名 -> { DOM 行, 内容键, 任务 };内容键一致就整行
 *   复用(KaTeX 不重排,用户展开态不丢);
 * - 本类的 `results`:条目名 -> { 内容键, 数值 };异步结果回来时按当时的键存,
 *   行被改写(键变了)后旧数值自然作废--列表回到"计算中",不会先显示上一次的答案.
 *
 * 过期结果的边界(与 UI-P3.12 一致,别把防线记在这一层):本层只在条目**已被删除**
 * 时丢弃回填;同名条目被改写(键变了)但旧请求的结果仍然到达的情形,由计算层的
 * latest-only 语义(`LatestRequestExecutor`)在上游丢弃.这里没有"请求发出时的键"
 * 可比较,因此注释不再承诺本层能识别改写.
 */
import { carryDetailsOpen } from './rowDom';
import { KeyedRowList } from '../keyedRowList';
import type {
    EvaluationContext,
    EvaluationKindSpec,
    EvaluationRowHandles,
} from './rowTypes';

export class EvaluationSection<
    TTask,
    TResult,
    THandles extends EvaluationRowHandles,
> {
    /** 条目名 -> 最近一次异步结果(带内容键,键变即作废). */
    private readonly results = new Map<string, { key: string; value: TResult }>();

    /** 行缓存与顺序由共用引擎负责(与实体列表同一份,见 UI-P3.8). */
    private readonly list: KeyedRowList<TTask, THandles>;

    constructor(
        container: HTMLElement,
        private readonly spec: EvaluationKindSpec<TTask, TResult, THandles>,
    ) {
        this.list = new KeyedRowList(container);
    }

    /** 按 spec 结构增量刷新:删消失的,复用键相同的,重建键变了的. */
    render(tasks: readonly TTask[], context: EvaluationContext): void {
        this.list.sync(tasks, {
            name: (task) => this.spec.name(task),
            key: (task) => this.spec.cacheKey(task, context),
            build: (task, previous, key) => {
                // 只认与当前键一致的数值;键不一致时按"尚无结果"重新建行.
                const cached = this.results.get(this.spec.name(task));
                const restored = cached !== undefined && cached.key === key
                    ? cached.value
                    : null;
                const handles = this.spec.build(task, context, restored);
                // 行被替换时把 <details> 的展开态带过去:数值变化必然重建行,
                // 但"用户把它展开了"与内容无关,不该在拖滑块时每帧重置.
                if (previous !== null) {
                    carryDetailsOpen(previous.row, handles.row);
                }
                return handles;
            },
            onRemove: (name) => {
                this.results.delete(name);
            },
        });
    }

    /**
     * 异步数值回填:存进数值缓存后交给类型定义刷新 DOM.
     *
     * 条目已被删除时直接丢弃过期结果(同名条目被改写的过期判定在上游
     * latest-only,见文件头).
     */
    resolve(name: string, value: TResult): void {
        const entry = this.list.entry(name);
        if (!entry) return;
        this.results.set(name, { key: entry.key, value });
        this.spec.resolve?.(entry.handles, entry.item, value);
    }

    /** 异步失败回填:先丢掉该条目的数值缓存(不让旧值残留在细节里). */
    reject(name: string, message: string): void {
        const entry = this.list.entry(name);
        if (!entry) return;
        this.results.delete(name);
        this.spec.reject?.(entry.handles, entry.item, message);
    }

    /** 清空子列表容器与其全部 DOM/数值缓存. */
    clear(): void {
        this.list.clear();
        this.results.clear();
    }
}
