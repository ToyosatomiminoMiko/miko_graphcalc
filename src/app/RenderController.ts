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
import { CameraToggle } from '@/ui/view/controls/CameraToggle';
import { ViewCubeController } from '@/ui/view/controls/ViewCubeController';
import { RotationLockController } from '@/ui/view/controls/RotationLockController';
import { PointStyleController } from '@/ui/view/controls/PointStyleController';
import { SurfaceStyleController } from '@/ui/view/controls/SurfaceStyleController';
import { AxisLineWidthController } from '@/ui/view/controls/AxisLineWidthController';
import { GridTicksController } from '@/ui/view/controls/GridTicksController';
import { AxisLabelController } from '@/ui/view/controls/AxisLabelController';
import { AxisUpController } from '@/ui/view/controls/AxisUpController';
import type { SceneIR, SceneObject } from '@/contract/ir';
import type { GraphCalcEvents } from '@/contract/events';
import { EventBus } from '@/core/EventBus';
import { onSamplingFailure } from '@/render/core/samplingErrors';
import { SceneStore } from './SceneStore';
import { DiagnosticsController } from '@/ui/diagnostics/DiagnosticsController';
import type { DiagnosticEntry } from '@/ui/diagnostics/DiagnosticsController';
import { ObjectListController } from '@/ui/objects/ObjectListController';
import type { ViewPanel } from '@/ui/view/ViewPanel';

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
    private cameraToggle: CameraToggle | null = null;
    private viewCubeController: ViewCubeController | null = null;
    private rotationLockController: RotationLockController | null = null;
    private pointStyleController: PointStyleController | null = null;
    private surfaceStyleController: SurfaceStyleController | null = null;
    private axisLineWidthController: AxisLineWidthController | null = null;
    private gridTicksController: GridTicksController | null = null;
    private axisLabelController: AxisLabelController | null = null;
    private axisUpController: AxisUpController | null = null;

    /**
     * `wireViewControls` 注册的 EventBus 退订函数.
     *
     * 这条链最容易漏:监听注册在别人的对象(EventBus,由 DslApp 持有到页面结束)
     * 上,不显式退订就永远不会失效,闭包捕获的 `this` 与三个渲染器也就永远活着.
     */
    private readonly _viewListeners: Array<() => void> = [];

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
        private readonly diagnosticsController: DiagnosticsController,
        private readonly objectListController: ObjectListController,
    ) {
        this.sceneManager = new SceneManager(viewport);
        this.cameraManager = new CameraManager(viewport);
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
     * 把"视图"面板的控件挂到 EventBus,保持 DslApp 不直接处理相机细节.
     *
     * 面板本身由 DslApp 装配(`createViewPanel`),这里只按分组把句柄发给对应
     * 控制器:每个控件恰好一个所有者,`dispose` 时各自解绑自己那几个.
     *
     * 这里注册的 EventBus 监听同样有所有者 -- 就是本控制器,退订函数收进
     * `_viewListeners`,由 `dispose()` 统一释放.漏掉这一步的后果不是"多几条
     * 无用回调":bus 由 DslApp 持有到页面结束,每个闭包都捕获 `this` 与
     * cameraManager/plotter/sceneManager,会把整个 WebGL 场景图钉在堆上.
     *
     * 重复调用会先释放上一轮监听与控制器:再调一次不该让事件触发两遍.
     */
    wireViewControls(eventBus: EventBus<GraphCalcEvents>, panel: ViewPanel): void {
        this._unwireViewControls();

        // 先注册监听,再创建控制器:控制器启动时会同步一次初始状态
        // (RotationLockController 现在也会),监听晚注册就会丢掉这次同步.
        this._viewListeners.push(
            eventBus.on('camera:changed', ({ camMode }) =>
                this.cameraManager.setCameraMode(camMode),
            ),
            eventBus.on('camera:view', ({ view }) =>
                this.cameraManager.setView(view),
            ),
            eventBus.on('camera:rotationLock', ({ locked }) =>
                this.cameraManager.setRotationLock(locked),
            ),
        );

        this.cameraToggle = new CameraToggle(eventBus, panel.camera);
        this.viewCubeController = new ViewCubeController(eventBus, panel.viewCube);
        this.rotationLockController = new RotationLockController(
            eventBus,
            panel.camera.rotationLock,
        );

        // OrbitControls 在构造时读取相机 up 向量,真的切换"向上轴"后才需要重建
        this._viewListeners.push(
            eventBus.on('axis:upChanged', ({ axis }) => {
                if (this.cameraManager.setUpAxis(axis)) {
                    this._createControls();
                    if (this.rotationLockController) {
                        this.cameraManager.setRotationLock(
                            this.rotationLockController.locked,
                        );
                    }
                }
            }),
        );
        this.axisUpController = new AxisUpController(eventBus, panel.axis.up);

        this._viewListeners.push(
            eventBus.on('point:changed', ({ radius, visible }) => {
                this.plotter.setPointStyle({ radius, visible });
                this.analysisRenderer.setPointStyle({ radius, visible });
            }),
        );
        this.pointStyleController = new PointStyleController(eventBus, panel.point);

        this._viewListeners.push(
            eventBus.on('surface:changed', ({ wireframeVisible, colorMapEnabled }) => {
                this.plotter.setSurfaceStyle({ wireframeVisible, colorMapEnabled });
            }),
        );
        this.surfaceStyleController = new SurfaceStyleController(eventBus, panel.surface);

        this._viewListeners.push(
            eventBus.on('axis:lineWidthChanged', ({ width }) => {
                this.sceneManager.setAxisLineWidth(width);
            }),
        );
        this.axisLineWidthController = new AxisLineWidthController(
            eventBus,
            panel.axis.lineWidth,
        );

        this._viewListeners.push(
            eventBus.on('axis:labelVisibility', ({ x, y, z }) => {
                this.sceneManager.setAxisLabelVisible('x', x);
                this.sceneManager.setAxisLabelVisible('y', y);
                this.sceneManager.setAxisLabelVisible('z', z);
            }),
        );
        this.axisLabelController = new AxisLabelController(eventBus, panel.axis.labels);

        this._viewListeners.push(
            eventBus.on('grid:changed', ({ xzVisible, xyVisible, yzVisible, ticksVisible, piUnit, majorWidth, minorWidth }) => {
                this.sceneManager.setPlaneVisible('xz', xzVisible);
                this.sceneManager.setPlaneVisible('xy', xyVisible);
                this.sceneManager.setPlaneVisible('yz', yzVisible);
                this.sceneManager.setTicksVisible(ticksVisible);
                this.sceneManager.setTickUnit(piUnit);
                this.sceneManager.setGridLineWidths(majorWidth, minorWidth);
            }),
        );
        this.gridTicksController = new GridTicksController(eventBus, panel.axis);
    }

    /**
     * 释放 `wireViewControls` 注册的 EventBus 监听与它创建的控件.
     *
     * 幂等:可以重复调用(dispose 之后再 dispose,或 wire 之前先 dispose).
     */
    private _unwireViewControls(): void {
        for (const unsubscribe of this._viewListeners) unsubscribe();
        this._viewListeners.length = 0;

        this.cameraToggle?.dispose();
        this.viewCubeController?.dispose();
        this.rotationLockController?.dispose();
        this.pointStyleController?.dispose();
        this.surfaceStyleController?.dispose();
        this.axisLineWidthController?.dispose();
        this.gridTicksController?.dispose();
        this.axisLabelController?.dispose();
        this.axisUpController?.dispose();

        this.cameraToggle = null;
        this.viewCubeController = null;
        this.rotationLockController = null;
        this.pointStyleController = null;
        this.surfaceStyleController = null;
        this.axisLineWidthController = null;
        this.gridTicksController = null;
        this.axisLabelController = null;
        this.axisUpController = null;
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

    resize(): void {
        const { width, height } = this.sceneManager.resize();
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
        this.cameraManager.detachControls();
        this.controls = null;
        // EventBus 监听 + 视图控件统一释放:漏掉退订会把整个场景图钉在堆上.
        this._unwireViewControls();
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
        // DiagnosticsController.render 在内容不变时一次 DOM 操作都不做.
        const diagnostics: DiagnosticEntry[] = [];
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
        diagnostics: DiagnosticEntry[],
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
