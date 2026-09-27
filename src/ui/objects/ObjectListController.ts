/**
 * 对象列表的装配入口:实体对象窗口一栏 + 求值对象窗口一栏.
 *
 * 本体只有装配与转发,两栏各自的类负责其余的事:
 * - {@link EntityList}(`ui/entity/EntityList.ts`):实体窗口,行结构在
 *   `ui/entity/EntityItem.ts`;
 * - {@link EvaluationList}(`ui/evaluation/EvaluationList.ts`):求值窗口,分析/积分/求交/求解/
 *   原函数/微分方程子列表,行结构在 `ui/evaluation/*Item.ts`.
 *
 * 控制器对外的面孔保持不变(渲染层只认 `renderScene` 与四个异步回填入口),
 * 于是"列表怎么分,行怎么建"的改动不外溢到 `RenderController`/`DslApp`.
 *
 * 行内**没有自建的开合按钮**:开合交给 `<details>/<summary>` 原生行为.行末的
 * **显隐按钮**是另一回事:它是业务动作(不渲染 + 不参与计算),点它走
 * {@link ObjectListHandlers} 回调,由 DslApp 决定的编译/渲染流程处理;按钮在
 * 行末,与主内容包装同级,不在 `<summary>` 里,所以不会连带开合细节.
 */
import type {
    IntersectionOutput,
    SceneIR,
} from '@/contract/ir';
import { EntityList } from '@/ui/entity/EntityList';
import { EvaluationList, type EvaluationListHandlers } from '@/ui/evaluation/EvaluationList';

/**
 * 对象列表容器:实体 1 个 + 求值 6 个子列表.
 *
 * 用具名对象而不是一长串同类型的 `HTMLElement` 位置参数:位置参数交换任意两个
 * 都能通过类型检查,只会把求值条目渲染进错误的容器(见 UI-P3.9).
 */
export interface ObjectListContainers {
    readonly entity: HTMLElement;
    readonly analysis: HTMLElement;
    readonly integral: HTMLElement;
    readonly intersection: HTMLElement;
    readonly solve: HTMLElement;
    readonly antiderivative: HTMLElement;
    readonly ode: HTMLElement;
}

/**
 * 行末显隐按钮的回调:控制器只负责"用户点了哪一条",隐藏的语义
 * (不渲染 + 不参与计算)由应用层实现.
 *
 * - 实体:直接切换场景对象的可见性,不重新编译;
 * - 分析/积分/求交/求解:切隐藏集合后按当前参数重新编译,让数值计算或求解内核被跳过.
 *
 * 求值侧那 7 条**不在这里重写**:它们就是 {@link EvaluationListHandlers},
 * 本接口只多一条 `toggleEntity`(实体在左栏,求值列表不认识它).于是 `handlers`
 * 可以原样转交给 `EvaluationList`,不必再把同样的字段名抄第二遍.
 */
export interface ObjectListHandlers extends EvaluationListHandlers {
    /** 实体行末按钮:实体显隐不重新编译,直接改渲染可见性. */
    toggleEntity(id: number): void;
}

export class ObjectListController {
    /** 左栏:实体列表(行结构在 `entity/EntityItem`). */
    private readonly entities: EntityList;

    /** 右栏:求值列表(各类 kind 子列表的集合). */
    private readonly evaluations: EvaluationList;

    constructor(
        containers: ObjectListContainers,
        handlers: ObjectListHandlers,
    ) {
        this.entities = new EntityList(containers.entity, {
            toggleEntity: (id) => handlers.toggleEntity(id),
        });
        this.evaluations = new EvaluationList(
            {
                analysis: containers.analysis,
                integral: containers.integral,
                intersection: containers.intersection,
                solve: containers.solve,
                antiderivative: containers.antiderivative,
                ode: containers.ode,
            },
            // 求值侧 7 条原样转交:接口关系已由 `extends` 说明,这里不再抄字段名.
            handlers,
        );
    }

    renderScene(scene: SceneIR): void {
        this.entities.render(scene.objects, scene.objectFormulas);
        this.evaluations.render(scene);
    }

    /**
     * @cache_access
     * 命中积分 item 并回填数值(完整等式由展开细节的等式行承载).
     */
    setIntegralResult(name: string, value: number): void {
        this.evaluations.setIntegralResult(name, value);
    }

    /**
     * @cache_access
     * 命中积分 item 并更新错误文本.
     */
    setIntegralError(name: string, message: string): void {
        this.evaluations.setIntegralError(name, message);
    }

    /**
     * @cache_access
     * 命中求交 item 并更新结果摘要.
     */
    setIntersectionResult(name: string, output: IntersectionOutput): void {
        this.evaluations.setIntersectionResult(name, output);
    }

    /**
     * @cache_access
     * 命中求交 item 并更新错误文本.
     */
    setIntersectionError(name: string, message: string): void {
        this.evaluations.setIntersectionError(name, message);
    }

    /**
     * @cache_access
     * 清空两栏及其全部 DOM 行缓存与数值缓存.
     */
    clear(): void {
        this.entities.clear();
        this.evaluations.clear();
    }

    dispose(): void {
        this.clear();
    }
}
