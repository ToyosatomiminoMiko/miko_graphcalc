/**
 * DslApp -- OpenSCAD 式 DSL Shell 的装配层.
 *
 * 职责被刻意收敛为:
 * - 接收 `readAppHosts()` 取好的 DOM 入口(本文件不按 id 查节点)
 * - 组装 SceneStore / CompileController / RenderController
 * - 装配参数面板/对象列表/诊断区等 UI 控制器
 * - 处理"运行源码"和"拖参数刷新"两条入口
 * - 驱动 requestAnimationFrame 主循环
 *
 * 编译细节在 CompileController,场景与计算细节在 RenderController.
 * 源码仍然是唯一真相源:
 *   编辑 -> parseMiko -> compileScene -> 3D 视口 + param 面板 + 对象列表.
 */
import type { SceneIR } from '@/contract/ir';
import { EventBus } from '@/core/EventBus';
import { KeyboardController } from '@/ui/shared/KeyboardController';
import type { GraphCalcEvents } from '@/contract/events';
import type { AppHosts } from './appHosts';
import { SceneStore } from './SceneStore';
import { CompileController } from './CompileController';
import { RenderController } from './RenderController';
import { ParamPanelController } from '@/ui/params/ParamPanelController';
import { DiagnosticsController } from '@/ui/diagnostics/DiagnosticsController';
import { EditorLineNumbers } from '@/ui/editor/EditorLineNumbers';
import { EditorHighlight } from '@/ui/editor/EditorHighlight';
import { FormulaCopyController } from '@/ui/formula/FormulaCopyController';
import { ObjectListController } from '@/ui/objects/ObjectListController';
import { WindowManager } from '@/ui/desktop/WindowManager';
import { createWindowChrome, windowSlotsProvider } from '@/ui/desktop/windowChrome';
import { ProcessPanel, formatProcessParamEcho } from '@/ui/process/ProcessPanel';
import type { ProcessRequest } from '@/ui/evaluation/EvaluationItem';
import { ExampleLoaderController } from '@/ui/examples/ExampleLoaderController';
import { exampleSource, type ExampleEntry } from '@/ui/examples/exampleCatalog';
import { replaceTextareaSource } from '@/ui/examples/replaceEditorSource';
import { createViewPanel, type ViewPanel } from '@/ui/view/ViewPanel';

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
    /** 运行按钮:由 `createWindowChrome()` 建,监听在本类(它拥有"运行"这条动作). */
    private readonly runButton: HTMLElement;
    private readonly lineNumbers: EditorLineNumbers;
    private readonly editorHighlight: EditorHighlight;
    /**
     * 桌面窗口管理器:窗口外壳(标题栏/正文/八根手柄),状态机,z-order 与
     * Dock 的唯一所有者.它替换了原来的 PanelController / RightPanelTabs /
     * RightSplitController 三个"布局/页归属/分栏比例"控制器.
     */
    private readonly windowManager: WindowManager;
    /** 过程窗口正文宿主(`start()` 才装配过程视图). */
    private readonly processHost: HTMLElement;
    /** `#app`:浮层"点外部关闭"与公式复制的键盘代理都挂在这个根上. */
    private readonly appRoot: HTMLElement;
    /** 几何变化的退订函数(`dispose()` 里调用,与 `_wireEditorResize` 配对). */
    private unsubscribeGeometry: (() => void) | null = null;
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

    /**
     * @param hosts `readAppHosts()` 取好的 `index.html` 宿主;本类不按 id 查节点.
     *              标题栏上的四个应用节点由 `createWindowChrome()` 就地建,
     *              位置声明在 `UI_CONFIG.window.adopted`(见 windowChrome.ts).
     */
    constructor(hosts: AppHosts) {
        this.editor = hosts.editor;
        // 标题栏的四个节点在这里建一次:监听归各自的控制器,位置归 adopted 表.
        const chrome = createWindowChrome();
        this.runButton = chrome.runButton;
        this.processHost = hosts.processPanel;
        this.appRoot = hosts.app;
        // 行号栏的两个兄弟节点在这里取好传进去:EditorLineNumbers 不再自己
        // 往父节点里按 id 查(依赖可见,缺结构时构造期报错,见 UI-P3.10).
        this.lineNumbers = new EditorLineNumbers(this.editor, {
            gutter: hosts.editorGutter,
            numbers: hosts.editorLines,
        });
        // 高亮层同样由装配层取节点传入;它和行号栏一样监听 input/scroll,
        // 但一个只画行号(translate),一个当滚动容器用(见各自类的说明).
        this.editorHighlight = new EditorHighlight(this.editor, {
            scroller: hosts.editorHighlight,
            code: hosts.editorHighlightCode,
        });

        this.compileController = new CompileController(this.store);
        this.diagnosticsController = new DiagnosticsController(hosts.diagnostics);
        this.objectListController = new ObjectListController(
            hosts.objectLists,
            {
                // 实体显隐不重新编译,直接改 Plotter 可见性;求值对象显隐要
                // 重新编译,数值计算才会被真正跳过.
                toggleEntity: (id) => this.renderController.toggleObject(id),
                toggleAnalysis: (name) => this._toggleAnalysis(name),
                toggleIntegral: (name) => this._toggleIntegral(name),
                toggleIntersection: (name) => this._toggleIntersection(name),
                toggleSolve: (name) => this._toggleSolve(name),
                toggleAntiderivative: (name) => this._toggleAntiderivative(name),
                toggleOde: (name) => this._toggleOde(name),
                // 三级披露的 L2 入口:条目已把过程文档建好,这里只负责切页与载入.
                openProcess: (request) => this._openProcess(request),
            },
        );
        this.paramPanelController = new ParamPanelController(
            hosts.paramsPanel,
            (name) => this._scheduleRefresh(name),
        );
        this.formulaCopyController = new FormulaCopyController(chrome.formulaCopyHint);
        this.viewPanel = createViewPanel(hosts.viewControls);
        this.exampleLoader = new ExampleLoaderController(
            { button: chrome.exampleButton, menu: chrome.exampleMenu },
            (entry) => this._loadExample(entry),
        );
        this.renderController = new RenderController(
            hosts.viewport,
            this.store,
            this.diagnosticsController,
            this.objectListController,
        );
        // 容器与正文宿主都由装配层取好传入(与 EditorHighlight 同一约定),
        // 本类与 WindowManager 都不再碰 document.
        this.windowManager = new WindowManager(
            hosts.windowLayer,
            hosts.dock,
            hosts.snapPreview,
            hosts.windowBodies,
            windowSlotsProvider(chrome),
        );
    }

    /**
     * 装配并启动:绑定全局监听,起 rAF 循环,编译一次当前源码.
     *
     * 幂等:重复调用直接返回.这里的每一步都会**覆盖**字段引用
     * (`windowManager` / `keyboardController` / `animationFrameId`),
     * 再跑一次会让第一套对象失去引用却又继续监听 window/document,
     * 并多出一个永不取消的动画帧循环 -- 静默的双份键鼠通道.
     * 有 dispose() 就该有配对的一次性启动.
     */
    start(): void {
        if (this.started) return;
        this.started = true;

        this.renderController.setupControls();
        this.renderController.wireViewControls(this.eventBus, this.viewPanel);
        this._wireEditor();

        // 窗口装配:建五个窗口外壳,把五个正文宿主搬进各自的 .window-body,
        // 把标题栏节点放进 adopted 表声明的槽位,建 Dock,起初始焦点.宿主在
        // 构造期就已取好,搬运不改节点身份,其余控制器拿到的还是同一个.
        this.windowManager.bind();
        this._wireEditorResize();

        // 过程页视图只装配一次;参数只读回显(R6)按需拉当前值,不在这里存副本.
        this.processPanel = new ProcessPanel(
            this.processHost,
            {
                getParamEcho: () =>
                    formatProcessParamEcho(this.paramPanelController.getValues()),
            },
        );
        this.formulaCopyController.bind(this.appRoot);
        // 点浮层外部关闭需要鼠标事件,所以根节点上也要绑一份监听
        // (键盘那条路仍然只走 KeyboardController).
        this.exampleLoader.bind(this.appRoot);

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
        // 单窗口全屏的键盘出口:注册在示例浮层的 Esc **之后**,菜单开着时先关
        // 菜单;没有全屏窗口时本条返回 null,把 Esc 原样放行(见 §3.3;完整键盘
        // 窗口管理是阶段 5,不在这里做).
        this.keyboardController.register({
            keys: ['Escape'],
            resolve: () => (this.windowManager.hasFullscreen()
                ? () => this.windowManager.exitFullscreen()
                : null),
        });
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

        // 窗口:摘监听,把宿主还回 #app,删掉窗口外壳(与 bind() 配对).
        this.unsubscribeGeometry?.();
        this.unsubscribeGeometry = null;
        this.windowManager.dispose();
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
            // 参数变了就刷过程窗口顶部的只读回显:过程窗口与参数窗口同屏,
            // 原来"切回过程页才刷新"的触发点已经不存在(见 §3.7 第三条).
            this.processPanel?.refreshEcho();
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
     * 切换微分方程条目的显隐:隐藏 = 列表保留占位,同时滤掉它下发的斜率场与
     * 解曲线,所以必须重新编译(与不定积分同一条路径,见 buildOdeBlueprints).
     */
    private _toggleOde(name: string): void {
        const scene = this.compileController.toggleOde(
            name,
            this.paramPanelController.getValues(),
        );
        if (scene) this.renderController.commitSceneWithoutRedraw(scene);
    }

    /**
     * 打开某条求值对象的过程(三级披露的 L2).
     *
     * 过程已经是独立窗口,所以"打开"的口径从**切页**变成**抬窗口**:
     * ①被最小化/关闭就先恢复可见;②抬升并聚焦(唯一入口 `reveal`);③载入文档.
     * 不最大化,不改几何,不碰参数窗口(见 docs/windowing-plan.md §3.7).
     */
    private _openProcess(request: ProcessRequest): void {
        this.windowManager.reveal('process');
        this.processPanel?.show(request.document);
    }

    /**
     * 窗口尺寸变化后重排编辑器(行号槽宽与高亮层的滚动基准).
     *
     * 行号与高亮层各自都有 `ResizeObserver`,那是**主路径**;这条钩子是兜底:
     * 最小化/关闭再恢复时,元素在隐藏期间量到的未必是最终尺寸(隐藏态刻意不用
     * `display: none`,就是为了让测量始终有效).只改 x/y 的拖动不重复刷新.
     *
     * 退订函数存起来,与 `dispose()` 配对(不能只依赖 `WindowManager.dispose()`
     * 顺手清监听:那样两边的生命周期就只有一处能改).
     */
    private _wireEditorResize(): void {
        const lastKey = new Map<string, string>();
        this.unsubscribeGeometry = this.windowManager.onGeometryChange((id) => {
            const geometry = this.windowManager.getGeometry(id);
            const key = `${geometry.w}x${geometry.h}:${this.windowManager.getState(id)}`;
            if (lastKey.get(id) === key) return;
            lastKey.set(id, key);
            this.lineNumbers.refresh();
            this.editorHighlight.refresh();
        });
    }
}
