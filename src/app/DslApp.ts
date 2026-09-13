/**
 * DslApp -- OpenSCAD 式 DSL Shell 的装配层.
 *
 * 职责被刻意收敛为:
 * - 找到并保存 DOM 入口
 * - 组装 SceneStore / CompileController / RenderController
 * - 装配参数面板/对象列表/诊断区等 UI 控制器
 * - 处理"运行源码"和"拖参数刷新"两条入口
 * - 驱动 requestAnimationFrame 主循环
 *
 * 编译细节在 CompileController,场景与计算细节在 RenderController.
 * 源码仍然是唯一真相源:
 *   编辑 -> parseMiko -> compileScene -> 3D 视口 + param 面板 + 对象列表.
 */
import type { SceneIR } from '../compiler/ir/types';
import { EventBus } from '../service/EventBus';
import { KeyboardController } from '../service/KeyboardController';
import type { GraphCalcEvents } from '../types';
import { SceneStore } from './SceneStore';
import { CompileController } from './CompileController';
import { RenderController } from './RenderController';
import { ParamPanelController } from '../ui/ParamPanelController';
import { DiagnosticsController } from '../ui/DiagnosticsController';
import { EditorLineNumbers } from '../ui/EditorLineNumbers';
import { FormulaCopyController } from '../ui/FormulaCopyController';
import { ObjectListController } from '../ui/ObjectListController';
import { PanelController } from '../ui/PanelController';

export class DslApp {
    private readonly eventBus = new EventBus<GraphCalcEvents>();
    private readonly store = new SceneStore();
    private readonly compileController: CompileController;
    private readonly renderController: RenderController;
    private readonly paramPanelController: ParamPanelController;
    private readonly diagnosticsController: DiagnosticsController;
    private readonly objectListController: ObjectListController;
    private readonly formulaCopyController: FormulaCopyController;

    private readonly editor: HTMLTextAreaElement;
    private readonly runButton: HTMLButtonElement;
    private readonly lineNumbers: EditorLineNumbers;
    private panelController: PanelController | null = null;

    private animationFrameId: number | null = null;
    private refreshFrame: number | null = null;

    /**
     * @cache
     * 缓存目的:在同一个 rAF 帧内合并多个参数变化,避免连续 input 触发多次编译.
     * 键/失效策略:参数名集合;rAF 回调开始时取出并清空.
     * 生命周期:跟随 DslApp 实例.
     */
    private readonly pendingParamChanges = new Set<string>();
    private disposed = false;

    private readonly onResize = (): void => {
        this.renderController.resize();
    };

    private keyboardController: KeyboardController | null = null;

    constructor() {
        const viewport = document.getElementById('viewport')!;
        const paramsPanel = document.getElementById('params-panel')!;
        const diagnostics = document.getElementById('diagnostics')!;
        const entityList = document.getElementById('entity-object-list')!;
        const analysisList = document.getElementById('analysis-object-list')!;
        const integralList = document.getElementById('integral-object-list')!;
        const intersectionList = document.getElementById('intersection-object-list')!;
        const formulaCopyHint = document.getElementById('formula-copy-hint')!;

        this.editor = document.getElementById('dsl-editor') as HTMLTextAreaElement;
        this.runButton = document.getElementById('run-btn') as HTMLButtonElement;
        // 行号栏的两个兄弟节点在这里取好传进去:EditorLineNumbers 不再自己
        // 往父节点里按 id 查(依赖可见,缺结构时构造期报错,见 UI-P3.10).
        this.lineNumbers = new EditorLineNumbers(this.editor, {
            gutter: document.getElementById('dsl-editor-gutter'),
            numbers: document.getElementById('dsl-editor-lines'),
        });

        this.compileController = new CompileController(this.store);
        this.diagnosticsController = new DiagnosticsController(diagnostics);
        this.objectListController = new ObjectListController(
            {
                entity: entityList,
                analysis: analysisList,
                integral: integralList,
                intersection: intersectionList,
            },
            {
                // 实体显隐不重新编译,直接改 Plotter 可见性;求值对象显隐要
                // 重新编译,数值计算才会被真正跳过.
                toggleEntity: (id) => this.renderController.toggleObject(id),
                toggleAnalysis: (name) => this._toggleAnalysis(name),
                toggleIntegral: (name) => this._toggleIntegral(name),
                toggleIntersection: (name) => this._toggleIntersection(name),
            },
        );
        this.paramPanelController = new ParamPanelController(
            paramsPanel,
            (name) => this._scheduleRefresh(name),
        );
        this.formulaCopyController = new FormulaCopyController(formulaCopyHint);
        this.renderController = new RenderController(
            viewport,
            this.store,
            this.diagnosticsController,
            this.objectListController,
        );
    }

    start(): void {
        this.renderController.setupControls();
        this.renderController.wireViewControls(this.eventBus);
        this._wireEditor();

        this.panelController = new PanelController();
        this.panelController.bind(document.getElementById('app')!);
        this.formulaCopyController.bind(document.getElementById('app')!);

        this.keyboardController = new KeyboardController(this.editor, {
            onHome: () => this.renderController.resetHome(),
            onRun: () => void this.run(),
        });
        this.keyboardController.bind();

        window.addEventListener('resize', this.onResize);
        this.animationFrameId = requestAnimationFrame(this.animate);

        void this.run();
    }

    dispose(): void {
        this.disposed = true;
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
        }
        this._cancelPendingRefresh();

        this.keyboardController?.dispose();
        this.keyboardController = null;

        window.removeEventListener('resize', this.onResize);

        this.panelController?.dispose();
        this.lineNumbers.dispose();
        this.renderController.dispose();
        this.compileController.dispose();
        this.paramPanelController.dispose();
        this.diagnosticsController.dispose();
        this.objectListController.dispose();
        this.formulaCopyController.dispose();
    }

    async run(): Promise<void> {
        /*
         * 全局主入口
         * 入口流程(一次运行只编译一次场景):
         *
         *   editor.value
         *       │
         *       ▼
         *   CompileController.run()      // parseMiko + compileScene
         *       │
         *       ▼
         *   SceneIR
         *       ├─► ParamPanelController.render
         *       └─► RenderController.applyScene
         *
         * 之后拖动滑块只走 _refreshObjects,不会在 run() 里重复解析同一个 AST.
         */
        this.diagnosticsController.clear();
        this._cancelPendingRefresh();

        try {
            const scene = await this.compileController.run(this.editor.value);
            if (this.disposed || !scene) return;

            this.store.setAnimationStartTime(performance.now());
            this.paramPanelController.render(scene.params);
            this.renderController.applyScene(scene);
        } catch (error) {
            if (this.disposed) return;
            this.diagnosticsController.add(
                'error',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private _wireEditor(): void {
        this.runButton.addEventListener('click', () => void this.run());
    }

    private animate = (timestamp: number): void => {
        if (this.disposed) return;
        this.animationFrameId = requestAnimationFrame(this.animate);
        this.renderController.frame(timestamp);
    };

    /**
     * @cache_access
     * 把参数变化写入待刷新缓存,并在下一帧合并处理.
     */
    private _scheduleRefresh(name: string): void {
        if (this.disposed) return;
        this.pendingParamChanges.add(name);
        if (this.refreshFrame !== null) return;

        this.refreshFrame = requestAnimationFrame(() => {
            this.refreshFrame = null;
            const changedParams = new Set(this.pendingParamChanges);
            this.pendingParamChanges.clear();
            this._refreshObjects(changedParams);
        });
    }

    /**
     * @cache_access
     * 取消并清空待刷新参数缓存.
     */
    private _cancelPendingRefresh(): void {
        if (this.refreshFrame !== null) {
            cancelAnimationFrame(this.refreshFrame);
            this.refreshFrame = null;
        }
        this.pendingParamChanges.clear();
    }

    private _refreshObjects(
        changedParams: ReadonlySet<string>,
    ): SceneIR | null {
        const scene = this.compileController.refresh(
            this.paramPanelController.getValues(),
        );
        if (!scene) return null;

        this.renderController.applyScene(scene, changedParams);
        return scene;
    }

    /**
     * 切换求值对象的显隐:先写入 SceneStore 的隐藏集合,再按当前参数重新
     * 编译--隐藏 = 列表保留占位但不再调度数值计算(语义见 DslCompiler 文件头),
     * 所以场景必须重算一遍,不能只改 DOM.
     *
     * `commitSceneWithoutRedraw` 只同步 overlay 与对象列表,不重新采样几何.
     */
    private _toggleAnalysis(name: string): void {
        const scene = this.compileController.toggleAnalysis(
            name,
            this.paramPanelController.getValues(),
        );
        if (scene) this.renderController.commitSceneWithoutRedraw(scene);
    }

    private _toggleIntegral(name: string): void {
        const scene = this.compileController.toggleIntegral(
            name,
            this.paramPanelController.getValues(),
        );
        if (scene) this.renderController.commitSceneWithoutRedraw(scene);
    }

    private _toggleIntersection(name: string): void {
        const scene = this.compileController.toggleIntersection(
            name,
            this.paramPanelController.getValues(),
        );
        if (scene) this.renderController.commitSceneWithoutRedraw(scene);
    }
}
