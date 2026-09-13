/**
 * SceneStore -- graphcalc 应用层的场景状态仓库.
 *
 * 这里只保存与"当前这次编译/渲染会话"直接相关的状态:
 * - 最近一次成功解析的 AST
 * - 当前矩阵运算后端
 * - 最近一次编译出的场景对象快照
 * - 实体/分析/积分的显隐状态
 * - 动画计时起点
 *
 * 它不负责解析/编译/渲染,也不直接操作 DOM.CompileController 负责
 * 写入 AST 和 matrixOps,RenderController 负责写入场景快照并读取显隐状态.
 * 把状态从 DslApp 抽出来,是为了让 DslApp 只做装配和事件编排.
 */
import type { AstProgram } from '../compiler/ast/types';
import type { SceneIR, SceneObject } from '../compiler/ir/types';
import type { MatrixOps } from '../math/tensor/SceneTransform';

export class SceneStore {
    private _currentAst: AstProgram | null = null;
    private _lastRunSource = '';
    /**
     * 首次 run() 成功前没有可用的 WASM 后端;渲染层在该时间点前不会使用矩阵.
     */
    private _matrixOps: MatrixOps | null = null;
    private _compiledObjects: SceneObject[] = [];

    private _animationStartTime = 0;

    private readonly _hiddenEntityIds = new Set<number>();
    private readonly _hiddenAnalysisNames = new Set<string>();
    private readonly _hiddenIntegralNames = new Set<string>();
    private readonly _hiddenIntersectionNames = new Set<string>();

    get ast(): AstProgram | null {
        return this._currentAst;
    }

    /** 最近一次成功解析的源码;CompileController 用它把编译错误的 span 换算成行列. */
    get source(): string {
        return this._lastRunSource;
    }

    get matrixOps(): MatrixOps | null {
        return this._matrixOps;
    }

    get compiledObjects(): readonly SceneObject[] {
        return this._compiledObjects;
    }

    get animationStartTime(): number {
        return this._animationStartTime;
    }

    get hiddenEntityIds(): ReadonlySet<number> {
        return this._hiddenEntityIds;
    }

    get hiddenAnalysisNames(): ReadonlySet<string> {
        return this._hiddenAnalysisNames;
    }

    get hiddenIntegralNames(): ReadonlySet<string> {
        return this._hiddenIntegralNames;
    }

    get hiddenIntersectionNames(): ReadonlySet<string> {
        return this._hiddenIntersectionNames;
    }

    /**
     * @cache_access
     * 在一次源码解析成功后提交新的 AST 和矩阵后端.
     *
     * 只有当源码内容发生变化时才重置显隐状态.这样 Ctrl+Enter 重跑同一份
     * 源码不会把用户手动隐藏的对象突然恢复出来.
     */
    commitSource(
        source: string,
        ast: AstProgram,
        nextMatrixOps: MatrixOps,
    ): void {
        if (this._lastRunSource !== source) {
            this._hiddenEntityIds.clear();
            this._hiddenAnalysisNames.clear();
            this._hiddenIntegralNames.clear();
            this._hiddenIntersectionNames.clear();
        }

        this._lastRunSource = source;
        this._currentAst = ast;
        this._matrixOps = nextMatrixOps;
    }

    /**
     * @cache_access
     * 保存最近一次编译出的对象快照
     */
    setScene(scene: SceneIR): void {
        this._compiledObjects = scene.objects;
    }

    setAnimationStartTime(value: number): void {
        this._animationStartTime = value;
    }

    /** 返回从动画起点开始经过的秒数;没有起点时按 0 处理. */
    getElapsedSeconds(now: number = performance.now()): number {
        if (this._animationStartTime === 0) return 0;
        return (now - this._animationStartTime) / 1000;
    }

    /**
     * @cache_access
     * 从最近一次编译对象快照中查找实体.
     */
    findObject(id: number): SceneObject | undefined {
        return this._compiledObjects.find((candidate) => candidate.id === id);
    }

    isEntityHidden(id: number): boolean {
        return this._hiddenEntityIds.has(id);
    }

    /**
     * @cache_access
     * 更新实体显隐缓存.
     */
    setEntityHidden(id: number, hidden: boolean): void {
        if (hidden) {
            this._hiddenEntityIds.add(id);
        } else {
            this._hiddenEntityIds.delete(id);
        }
    }

    /**
     * @cache_access
     * 更新分析对象显隐缓存.
     */
    toggleAnalysisHidden(name: string): void {
        if (this._hiddenAnalysisNames.has(name)) {
            this._hiddenAnalysisNames.delete(name);
        } else {
            this._hiddenAnalysisNames.add(name);
        }
    }

    /**
     * @cache_access
     * 更新积分对象显隐缓存.
     */
    toggleIntegralHidden(name: string): void {
        if (this._hiddenIntegralNames.has(name)) {
            this._hiddenIntegralNames.delete(name);
        } else {
            this._hiddenIntegralNames.add(name);
        }
    }

    /**
     * @cache_access
     * 更新求交对象显隐缓存.
     */
    toggleIntersectionHidden(name: string): void {
        if (this._hiddenIntersectionNames.has(name)) {
            this._hiddenIntersectionNames.delete(name);
        } else {
            this._hiddenIntersectionNames.add(name);
        }
    }
}
