/**
 * 求值列表(footer 右栏):分析/积分/求交/求解四个子列表的集合.
 *
 * 这里只做"右栏"这一层的事:
 * 1. 四个 kind 各挂一个 {@link EvaluationSection}(DOM 行缓存/顺序/展开态/
 *    数值缓存/异步回填的统一实现);
 * 2. 把场景里的四类任务分别渲染进各自的容器,显隐回调接到对应的切换入口;
 * 3. 对外转发渲染层的异步结果回调(积分/求交;分析/求解是编译期同步值,
 *    没有异步回填入口).
 *
 * 行内结构完全不在这里:每类条目长什么样由各自的 item 类决定
 * (`analysisItem.ts` / `integralItem.ts` / `intersectionItem.ts` /
 * `SolveItem.ts`),新增一类求值对象 = 写一个 item 类 + 这里挂一个 Section.
 */
import type {
    AntiderivativeTask,
    AnalysisResult,
    IntegralTask,
    IntersectionOutput,
    IntersectionTask,
    SceneIR,
    SolveTask,
} from '../../ir';
import { AnalysisItem } from './analysisItem';
import { EvaluationSection } from './EvaluationSection';
import { IntegralItem } from './integralItem';
import { IntersectionItem } from './intersectionItem';
import { SolveItem } from './SolveItem';
import { AntiderivativeItem } from './AntiderivativeItem';
import type { ProcessRequest } from './EvaluationItem';

/** 右栏子列表容器;用具名对象而不是同类型的 HTMLElement 位置参数. */
export interface EvaluationListContainers {
    readonly analysis: HTMLElement;
    readonly integral: HTMLElement;
    readonly intersection: HTMLElement;
    readonly solve: HTMLElement;
    readonly antiderivative: HTMLElement;
}

/**
 * 行末显隐按钮的回调:请求方只报"用户点了哪一条",隐藏的语义
 * (不渲染 + 不参与计算)由应用层实现(切隐藏集合后按当前参数重新编译).
 */
export interface EvaluationListHandlers {
    toggleAnalysis(name: string): void;
    toggleIntegral(name: string): void;
    toggleIntersection(name: string): void;
    toggleSolve(name: string): void;
    toggleAntiderivative(name: string): void;
    /** 打开条目过程页(三级披露的 L2):切页与载入由应用层做. */
    openProcess(request: ProcessRequest): void;
}

export class EvaluationList {
    /** 分析子列表:结构定义见 `evaluation/analysisItem.ts`. */
    private readonly analysis: EvaluationSection<
        AnalysisResult,
        void,
        AnalysisItem
    >;

    /** 积分子列表:结构定义见 `evaluation/integralItem.ts`. */
    private readonly integral: EvaluationSection<
        IntegralTask,
        number,
        IntegralItem
    >;

    /** 求交子列表:结构定义见 `evaluation/intersectionItem.ts`. */
    private readonly intersection: EvaluationSection<
        IntersectionTask,
        IntersectionOutput,
        IntersectionItem
    >;

    /** 求解子列表:结构定义见 `evaluation/SolveItem.ts`. */
    private readonly solve: EvaluationSection<SolveTask, void, SolveItem>;

    /** 原函数子列表:结构定义见 `evaluation/AntiderivativeItem.ts`. */
    private readonly antiderivative: EvaluationSection<
        AntiderivativeTask,
        void,
        AntiderivativeItem
    >;

    constructor(
        containers: EvaluationListContainers,
        private readonly handlers: EvaluationListHandlers,
    ) {
        // 三个容器在 DOM 里只是普通 <div>;各 Section 构造时显式给列表语义,
        // 读屏才会报"列表/列表项",而不是把每条读成孤立的一段.
        this.analysis = new EvaluationSection(containers.analysis, AnalysisItem);
        this.integral = new EvaluationSection(containers.integral, IntegralItem);
        this.intersection = new EvaluationSection(
            containers.intersection,
            IntersectionItem,
        );
        this.solve = new EvaluationSection(containers.solve, SolveItem);
        this.antiderivative = new EvaluationSection(
            containers.antiderivative,
            AntiderivativeItem,
        );
    }

    render(scene: SceneIR): void {
        // 三个子列表的显隐回调各自绑定到对应的切换入口:item 只管把按钮接上
        // `context.toggleHidden`,不关心重新编译的流程.
        this.analysis.render(scene.analyses, {
            objects: scene.objects,
            toggleHidden: (name) => this.handlers.toggleAnalysis(name),
            openProcess: (request) => this.handlers.openProcess(request),
        });
        this.integral.render(scene.integrals, {
            objects: scene.objects,
            toggleHidden: (name) => this.handlers.toggleIntegral(name),
            openProcess: (request) => this.handlers.openProcess(request),
        });
        this.intersection.render(scene.intersections, {
            objects: scene.objects,
            toggleHidden: (name) => this.handlers.toggleIntersection(name),
            openProcess: (request) => this.handlers.openProcess(request),
        });
        this.solve.render(scene.solves, {
            objects: scene.objects,
            toggleHidden: (name) => this.handlers.toggleSolve(name),
            openProcess: (request) => this.handlers.openProcess(request),
        });
        this.antiderivative.render(scene.antiderivatives, {
            objects: scene.objects,
            toggleHidden: (name) => this.handlers.toggleAntiderivative(name),
            openProcess: (request) => this.handlers.openProcess(request),
        });
    }

    /**
     * @cache_access
     * 命中积分 item 并回填数值:完整等式由展开细节的等式行唯一承载,
     * 状态行在就绪后被摘掉(见 IntegralItem.renderValue).
     */
    setIntegralResult(name: string, value: number): void {
        this.integral.resolve(name, value);
    }

    /**
     * @cache_access
     * 命中积分 item 并更新错误文本.
     */
    setIntegralError(name: string, message: string): void {
        this.integral.reject(name, message);
    }

    /**
     * @cache_access
     * 命中求交 item 并更新结果摘要.
     */
    setIntersectionResult(name: string, output: IntersectionOutput): void {
        this.intersection.resolve(name, output);
    }

    /**
     * @cache_access
     * 命中求交 item 并更新错误文本.
     */
    setIntersectionError(name: string, message: string): void {
        this.intersection.reject(name, message);
    }

    /**
     * @cache_access
     * 清空五个子列表及其全部 DOM 行缓存与数值缓存.
     */
    clear(): void {
        this.analysis.clear();
        this.integral.clear();
        this.intersection.clear();
        this.solve.clear();
        this.antiderivative.clear();
    }
}
