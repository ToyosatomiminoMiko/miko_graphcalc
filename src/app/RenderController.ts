/**
 * RenderController -- 3D 视口/相机/绘图与异步计算的渲染编排器.
 *
 * DslApp 只负责把编译结果交给这里,不再直接管理 Three.js 场景/renderer/
 * camera/Plotter/动画和积分可视化.RenderController 对外暴露:
 * - `applyScene`:完整运行或参数刷新后更新对象;
 * - `commitSceneWithoutRedraw`:仅显隐变化时同步 SceneIR 和 overlay;
 * - `frame`:每帧更新 OrbitControls/动画并渲染;
 * - `toggleObject`:切换单个实体的可见性.
 */
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SceneManager } from '@/render/core/SceneManager';
import { CameraManager } from '@/render/core/CameraManager';
import { Plotter } from '@/render/core/Plotter';
import { AnimationPlayer } from '@/render/core/AnimationPlayer';
import { AnalysisRenderer } from '@/render/core/renderers/AnalysisRenderer';
import { IntersectionRenderer } from '@/render/core/renderers/IntersectionRenderer';
import { DslIntegralRenderer } from '@/render/visualization/DslIntegralRenderer';
import { ComputeFacade } from '@/compute';
import type { SceneIR, SceneObject } from '@/contract/ir';
import { effect } from 'miko_ui';
import { onSamplingFailure } from '@/render/core/samplingErrors';
import { SceneStore } from './SceneStore';
import { MessageList } from 'miko_ui';
import type { MessageEntry } from 'miko_ui';
import { ObjectListController } from '@/ui/objects/ObjectListController';
import type { ViewState } from '@/ui/view/viewState';

export class RenderController {
    private readonly sceneManager: SceneManager;
    private readonly cameraManager: CameraManager;
    private readonly plotter: Plotter;
    private readonly animationPlayer: AnimationPlayer;
    private readonly analysisRenderer: AnalysisRenderer;
    private readonly intersectionRenderer: IntersectionRenderer;
    private readonly integralRenderer: DslIntegralRenderer;
    private readonly computeEngine: ComputeFacade;
    /** 采样失败上报的退订函数,dispose 时必须调用. */
    private readonly stopSamplingFailureListener: () => void;

    private controls: OrbitControls | null = null;
    /**
     * 视口容器的尺寸观察器:渲染尺寸的唯一触发源.
     *
     * 为什么盯容器而不是听 `window.resize`:`#viewport` 是 `inset: 0` 的铺满层,
     * 窗口缩放只是它的上游信号,最终都落在它的 clientWidth/Height 上.盯容器
     * 既不会漏(窗口系统自己的布局变化不看窗口),也不会和 window.resize 一起
     * 把同一次变化算两遍.
     *
     * 构造期容器还是游离节点(`buildAppViews` 先建节点,`mountDesktop` 才挂),
     * clientWidth/Height 量到 0;第一次真正的回调要等挂载之后,所以 `DslApp`
     * 在 `mountDesktop()` 之后还会同步补一次 `resize()`(见那里的说明).
     */
    private readonly viewportObserver: ResizeObserver;
    /**
     * @cache
     * 缓存目的:`bindViewState` 建立的"状态 -> 渲染器"effect 的退订函数.
     * 键/失效策略:重新 bind 时先全部退订;dispose 时清空.
     * 生命周期:跟随 RenderController 实例(P3 之前这里放的是 9 个控制器与
     * 它们的 EventBus 退订函数).
     */
    private readonly _viewStops: Array<() => void> = [];

    /**
     * @cache
     * 缓存目的:保存上一份 SceneIR 的对象快照,用于识别消失对象并移除 renderer.
     * 键/失效策略:applyScene/commitSceneWithoutRedraw 后整体替换.
     * 生命周期:跟随 RenderController 实例.
     */
    private previousObjects: SceneObject[] = [];

    /**
     * @cache
     * 缓存目的:保存最近一次应用的完整 SceneIR,供"只改显隐,不重新编译"
     * 的交互(实体显隐切换)重建对象列表.
     * 键/失效策略:applyScene/commitSceneWithoutRedraw 后整体替换.
     * 生命周期:跟随 RenderController 实例.
     */
    private currentScene: SceneIR | null = null;

    constructor(
        viewport: HTMLElement,
        private readonly store: SceneStore,
        private readonly diagnosticsController: MessageList,
        private readonly objectListController: ObjectListController,
    ) {
        this.sceneManager = new SceneManager(viewport);
        this.cameraManager = new CameraManager(viewport);
        this.viewportObserver = new ResizeObserver(() => this.resize());
        this.viewportObserver.observe(viewport);
        this.plotter = new Plotter(this.sceneManager.getScene());
        this.computeEngine = new ComputeFacade();
        this.integralRenderer = new DslIntegralRenderer(
            this.sceneManager.getScene(),
            this.computeEngine,
        );
        this.analysisRenderer = new AnalysisRenderer();
        this.intersectionRenderer = new IntersectionRenderer();
        this.animationPlayer = new AnimationPlayer(this.store.matrixOps);
        this.stopSamplingFailureListener = onSamplingFailure((failure) => {
            const kindLabels = {
                curve: '曲线',
                surface: '曲面',
                vector_field: '向量场',
            } as const;
            this.diagnosticsController.add(
                'error',
                `${kindLabels[failure.kind]} ${failure.name} 采样失败: ${failure.message}`,
            );
        });
        this.sceneManager.getScene().add(this.analysisRenderer.group);
        this.sceneManager.getScene().add(this.intersectionRenderer.group);
    }

    setupControls(): void {
        this._createControls();
    }

    /**
     * 把"视图"面板的状态源接到渲染侧(P3).
     *
     * 每个 effect 读哪些信号,就在哪些信号变化时重跑;第一次运行**同步**执行,
     * 正好替代原来各控制器构造时的"启动同步一次".于是 EventBus 与 9 个控制器
     * 里那份"自己的状态"一起消失:状态只有 viewState 一份,转发由这里做.
     *
     * 重复调用会先释放上一轮 effect:再 bind 一次不该让场景被推两遍.
     */
    bindViewState(state: ViewState): void {
        this._unbindViewState();

        // 相机:投影模式 / 预置视角 / 旋转锁定.
        this._viewStops.push(
            effect(() => this.cameraManager.setCameraMode(state.camMode.value)),
            effect(() => this.cameraManager.setView(state.viewHome.value)),
            effect(() => this.cameraManager.setRotationLock(state.rotationLock.value)),
        );

        // 向上轴:OrbitControls 构造时读取相机 up 向量,真的换轴之后才重建.
        // rotationLock 用 peek:锁变化不必把本 effect 也重跑一遍.
        this._viewStops.push(effect(() => {
            if (this.cameraManager.setUpAxis(state.upAxis.value)) {
                this._createControls();
                this.cameraManager.setRotationLock(state.rotationLock.peek());
            }
        }));

        // 点样式:场景 point 对象与分析测量点共用同一个半径/可见性.
        this._viewStops.push(effect(() => {
            const style = {
                radius: state.pointRadius.value,
                visible: state.pointVisible.value,
            };
            this.plotter.setPointStyle(style);
            this.analysisRenderer.setPointStyle(style);
        }));

        // 曲面样式.
        this._viewStops.push(effect(() => {
            this.plotter.setSurfaceStyle({
                wireframeVisible: state.surfaceWireframe.value,
                colorMapEnabled: state.surfaceColorMap.value,
            });
        }));

        // 坐标轴线宽 / 三个轴的标签 / 网格与刻度.
        this._viewStops.push(
            effect(() => this.sceneManager.setAxisLineWidth(state.axisLineWidth.value)),
            effect(() => this.sceneManager.setAxisLabelVisible('x', state.axisLabelX.value)),
            effect(() => this.sceneManager.setAxisLabelVisible('y', state.axisLabelY.value)),
            effect(() => this.sceneManager.setAxisLabelVisible('z', state.axisLabelZ.value)),
            effect(() => {
                this.sceneManager.setPlaneVisible('xz', state.gridPlaneXZ.value);
                this.sceneManager.setPlaneVisible('xy', state.gridPlaneXY.value);
                this.sceneManager.setPlaneVisible('yz', state.gridPlaneYZ.value);
                this.sceneManager.setTicksVisible(state.axisTicks.value);
                this.sceneManager.setTickUnit(state.axisPiUnit.value);
                this.sceneManager.setGridLineWidths(
                    state.gridMajorWidth.value,
                    state.gridMinorWidth.value,
                );
            }),
        );
    }

    /**
     * 释放 `bindViewState` 建立的全部 effect.
     *
     * 幂等:可以重复调用(dispose 之后再 dispose,或 bind 之前先释放).
     */
    private _unbindViewState(): void {
        for (const stop of this._viewStops) stop();
        this._viewStops.length = 0;
    }

    private _createControls(): void {
        // 旧 controls 释放后当前相机已由 CameraManager 重新取景
        this.cameraManager.detachControls();
        this.controls = null;

        const renderer = this.sceneManager.getRenderer();
        const controls = new OrbitControls(
            this.cameraManager.getCamera(),
            renderer.domElement,
        );
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.target.set(0, 0, 0);
        controls.update();
        this.cameraManager.setControls(controls);
        this.controls = controls;
    }

    /** 每帧执行一次,由 DslApp 的 requestAnimationFrame 循环调用. */
    frame(timestamp: number): void {
        this.controls?.update();
        this._updateAnimations(timestamp);
        this.sceneManager.render(this.cameraManager.getCamera());
    }

    /**
     * 按视口容器尺寸重排渲染器与相机 aspect.
     *
     * 容器量不到尺寸(尚未挂载 / 整窗隐藏)时什么都不做:此时 `setSize` 会把
     * 画布钉成 0×0,`0 / 0` 还会把相机 aspect 变成 NaN.等容器真有尺寸时
     * ResizeObserver 会再叫一次.
     */
    resize(): void {
        const { width, height } = this.sceneManager.resize();
        if (width <= 0 || height <= 0) return;
        this.cameraManager.updateAspect(width, height);
    }

    /** [键盘事件]按下`home`键视角看向原点(0,0,0) */
    resetHome(): void {
        if (!this.controls) return;
        this.controls.target.set(0, 0, 0);
        this.controls.update();
    }

    /**
     * 完整应用一份 SceneIR.
     *
     * @param changedParams 传入集合时只重绘依赖这些参数的对象;不传则视为
     *                      完整运行,所有对象都重新采样.
     */
    applyScene(
        scene: SceneIR,
        changedParams?: ReadonlySet<string>,
    ): void {
        this.animationPlayer.configure(this.store.matrixOps);
        this.currentScene = scene;

        const nextIds = new Set(scene.objects.map((object) => object.id));

        for (const id of this.store.hiddenEntityIds) {
            if (!nextIds.has(id)) this.store.setEntityHidden(id, false);
        }
        for (const object of scene.objects) {
            object.enabled = !this.store.isEntityHidden(object.id);
        }

        this.store.setScene(scene);
        this.animationPlayer.setScene(
            scene.objectTransforms,
            scene.animations,
            scene.objectAnimations,
        );

        for (const previous of this.previousObjects) {
            if (!nextIds.has(previous.id)) {
                this.plotter.remove(previous.id);
            }
        }

        const dirtyObjectIds = new Set<number>();
        const objectsByName = new Map<string, SceneObject>();
        for (const object of scene.objects) {
            if (object.name !== undefined) {
                objectsByName.set(object.name, object);
            }
        }
        for (const object of scene.objects) {
            if (!object.enabled) {
                this.plotter.setVisible(object.id, false);
                continue;
            }

            const shouldRedraw = !changedParams
                || this._objectDependsOnParams(object, changedParams);
            if (shouldRedraw) {
                dirtyObjectIds.add(object.id);
                this.plotter.updateObject(object, true, objectsByName);
                this._applyObjectTransform(object.id);
            } else {
                // 引用仍需同步,否则后续其他参数变化时,renderer 手里还拿着旧数据.
                this.plotter.updateObject(object, false, objectsByName);
            }
        }

        this.previousObjects = scene.objects;
        this._syncOverlays(
            scene,
            changedParams ? dirtyObjectIds : null,
            !changedParams,
            changedParams,
        );
    }

    /**
     * 显隐变化时不需要重新采样几何对象,只需更新 SceneIR/动画时间线
     * 和分析/积分/对象列表等 overlay.
     */
    commitSceneWithoutRedraw(scene: SceneIR): void {
        this.animationPlayer.configure(this.store.matrixOps);
        this.currentScene = scene;
        this.store.setScene(scene);
        this.animationPlayer.setScene(
            scene.objectTransforms,
            scene.animations,
            scene.objectAnimations,
        );
        this.previousObjects = scene.objects;
        // store 里换成了重新 materialize 的新对象实例,Plotter 手里的引用
        // 必须同步,否则 renderer 会长期拿着过期对象(见 RND-P2.4).
        this._syncPlotterRefs(scene);
        // overlayOnly:切换某一"分析/积分/求交"显隐时,其他积分不该被销毁重算.
        this._syncOverlays(scene, null, false, undefined, true);
    }

    /**
     * 切换单个实体的显隐:隐藏 = 不渲染(Three.js 里 group.visible=false)
     * + 不参与计算(跳过采样/变换,区域类还会让对应积分停算).
     *
     * 实体显隐**不需要重新编译**:状态写回 SceneStore(下次 `applyScene` 会
     * 据此覆盖 IR 里的 enabled),再直接更新 Plotter 与对象列表.
     *
     * 重新显示必须走 `redraw = true`:隐藏期间 `applyScene` 会跳过该对象
     * (`setVisible(false)` 后 continue),renderer 可能根本没建出来,
     * 只同步引用(`_updateRef`)不会补画.这也是它不能直接复用
     * `commitSceneWithoutRedraw` 的原因.
     */
    toggleObject(id: number): void {
        const object = this.store.findObject(id);
        if (!object) return;

        const visible = !object.enabled;
        object.enabled = visible;
        this.store.setEntityHidden(id, !visible);

        if (visible) {
            const objectsByName = new Map<string, SceneObject>();
            for (const candidate of this.store.compiledObjects) {
                if (candidate.name !== undefined) {
                    objectsByName.set(candidate.name, candidate);
                }
            }
            this.plotter.updateObject(object, true, objectsByName);
            this._applyObjectTransform(object.id);
        } else {
            this.plotter.setVisible(object.id, false);
        }

        // 列表行按新的 enabled 重建(键里含 enabled):显隐按钮文案,
        // `is-hidden` 与"已隐藏"状态芯片都从 IR 推导,不在这里手改 DOM.
        if (this.currentScene !== null) {
            this.objectListController.renderScene(this.currentScene);
        }
    }

    dispose(): void {
        this.stopSamplingFailureListener();
        // 先摘尺寸观察:下面的 dispose 正在拆场景与渲染器,回调不该再进来.
        this.viewportObserver.disconnect();
        this.cameraManager.detachControls();
        this.controls = null;
        // 视图状态的 effect 统一释放:漏掉退订会让闭包把整个场景图钉在堆上.
        this._unbindViewState();
        this.cameraManager.dispose();
        this.integralRenderer.dispose();
        this.analysisRenderer.dispose();
        this.intersectionRenderer.dispose();
        this.plotter.dispose();
        this.sceneManager.dispose();

        // 共享 worker 必须最后统一 terminate;前面的 renderer.dispose()
        // 已经不再拥有销毁这些 client 的权利.门面把 5 个领域 dispose*
        // 收口成一次调用,这里不再逐个 import.
        this.computeEngine.dispose();
    }

    private _updateAnimations(timestamp: number): void {
        if (this.store.animationStartTime === 0) return;

        const elapsedSeconds =
            (timestamp - this.store.animationStartTime) / 1000;
        for (const object of this.store.compiledObjects) {
            if (!object.enabled) continue;
            this._applyObjectTransform(object.id, elapsedSeconds);
        }
    }

    private _applyObjectTransform(
        id: number,
        elapsedSeconds?: number,
    ): void {
        const elapsed = elapsedSeconds ?? this.store.getElapsedSeconds();
        const matrix = this.animationPlayer.getObjectMatrix(id, elapsed);
        this.plotter.applyTransform(id, matrix);
    }

    /**
     * 只同步 Plotter 持有的对象引用(不重新采样/重建 GPU 资源).
     *
     * `commitSceneWithoutRedraw` 会 `store.setScene(重新 materialize 的场景)`,
     * 对象实例是新的,而 Plotter 的 renderer 仍指向旧实例;不重同步的话
     * renderer 侧的 `point`/`curve` 等引用会长期过期,是 RND-P2.4 一类
     * "可见性/参数用错来源"问题的根因.
     */
    private _syncPlotterRefs(scene: SceneIR): void {
        const objectsByName = new Map<string, SceneObject>();
        for (const object of scene.objects) {
            if (object.name !== undefined) {
                objectsByName.set(object.name, object);
            }
        }
        for (const object of scene.objects) {
            // updateObject(..., false) 只同步 renderer 内部引用与可见性
            // (Plotter._updateRef 末尾会按 obj.enabled 设置 group.visible).
            this.plotter.updateObject(object, false, objectsByName);
        }
    }

    private _syncOverlays(
        scene: SceneIR,
        dirtyObjectIds: ReadonlySet<number> | null,
        forceIntersections: boolean,
        changedParams: ReadonlySet<string> | undefined = undefined,
        overlayOnly = false,
    ): void {
        // 本轮诊断先收集,最后一次性交给控制器:诊断区是 aria-live 区域,
        // 逐条 clear()+add() 会让读屏在拖参数时每帧重放同一批警告(UI-P3.7);
        // MessageList.render 在内容不变时一次 DOM 操作都不做.
        const diagnostics: MessageEntry[] = [];
        this.objectListController.renderScene(scene);
        this.analysisRenderer.render(
            scene.analyses.filter((analysis) => analysis.enabled),
        );
        this._syncIntersections(scene, forceIntersections, diagnostics);
        this.integralRenderer.sync(
            scene.integrals,
            scene.objects,
            scene.objectTransforms,
            (level, message) => diagnostics.push({ level, message }),
            dirtyObjectIds,
            changedParams ?? null,
            (name, value) =>
                this.objectListController.setIntegralResult(name, value),
            (name, message) =>
                this.objectListController.setIntegralError(name, message),
            overlayOnly,
        );
        this.diagnosticsController.render(diagnostics);
    }

    private _syncIntersections(
        scene: SceneIR,
        force: boolean,
        diagnostics: MessageEntry[],
    ): void {
        this.intersectionRenderer.sync(
            scene.intersections,
            scene.objects,
            scene.objectTransforms,
            force,
            (name, output) =>
                this.objectListController.setIntersectionResult(name, output),
            (name, message) => {
                this.objectListController.setIntersectionError(name, message);
                diagnostics.push({
                    level: 'error',
                    message: `求交 ${name} 失败: ${message}`,
                });
            },
        );
    }

    /**
     * point/vector 的坐标表达式虽然暂时没有 coefficients 字段,
     * 但它们也可能引用 param,因此参数变化时保守地标记为 dirty.
     */
    private _objectDependsOnParams(
        object: SceneObject,
        changedParams: ReadonlySet<string>,
    ): boolean {
        if (object.kind === 'point' || object.kind === 'vector') {
            return true;
        }
        return object.coefficients.some((coefficient) =>
            changedParams.has(coefficient.name),
        );
    }
}
