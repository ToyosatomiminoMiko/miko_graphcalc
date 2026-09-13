/**
 * footer 对象列表控制器.
 *
 * 左栏展示场景实体对象,右栏展示分析与积分等求值结果.
 *
 * 求值条目(分析/积分/求交)的**结构差异**按类型分别定义在
 * `ui/evaluation/*Row.ts`:`analysisRow` / `integralRow` / `intersectionRow`
 * 各给一份 `EvaluationKindSpec`--"这一类有哪些块,哪些是公式,哪些是元信息,
 * 有没有结果行,结果行怎么被异步回填"全在那一份定义里.
 *
 * 控制器本身只负责三件与类型无关的事:
 * 1. 实体列表(`_renderEntities`;行缓存/顺序复用与求值子列表同一份
 *    `KeyedRowList`);
 * 2. 把三个求值子列表挂成 `EvaluationSection`(DOM 行缓存/顺序/展开态/
 *    数值缓存/异步回填入口的统一实现);
 * 3. 对外转发渲染层的异步结果回调(`setIntegralResult` 等).
 *
 * 行内**没有自建的开合按钮**:开合交给 `<details>/<summary>` 原生行为
 * (摘要行就是 `<summary>`,点它由浏览器开合).行首的**显隐按钮**是另一回事:
 * 它是业务动作(不渲染 + 不参与计算),点它走 {@link ObjectListHandlers}
 * 回调,由 DslApp 决定的编译/渲染流程处理;按钮是 `.object-main` 的兄弟,
 * 不在 `<summary>` 里,所以不会连带开合细节.
 */
import type {
    AnalysisResult,
    IntegralTask,
    IntersectionOutput,
    IntersectionTask,
    SceneIR,
    SceneObject,
} from '../compiler/ir/types';
import { createFormulaElement } from './FormulaView';
import { EvaluationSection } from './evaluation/EvaluationSection';
import {
    analysisRowSpec,
} from './evaluation/analysisRow';
import {
    integralRowSpec,
    type IntegralRowHandles,
} from './evaluation/integralRow';
import {
    intersectionRowSpec,
    type IntersectionRowHandles,
} from './evaluation/intersectionRow';
import {
    createElement,
    createVisibilityButton,
} from './evaluation/rowDom';
import type { EvaluationRowHandles } from './evaluation/rowTypes';
import { KeyedRowList, type KeyedRowHandles } from './keyedRowList';
import { formatNumber, formatVector } from './numberText';

const ENTITY_KIND_LABELS: Record<SceneObject['kind'], string> = {
    curve: '曲线',
    surface: '曲面',
    vector_field: '向量场',
    point: '点',
    vector: '向量',
    sphere: '球体',
    box: '方块',
    conic: '旋转体',
    region: '区域',
    implicit: '隐式场',
};

function sceneObjectExpression(object: SceneObject): string {
    switch (object.kind) {
        case 'curve':
        case 'surface':
            return object.expr;
        case 'vector_field':
            return `[${object.components.join(', ')}]`;
        case 'point':
        case 'vector':
            return object.expr;
        case 'sphere':
            return `中心=${formatVector([object.position.x, object.position.y, object.position.z])} · r=${formatNumber(object.radius)}`;
        case 'box':
            return `中心=${formatVector([object.position.x, object.position.y, object.position.z])} · size=${formatVector(object.size)}`;
        case 'conic':
            return `中心=${formatVector([object.position.x, object.position.y, object.position.z])} · base=${formatNumber(object.baseRadius)} · top=${formatNumber(object.topRadius)} · h=${formatNumber(object.height)}`;
        case 'region':
            return `边界=${object.curveAName}, ${object.curveBName} · x∈[${formatNumber(object.range[0])}, ${formatNumber(object.range[1])}]`;
        case 'implicit':
            // V1 只有方程本体,没有自有网格;摘要直接给 `f = level`.
            return `${object.expr} = ${formatNumber(object.level)} · ${object.dim}D`;
    }
}

/** 旋转体的 UI 名称由实际上下底半径推出,而不是按 DSL 关键字固定. */
function sceneObjectKindLabel(object: SceneObject): string {
    if (object.kind !== 'conic') {
        return ENTITY_KIND_LABELS[object.kind];
    }
    // 上下底都为 0 是退化体,既不是圆柱也不是圆锥,回退到通用名.
    if (object.baseRadius < 1e-9 && object.topRadius < 1e-9) {
        return ENTITY_KIND_LABELS.conic;
    }
    if (Math.abs(object.topRadius - object.baseRadius) < 1e-9) {
        return '圆柱';
    }
    if (object.topRadius < 1e-9) {
        return '圆锥';
    }
    return '圆台';
}

/**
 * 实体条目 key:徽章文案 + 实际渲染出来的表达式/文本 + 显隐态.
 *
 * `objectFormulas` 给 null 时回退到 `sceneObjectExpression(object)` 的纯文本,
 * 两种形态要分别计入键,否则"公式 -> 文本"的回退不会被重绘.
 */
function entityKey(object: SceneObject, formula: string | null): string {
    return JSON.stringify([
        object.kind,
        object.id,
        object.name ?? null,
        object.enabled,
        sceneObjectKindLabel(object),
        formula,
        formula === null ? sceneObjectExpression(object) : null,
    ]);
}

/**
 * footer 四个列表容器.
 *
 * 用具名对象而不是四个同类型的 `HTMLElement` 位置参数:位置参数交换任意两个
 * 都能通过类型检查,只会把求值条目渲染进错误的容器(见 UI-P3.9).
 */
export interface ObjectListContainers {
    readonly entity: HTMLElement;
    readonly analysis: HTMLElement;
    readonly integral: HTMLElement;
    readonly intersection: HTMLElement;
}

/**
 * 行首显隐按钮的回调:控制器只负责"用户点了哪一条",隐藏的语义
 * (不渲染 + 不参与计算)由应用层实现.
 *
 * - 实体:直接切换场景对象的可见性,不重新编译;
 * - 分析/积分/求交:切隐藏集合后按当前参数重新编译,让数值计算被跳过.
 */
export interface ObjectListHandlers {
    toggleEntity(id: number): void;
    toggleAnalysis(name: string): void;
    toggleIntegral(name: string): void;
    toggleIntersection(name: string): void;
}

export class ObjectListController {
    /**
     * @cache
     * 缓存目的:复用实体列表 DOM 行--参数拖动时 renderScene 每帧重跑,
     * 整棵重建会在模板缓存里反复 clone,也会丢掉用户在列表里的文本选择.
     * 键/失效策略:对象 id -> { row, key };key 由徽章文案与实际展示的
     * 表达式/文本组成(见 entityKey),内容不变就复用.行缓存/顺序由
     * `KeyedRowList` 承担,与求值子列表共用同一份实现(见 UI-P3.8).
     * 生命周期:跟随 ObjectListController 实例.
     */
    private readonly entityRows: KeyedRowList<SceneObject, KeyedRowHandles>;

    /** 分析子列表:结构定义见 `evaluation/analysisRow.ts`. */
    private readonly analysisSection: EvaluationSection<
        AnalysisResult,
        void,
        EvaluationRowHandles
    >;

    /** 积分子列表:结构定义见 `evaluation/integralRow.ts`. */
    private readonly integralSection: EvaluationSection<
        IntegralTask,
        number,
        IntegralRowHandles
    >;

    /** 求交子列表:结构定义见 `evaluation/intersectionRow.ts`. */
    private readonly intersectionSection: EvaluationSection<
        IntersectionTask,
        IntersectionOutput,
        IntersectionRowHandles
    >;

    constructor(
        containers: ObjectListContainers,
        private readonly handlers: ObjectListHandlers,
    ) {
        // 四个容器在 DOM 里只是普通 <div>;各 Section/KeyedRowList 构造时显式给
        // 列表语义,读屏才会报"列表/列表项",而不是把每条读成孤立的一段.
        this.entityRows = new KeyedRowList(containers.entity);
        this.analysisSection = new EvaluationSection(
            containers.analysis,
            analysisRowSpec,
        );
        this.integralSection = new EvaluationSection(
            containers.integral,
            integralRowSpec,
        );
        this.intersectionSection = new EvaluationSection(
            containers.intersection,
            intersectionRowSpec,
        );
    }

    renderScene(scene: SceneIR): void {
        this._renderEntities(scene.objects, scene.objectFormulas);
        // 三个子列表的显隐回调各自绑定到对应的切换入口:spec 只管把按钮
        // 接上 `context.toggleHidden`,不关心重新编译的流程.
        this.analysisSection.render(scene.analyses, {
            objects: scene.objects,
            toggleHidden: (name) => this.handlers.toggleAnalysis(name),
        });
        this.integralSection.render(scene.integrals, {
            objects: scene.objects,
            toggleHidden: (name) => this.handlers.toggleIntegral(name),
        });
        this.intersectionSection.render(scene.intersections, {
            objects: scene.objects,
            toggleHidden: (name) => this.handlers.toggleIntersection(name),
        });
    }

    /**
     * @cache_access
     * 命中积分 DOM 行缓存并回填数值:完整等式由展开细节的等式行唯一承载,
     * 状态行在就绪后被摘掉(见 integralRow.ts 的 `renderIntegralValue`).
     */
    setIntegralResult(name: string, value: number): void {
        this.integralSection.resolve(name, value);
    }

    /**
     * @cache_access
     * 命中积分 DOM 行缓存并更新错误文本.
     */
    setIntegralError(name: string, message: string): void {
        this.integralSection.reject(name, message);
    }

    /**
     * @cache_access
     * 命中求交 DOM 行缓存并更新结果摘要.
     */
    setIntersectionResult(name: string, output: IntersectionOutput): void {
        this.intersectionSection.resolve(name, output);
    }

    /**
     * @cache_access
     * 命中求交 DOM 行缓存并更新错误文本.
     */
    setIntersectionError(name: string, message: string): void {
        this.intersectionSection.reject(name, message);
    }

    /**
     * @cache_access
     * 清空四个列表及其全部 DOM 行缓存与数值缓存.
     */
    clear(): void {
        this.entityRows.clear();
        this.analysisSection.clear();
        this.integralSection.clear();
        this.intersectionSection.clear();
    }

    dispose(): void {
        this.clear();
    }

    /**
     * @cache_access
     * 根据实体 key 复用或替换实体 DOM 行,并按场景数组顺序摆放.
     */
    private _renderEntities(
        objects: SceneObject[],
        objectFormulas: Record<number, string | null>,
    ): void {
        this.entityRows.sync(objects, {
            name: (object) => String(object.id),
            key: (object) => entityKey(object, objectFormulas[object.id] ?? null),
            build: (object) => ({
                row: this._createEntityRow(
                    object,
                    objectFormulas[object.id] ?? null,
                ),
            }),
        });
    }

    private _createEntityRow(
        object: SceneObject,
        formula: string | null,
    ): HTMLElement {
        const row = createElement('article', 'object-row entity-row');
        row.setAttribute('role', 'listitem');
        row.classList.toggle('is-hidden', !object.enabled);

        const badge = createElement(
            'span',
            `kind-badge kind-${object.kind}`,
            sceneObjectKindLabel(object),
        );

        const main = createElement('div', 'object-main');
        const name = createElement('strong', 'object-name', object.name ?? `#${object.id}`);
        const expression = formula
            ? createFormulaElement(formula, 'object-expr')
            : createElement(
                'code',
                'object-expr',
                sceneObjectExpression(object),
            );
        main.append(name, expression);
        // 隐藏原来只靠 is-hidden 的透明度:再补一条文字状态,色觉/低对比度
        // 用户也能看出这个对象被排除了.
        if (!object.enabled) {
            main.append(createElement('span', 'row-state', '已隐藏'));
        }

        // 行首显隐按钮:点它切换该实体是否参与渲染与计算.按钮与 main 平级,
        // 不在任何 <summary> 里,不会与列表开合互相干扰.
        const toggle = createVisibilityButton(
            object.enabled,
            object.name ?? `#${object.id}`,
            () => this.handlers.toggleEntity(object.id),
        );

        row.append(toggle, badge, main);
        return row;
    }
}
