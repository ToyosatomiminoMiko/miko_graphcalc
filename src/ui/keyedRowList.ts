/**
 * 带键 DOM 行列表:实体列表与求值子列表**共用的唯一一份**行缓存机制.
 *
 * 三条与类型无关的不变量只有这一处实现:
 * 1. `name` 命中且内容键(`key`)相同 -> 整行复用:KaTeX 不重排,用户展开态不丢,
 *    文本选择不丢;
 * 2. 首次出现或内容键变了 -> 交给 `build` 重建,同名旧行先摘除;
 * 3. 消失的条目连行一起删除,其余行按输入数组顺序摆放(见 `appendInOrder`).
 *
 * 为什么抽出来:`ObjectListController._renderEntities` 与
 * `evaluation/EvaluationSection.render` 曾是同一套增删/排序/缓存循环的两份拷贝
 * (见 UI-P3.8),后续任何顺序/缓存策略调整都要改两处.类型差异(有没有展开细节,
 * 结果行,异步数值缓存)留在各自的 `build` 与调用方里.
 */

/** 行句柄的下限:任何行至少有一个根元素. */
export interface KeyedRowHandles {
    readonly row: HTMLElement;
}

export interface KeyedRowHooks<TItem, THandles extends KeyedRowHandles> {
    /** 条目标识;DOM 行缓存与调用方数值缓存的键. */
    name(item: TItem): string;
    /**
     * 会被渲染的内容指纹;变了就重建 DOM 行.
     *
     * 约定:键必须跟着**实际渲染出来的内容**走,不要罗列 IR 字段--漏字段会导致
     * "源表达式变了细节不刷新",把只影响三维叠加层的字段算进来又会让纯视觉变化
     * 收起用户展开的细节.
     */
    key(item: TItem): string;
    /**
     * 构建整行,`previous` 是同名旧行的句柄(首次出现或已删除时为 null),
     * `key` 是本次同步算出的内容键(调用方据此判断缓存数值是否还有效).
     */
    build(item: TItem, previous: THandles | null, key: string): THandles;
    /** 条目从列表消失时回调;调用方据此清自己的数值缓存. */
    onRemove?(name: string): void;
}

interface KeyedRowEntry<TItem, THandles> {
    handles: THandles;
    key: string;
    item: TItem;
}

export class KeyedRowList<TItem, THandles extends KeyedRowHandles> {
    private readonly rows = new Map<string, KeyedRowEntry<TItem, THandles>>();

    constructor(private readonly container: HTMLElement) {
        // 容器在 DOM 里只是普通 <div>;显式给列表语义,读屏才会报"列表/列表项",
        // 而不是把每条读成孤立的一段.
        container.setAttribute('role', 'list');
    }

    /** 按 hooks 增量刷新:删消失的,复用键相同的,重建键变了的. */
    sync(items: readonly TItem[], hooks: KeyedRowHooks<TItem, THandles>): void {
        const nextNames = new Set(items.map((item) => hooks.name(item)));

        for (const [name, entry] of this.rows) {
            if (nextNames.has(name)) continue;
            entry.handles.row.remove();
            this.rows.delete(name);
            hooks.onRemove?.(name);
        }

        const ordered: HTMLElement[] = [];
        for (const item of items) {
            const name = hooks.name(item);
            const key = hooks.key(item);
            const existing = this.rows.get(name);

            if (existing && existing.key === key) {
                ordered.push(existing.handles.row);
                continue;
            }

            const handles = hooks.build(item, existing?.handles ?? null, key);
            if (existing) existing.handles.row.remove();
            this.rows.set(name, { handles, key, item });
            ordered.push(handles.row);
        }

        appendInOrder(this.container, ordered);
    }

    /** 取当前同名条目的句柄/键/条目(异步回填用). */
    entry(name: string): KeyedRowEntry<TItem, THandles> | undefined {
        return this.rows.get(name);
    }

    /** 清空容器与全部行缓存. */
    clear(): void {
        this.container.replaceChildren();
        this.rows.clear();
    }
}

/**
 * 按目标顺序摆放列表行.
 *
 * 缓存命中时行**留在原地**,所以数组顺序变了(DSL 里新增/调序,或只有部分条目
 * 因为内容变化被重建)DOM 顺序不会自己跟上,替换过的行还会被 append 到末尾造成
 * 跳位.这里只在顺序确实不一致时才按顺序 append 一遍(对已有子节点来说 append 是
 * "搬移"),顺序一致时一次 DOM 都不动.
 */
export function appendInOrder(
    container: HTMLElement,
    rows: readonly HTMLElement[],
): void {
    const current = container.children;
    let same = current.length === rows.length;
    if (same) {
        for (let index = 0; index < rows.length; index += 1) {
            if (current[index] !== rows[index]) {
                same = false;
                break;
            }
        }
    }
    if (same) return;
    for (const row of rows) container.append(row);
}
