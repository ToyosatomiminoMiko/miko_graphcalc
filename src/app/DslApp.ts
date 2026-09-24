/**
 * DslApp -- OpenSCAD 式 DSL Shell 的装配层.
 *
 * 职责被刻意收敛为:
 * - 接收 `buildAppViews()` 建好的内容节点(本文件不按 id 查节点)
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
import {
    EditorHighlight,
    EditorLineNumbers,
    FormulaCopyController,
    KeyboardController,
    MessageList,
    WindowManager,
    mountDesktop,
    type DesktopHandle,
} from '@miko/ui';
import { UI_CONFIG, desktopConfig } from '@/config/uiConfig';
import { highlightDsl } from '@/editor/dslHighlight';
import type { AppViews } from './appViews';
import { SceneStore } from './SceneStore';
import { CompileController } from './CompileController';
import { RenderController } from './RenderController';
import { ParamPanelController } from '@/views/params/ParamPanelController';
import { ObjectListController, type ObjectListHandlers } from '@/views/objects/ObjectListController';
import { ProcessPanel, formatProcessParamEcho } from '@/views/process/ProcessPanel';
import type { ProcessRequest } from '@/views/evaluation/EvaluationItem';
import { ExampleLoaderController } from '@/views/examples/ExampleLoaderController';
import { defaultExample, exampleSource, type ExampleEntry } from '@/views/examples/exampleCatalog';
import { replaceTextareaSource, seedTextareaSource } from '@/views/examples/replaceEditorSource';
import { createViewPanel, type ViewPanelHandle } from '@/views/view/ViewPanel';
import { createViewState, type ViewState } from '@/views/view/viewState';

export class DslApp {
    private readonly store = new SceneStore();
    private readonly compileController: CompileController;
    private readonly renderController: RenderController;
    private readonly paramPanelController: ParamPanelController;
    private readonly diagnosticsController: MessageList;
    private readonly objectListController: ObjectListController;
    private readonly formulaCopyController: FormulaCopyController;
    private readonly exampleLoader: ExampleLoaderController;
    /**
     * 视图状态源(P3):"视图"面板与渲染侧共用这一份 signal,中间不再有
     * 控制器与 EventBus 那一层.
     */
    private readonly viewState: ViewState;
    /** 右侧"视图"面板:控件与订阅都归它自己,dispose 时统一解绑. */
    private readonly viewPanel: ViewPanelHandle;

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
    /** `mountDesktop()` 的句柄:三层容器与窗口管理器的生命周期归它. */
    private readonly desktop: DesktopHandle;
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

    private keyboardController: KeyboardController | null = null;

    /**
     * @param views `buildAppViews()` 建好的应用内容节点与逐窗口内容表;
     *              桌面容器(`window-layer` / `dock` / `snap-preview` / 各窗口
     *              正文)由 `mountDesktop()` 自己建,本类不按 id 查任何节点.
     */
    constructor(views: AppViews) {
        this.editor = views.editor;
        this.runButton = views.chrome.runButton;
        this.processHost = views.processPanel;
        this.appRoot = views.root;
        const decorations = this._createEditorDecorations(views);
        this.lineNumbers = decorations.lineNumbers;
        this.editorHighlight = decorations.highlight;

        this.compileController = new CompileController(this.store);
        this.diagnosticsController = new MessageList(views.diagnostics);
        // 显隐/过程入口这一组回调单独建:它们各自绑一个业务动作,堆在构造
        // 函数里只会把"装配顺序"淹掉(见 `_objectListHandlers`).
        this.objectListController = new ObjectListController(
            views.objectLists,
            this._objectListHandlers(),
        );
        this.paramPanelController = new ParamPanelController(
            views.paramsPanel,
            (name) => this._scheduleRefresh(name),
        );
        this.formulaCopyController = new FormulaCopyController(views.chrome.formulaCopyHint);
        this.viewState = createViewState();
        this.viewPanel = createViewPanel(views.viewControls, this.viewState);
        this.exampleLoader = new ExampleLoaderController(
            { button: views.chrome.exampleButton, menu: views.chrome.exampleMenu },
            (entry) => this._loadExample(entry),
        );
        this.renderController = new RenderController(
            views.viewport,
            this.store,
            this.diagnosticsController,
            this.objectListController,
        );

        // 桌面容器由库自己建(D1):本类只声明"每个窗口装什么内容",不提供任何
        // 带 id 的宿主.窗口清单/动作/夹取常量来自应用配置,经 desktopConfig()
        // 收成库的 DesktopConfig.
        this.desktop = mountDesktop(views.root, {
            ...desktopConfig(),
            background: [views.viewport],
            content: views.windowContent,
        });
        this.windowManager = this.desktop.windows;

        // 视口在 `mountDesktop()` 之前是游离节点:此时量 clientWidth/Height 得到
        // 0,而 SceneManager/CameraManager 已经在上面构造完了 -- 画布被建成 0×0,
        // 相机 aspect 是 NaN,首帧什么都画不出来,而且铺满层不会自己再变尺寸,
        // 于是只有窗口 resize(例如开 devtools)才会恢复.挂载后立刻补量一次,
        // 让第一帧就是对的;之后的尺寸变化由 RenderController 的 ResizeObserver
        // 接管,这里不再另挂 window 的 resize 监听(同一次变化不重复算两遍).
        this.renderController.resize();
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
        // 视图状态 -> 渲染器:读值再转发只剩 effect 这一层(见 bindViewState).
        this.renderController.bindViewState(this.viewState);
        this._wireEditor();

        // 窗口装配已经在 `mountDesktop()` 里做过(构造期):建六个窗口外壳,把
        // 各窗口内容搬进 `.window-body`,把标题栏节点放进 adopted 表声明的槽位,
        // 建 Dock,起初始焦点.这里只补装配层自己的那条几何回调.
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
        // 点浮层外部关闭需要鼠标事件,所以根节点上也要绑一份监听.
        this.exampleLoader.bind(this.appRoot);

        this.keyboardController = new KeyboardController(this.editor, {
            onHome: () => this.renderController.resetHome(),
            onRun: () => void this.run(),
        });
        // 公式复制的 Enter/Space 也注册进唯一的键盘出口,控制器本身不再绑 keydown.
        this.keyboardController.register(this.formulaCopyController.keyboardBinding());
        // 示例浮层一条键盘规则都不注册:库与控制器都不负责菜单键盘
        // (见 ExampleLoaderController 的文件头),浮层靠点按钮开合.
        this.keyboardController.bind();

        this.animationFrameId = requestAnimationFrame(this.animate);

        // 首屏默认源码:index.html 的编辑器现在是空的,这里先种入默认示例,
        // 下面那一次 run() 编译的就是它;编辑器里已有内容(比如有人往 HTML 的
        // textarea 里预置了源码)时不覆盖.
        this._seedDefaultExample();
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

        // 桌面:摘监听,把正文节点还回 #app,删掉窗口外壳与三层容器(与 mountDesktop 配对).
        this.unsubscribeGeometry?.();
        this.unsubscribeGeometry = null;
        this.desktop.dispose();
        this.processPanel?.dispose();
        this.processPanel = null;
        this.lineNumbers.dispose();
        this.editorHighlight.dispose();
        // 视图面板自己拥有控件与订阅(P3),所以这里显式拆一次.
        this.viewPanel.dispose();
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

    /**
     * 编辑器两侧的装饰件:行号栏与高亮层.
     *
     * 两者都由装配层取好兄弟节点传进去(依赖可见,缺结构时构造期报错,
     * 见 UI-P3.10),并且都按 D6 注入本应用的配置:
     * - 行号栏要槽宽下限(`UI_CONFIG.editor.gutterMinWidth`);
     * - 高亮层要分词与配色(`highlightDsl`:库不认识 DSL 语法,也不认识配色类名).
     */
    private _createEditorDecorations(views: AppViews): {
        lineNumbers: EditorLineNumbers;
        highlight: EditorHighlight;
    } {
        return {
            lineNumbers: new EditorLineNumbers(this.editor, {
                gutter: views.editorGutter,
                numbers: views.editorLines,
            }, {
                gutterMinWidth: UI_CONFIG.editor.gutterMinWidth,
            }),
            // 高亮层与行号栏一样监听 input/scroll,但一个只画行号(translate),
            // 一个当滚动容器用(见各自类的说明).
            highlight: new EditorHighlight(this.editor, {
                scroller: views.editorHighlight,
                code: views.editorHighlightCode,
            }, {
                highlight: highlightDsl,
            }),
        };
    }

    /**
     * 对象列表的业务回调:每个显隐动作后面都是一条领域流程(见各 `_toggle*`),
     * 所以只在这里汇总一次,构造函数的职责保持"装配顺序"一件事.
     */
    private _objectListHandlers(): ObjectListHandlers {
        return {
            // 实体显隐不重新编译,直接改 Plotter 可见性;求值对象显隐要重新
            // 编译,数值计算才会被真正跳过.
            toggleEntity: (id) => this.renderController.toggleObject(id),
            toggleAnalysis: (name) => this._toggleAnalysis(name),
            toggleIntegral: (name) => this._toggleIntegral(name),
            toggleIntersection: (name) => this._toggleIntersection(name),
            toggleSolve: (name) => this._toggleSolve(name),
            toggleAntiderivative: (name) => this._toggleAntiderivative(name),
            toggleOde: (name) => this._toggleOde(name),
            // 三级披露的 L2 入口:条目已把过程文档建好,这里只负责切窗口与载入.
            openProcess: (request) => this._openProcess(request),
        };
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
        this._syncExampleChrome(entry);
        void this.run();
    }

    /**
     * 首屏默认示例:编辑器为空时写入 {@link defaultExample}(即 `example/test.miko`).
     *
     * 只种源码,不在这里编译--`start()` 末尾那一次 `run()` 会编译它,启动时
     * 不会编译两遍.源码缺失时保持空编辑器:`exampleCatalog.test.ts` 与
     * `exampleScenes.test.ts` 已经保证它在清单里且能内联/编译,这里是防御.
     */
    private _seedDefaultExample(): void {
        if (this.editor.value.trim() !== '') return;
        const entry = defaultExample();
        const source = entry === null ? null : exampleSource(entry.file);
        if (entry === null || source === null) return;

        seedTextareaSource(this.editor, source);
        this._syncExampleChrome(entry);
    }

    /**
     * 源码写进编辑器之后的公共收尾:光标归位,刷新两套编辑器装饰,把菜单里
     * 当前示例标亮.
     *
     * 载入与首屏种子共用:`execCommand` 成功后浏览器自己会派发 `input`(行号栏
     * 跟着更新),回退路径与首屏的直接赋值都不会--统一在这里补一次,两条路径的
     * 行为就一致了(EditorLineNumbers.refresh 本就是为"程序化改写编辑器"准备的).
     */
    private _syncExampleChrome(entry: ExampleEntry): void {
        // 全选覆盖后光标停在文末,编辑器会跟着滚到底部;载入后应当看到开头.
        this.editor.setSelectionRange(0, 0);
        this.editor.scrollTop = 0;
        this.lineNumbers.refresh();
        this.editorHighlight.refresh();
        this.exampleLoader.setActive(entry.file);
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
