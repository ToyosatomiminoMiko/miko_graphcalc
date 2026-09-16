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
import type { SceneIR } from '../ir';
import { EventBus } from '../service/EventBus';
import { KeyboardController } from '../service/KeyboardController';
import type { GraphCalcEvents } from '../types';
import { SceneStore } from './SceneStore';
import { CompileController } from './CompileController';
import { RenderController } from './RenderController';
import { ParamPanelController } from '../ui/panels/ParamPanelController';
import { DiagnosticsController } from '../ui/panels/DiagnosticsController';
import { EditorLineNumbers } from '../ui/editor/EditorLineNumbers';
import { EditorHighlight } from '../ui/editor/EditorHighlight';
import { FormulaCopyController } from '../ui/formula/FormulaCopyController';
import { ObjectListController } from '../ui/objects/ObjectListController';
import { PanelController } from '../ui/panels/PanelController';
import { RightPanelTabs } from '../ui/panels/RightPanelTabs';
import { RightSplitController } from '../ui/panels/RightSplitController';
import { ProcessPanel, formatProcessParamEcho } from '../ui/process/ProcessPanel';
import type { ProcessRequest } from '../ui/evaluation/EvaluationItem';
import { ExampleLoaderController } from '../ui/examples/ExampleLoaderController';
import { exampleSource, type ExampleEntry } from '../ui/examples/exampleCatalog';
import { replaceTextareaSource } from '../ui/examples/replaceEditorSource';
import { createViewPanel, type ViewPanel } from '../ui/view/ViewPanel';

export class DslApp {
    private readonly eventBus = new EventBus<GraphCalcEvents>();
    private readonly store = new SceneStore();
    private readonly compileController: CompileController;
    private readonly renderController: RenderController;
    private readonly paramPanelController: ParamPanelController;
    private readonly diagnosticsController: DiagnosticsController;
    private readonly objectListController: ObjectListController;
    private readonly formulaCopyController: FormulaCopyController;
    private readonly exampleLoader: ExampleLoaderController;
    /**
     * 右侧"视图"面板:布局与控件实例在这里建一次,句柄交给 RenderController
     * 分发给各控制器(见 `wireViewControls`).它的生命周期不在这里管 --
     * 每个控件恰好一个控制器所有者,由那些控制器各自 dispose.
     */
    private readonly viewPanel: ViewPanel;

    private readonly editor: HTMLTextAreaElement;
    private readonly runButton: HTMLButtonElement;
    private readonly lineNumbers: EditorLineNumbers;
    private readonly editorHighlight: EditorHighlight;
    private panelController: PanelController | null = null;
    private rightSplitController: RightSplitController | null = null;
    /** 右栏标签页:页归属的状态源;页宽与页归属无关(两页共用一份宽度). */
    private rightPanelTabs: RightPanelTabs | null = null;
    /** 过程页视图:条目"过程"入口把文档交给它载入. */
    private processPanel: ProcessPanel | null = null;

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
    /** `start()` 只允许生效一次(见该方法的说明). */
    private started = false;

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
        const solveList = document.getElementById('solve-object-list')!;
        const antiderivativeList = document.getElementById('antiderivative-object-list')!;
        const formulaCopyHint = document.getElementById('formula-copy-hint')!;

        this.editor = document.getElementById('dsl-editor') as HTMLTextAreaElement;
        this.runButton = document.getElementById('run-btn') as HTMLButtonElement;
        // 行号栏的两个兄弟节点在这里取好传进去:EditorLineNumbers 不再自己
        // 往父节点里按 id 查(依赖可见,缺结构时构造期报错,见 UI-P3.10).
        this.lineNumbers = new EditorLineNumbers(this.editor, {
            gutter: document.getElementById('dsl-editor-gutter'),
            numbers: document.getElementById('dsl-editor-lines'),
        });
        // 高亮层同样由装配层取节点传入;它和行号栏一样监听 input/scroll,
        // 但一个只画行号(translate),一个当滚动容器用(见各自类的说明).
        this.editorHighlight = new EditorHighlight(this.editor, {
            scroller: document.getElementById('dsl-editor-highlight'),
            code: document.getElementById('dsl-editor-highlight-code'),
        });

        this.compileController = new CompileController(this.store);
        this.diagnosticsController = new DiagnosticsController(diagnostics);
        this.objectListController = new ObjectListController(
            {
                entity: entityList,
                analysis: analysisList,
                integral: integralList,
                intersection: intersectionList,
                solve: solveList,
                antiderivative: antiderivativeList,
            },
            {
                // 实体显隐不重新编译,直接改 Plotter 可见性;求值对象显隐要
                // 重新编译,数值计算才会被真正跳过.
                toggleEntity: (id) => this.renderController.toggleObject(id),
                toggleAnalysis: (name) => this._toggleAnalysis(name),
                toggleIntegral: (name) => this._toggleIntegral(name),
                toggleIntersection: (name) => this._toggleIntersection(name),
                toggleSolve: (name) => this._toggleSolve(name),
                toggleAntiderivative: (name) => this._toggleAntiderivative(name),
                // 三级披露的 L2 入口:条目已把过程文档建好,这里只负责切页与载入.
                openProcess: (request) => this._openProcess(request),
            },
        );
        this.paramPanelController = new ParamPanelController(
            paramsPanel,
            (name) => this._scheduleRefresh(name),
        );
        this.formulaCopyController = new FormulaCopyController(formulaCopyHint);
        this.viewPanel = createViewPanel(document.getElementById('view-controls')!);
        this.exampleLoader = new ExampleLoaderController(
            {
                button: document.getElementById('example-btn')!,
                menu: document.getElementById('example-menu')!,
            },
            (entry) => this._loadExample(entry),
        );
        this.renderController = new RenderController(
            viewport,
            this.store,
            this.diagnosticsController,
            this.objectListController,
        );
    }

    /**
     * 装配并启动:绑定全局监听,起 rAF 循环,编译一次当前源码.
     *
     * 幂等:重复调用直接返回.这里的每一步都会**覆盖**字段引用(panelController /
     * rightSplitController / keyboardController / animationFrameId),再跑一次会
     * 让第一套对象失去引用却又继续监听 window/document,并多出一个永不取消的
     * 动画帧循环 -- 静默的双份键鼠通道.有 dispose() 就该有配对的一次性启动.
     */
    start(): void {
        if (this.started) return;
        this.started = true;

        this.renderController.setupControls();
        this.renderController.wireViewControls(this.eventBus, this.viewPanel);
        this._wireEditor();

        this.panelController = new PanelController();
        this.panelController.bind(document.getElementById('app')!);
        // 右面板内部"参数区 / 视图区"的分隔高度:与面板宽度/底部高度一样,
        // 属于布局态,由控制器写到 #app 的 CSS 变量上.
        this.rightSplitController = new RightSplitController();
        this.rightSplitController.bind(document.getElementById('app')!);
        // 右栏标签页:切页只改"哪一页在前",不碰宽度 -- 参数页与过程页共用
        // 侧栏那一份宽度(`--right-panel-width` 的唯一写入点仍是 PanelController).
        this.rightPanelTabs = new RightPanelTabs(
            document.getElementById('right-tabs')!,
            {
                params: document.getElementById('right-page-params')!,
                process: document.getElementById('right-page-process')!,
            },
            {
                onTabChange: (tab) => {
                    // 参数可能刚在另一页被改过:切回过程页时刷新只读回显,
                    // 但不重载过程(那会把当前步复位到第 0 步).
                    if (tab === 'process') this.processPanel?.refreshEcho();
                },
            },
        );
        this.rightPanelTabs.bind();

        // 过程页视图只装配一次;参数只读回显(R6)按需拉当前值,不在这里存副本.
        this.processPanel = new ProcessPanel(
            document.getElementById('process-panel')!,
            {
                getParamEcho: () =>
                    formatProcessParamEcho(this.paramPanelController.getValues()),
            },
        );
        this.formulaCopyController.bind(document.getElementById('app')!);
        // 点浮层外部关闭需要鼠标事件,所以根节点上也要绑一份监听
        // (键盘那条路仍然只走 KeyboardController).
        this.exampleLoader.bind(document.getElementById('app')!);

        this.keyboardController = new KeyboardController(this.editor, {
            onHome: () => this.renderController.resetHome(),
            onRun: () => void this.run(),
        });
        // 公式复制的 Enter/Space 也注册进唯一的键盘出口,控制器本身不再绑 keydown.
        this.keyboardController.register(this.formulaCopyController.keyboardBinding());
        // 示例浮层的 Esc / 上下键同样注册进唯一出口.
        for (const binding of this.exampleLoader.keyboardBindings()) {
            this.keyboardController.register(binding);
        }
        // 过程页左右翻步:只在过程页激活时生效,焦点在编辑器/标签栏里时让位
        // (让位规则在 ProcessPanel.keyboardBinding 里,不在这里判断).
        this.keyboardController.register(
            this.processPanel.keyboardBinding(
                () => this.rightPanelTabs?.get() === 'process',
            ),
        );
        this.keyboardController.bind();

        window.addEventListener('resize', this.onResize);
        this.animationFrameId = requestAnimationFrame(this.animate);

        void this.run();
    }

    /** 拆掉全部监听/循环/Worker;幂等,重复调用不重复拆解. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
        }
        this._cancelPendingRefresh();

        this.keyboardController?.dispose();
        this.keyboardController = null;

        window.removeEventListener('resize', this.onResize);

        this.panelController?.dispose();
        this.rightSplitController?.dispose();
        this.rightPanelTabs?.dispose();
        this.rightPanelTabs = null;
        this.processPanel?.dispose();
        this.processPanel = null;
        this.lineNumbers.dispose();
        this.editorHighlight.dispose();
        this.renderController.dispose();
        this.compileController.dispose();
        this.paramPanelController.dispose();
        this.diagnosticsController.dispose();
        this.objectListController.dispose();
        this.formulaCopyController.dispose();
        this.exampleLoader.dispose();
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
        // 源码重跑 = 场景整体替换:已载入的过程可能指向不再存在的条目,先清掉.
        // 拖动参数只走 `_refreshObjects`,不会经过这里,所以过程页不会被误清.
        this.processPanel?.clear();

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

    /**
     * 载入示例:替换编辑器源码并立即运行.
     *
     * 写入走 `replaceTextareaSource`(全选 + execCommand 覆盖),这样用户
     * 手写的代码还留在浏览器原生撤销栈里,一次 Ctrl+Z 就能整段退回.
     *
     * 会话状态不必在这里清理:`run()` -> `CompileController.run` 会把新源码
     * 交给 `SceneStore.commitSource`,而源码内容一变,实体/分析/积分/求交的
     * 隐藏集合就整体清空(见 SceneStore.commitSource 与 SceneStore.test.ts).
     */
    private _loadExample(entry: ExampleEntry): void {
        const source = exampleSource(entry.file);
        if (source === null) {
            this.diagnosticsController.add(
                'error',
                `示例源码缺失:example/${entry.file}`,
            );
            return;
        }

        replaceTextareaSource(this.editor, source);
        // 全选覆盖后光标停在文末,编辑器会跟着滚到底部;载入后应当看到开头.
        this.editor.setSelectionRange(0, 0);
        this.editor.scrollTop = 0;
        // execCommand 成功后浏览器自己会派发 input(行号栏跟着更新),兜底路径
        // 不会;统一再刷一次,两条路径的行为就一致了(EditorLineNumbers.refresh
        // 本就是为"程序化改写编辑器"准备的).
        this.lineNumbers.refresh();
        this.editorHighlight.refresh();

        this.exampleLoader.setActive(entry.file);
        void this.run();
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

    /**
     * 切换方程求解对象的显隐:与求交/积分同一语义--隐藏 = 列表保留占位,
     * 不再调用求解内核,所以必须重新编译(见 compileSolves 的隐藏分支).
     */
    private _toggleSolve(name: string): void {
        const scene = this.compileController.toggleSolve(
            name,
            this.paramPanelController.getValues(),
        );
        if (scene) this.renderController.commitSceneWithoutRedraw(scene);
    }

    /**
     * 切换原函数条目的显隐:隐藏 = 列表保留占位,既不再调用积分内核,也不再
     * 下发对应的曲线/曲面,所以必须重新编译(见 compileAntiderivatives).
     */
    private _toggleAntiderivative(name: string): void {
        const scene = this.compileController.toggleAntiderivative(
            name,
            this.paramPanelController.getValues(),
        );
        if (scene) this.renderController.commitSceneWithoutRedraw(scene);
    }

    /**
     * 打开某条求值对象的过程页(三级披露的 L2).
     *
     * 过程文档由条目在点击时构建(item 知道自己的 IR 字段),这里只做两件事:
     * 切到过程页(右栏宽度不变,两页共用一份宽度),载入步骤.切页不清参数状态,
     * 过程页顶部另有当前参数的只读回显(R6).
     */
    private _openProcess(request: ProcessRequest): void {
        this.rightPanelTabs?.show('process');
        this.processPanel?.show(request.document);
    }
}
