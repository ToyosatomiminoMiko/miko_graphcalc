/**
 * 实体列表(footer 左栏):场景对象一行一条.
 *
 * 与右栏 `EvaluationList` 对称:列表层只做"按内容键增删/复用/排序",行内结构
 * 全在 item 类({@link EntityItem})里.行缓存/顺序由
 * {@link KeyedRowList} 承担--与求值的三个子列表共用同一份实现(见 UI-P3.8),
 * 因此"顺序/缓存"策略只有一处.
 */
import type { SceneObject } from '../../ir';
import { KeyedRowList } from '../shared/keyedRowList';
import { EntityItem } from './EntityItem';

/**
 * 行末显隐按钮的回调:请求方只报"用户点了哪一条",隐藏的语义(不渲染)以及
 * 是否要重新编译由应用层决定(实体显隐不重新编译,直接改渲染可见性).
 */
export interface EntityListHandlers {
    toggleEntity(id: number): void;
}

export class EntityList {
    /** 行缓存与顺序由共用引擎负责(与求值子列表同一份,见 UI-P3.8). */
    private readonly rows: KeyedRowList<SceneObject, EntityItem>;

    constructor(
        container: HTMLElement,
        private readonly handlers: EntityListHandlers,
    ) {
        this.rows = new KeyedRowList(container);
    }

    /**
     * @cache_access
     * 按对象 id + 内容键复用/替换实体行,并按场景数组顺序摆放.
     */
    render(
        objects: readonly SceneObject[],
        formulas: Readonly<Record<number, string | null>>,
    ): void {
        this.rows.sync(objects, {
            name: (object) => String(object.id),
            key: (object) => EntityItem.cacheKey(
                object,
                formulas[object.id] ?? null,
            ),
            build: (object) => new EntityItem(
                object,
                formulas[object.id] ?? null,
                () => this.handlers.toggleEntity(object.id),
            ),
        });
    }

    /**
     * @cache_access
     * 清空列表容器与其全部 DOM 行缓存.
     */
    clear(): void {
        this.rows.clear();
    }
}
