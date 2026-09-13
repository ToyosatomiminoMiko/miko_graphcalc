/**
 * CompileController -- 源码到 SceneIR 的编译编排器.
 *
 * DslApp 不再直接处理 AST/runSequence 和显隐状态,而是通过这个控制器
 * 完成三件事:
 * 1. `run(source)`:解析新源码并生成一份完整 SceneIR;
 * 2. `refresh(paramOverrides)`:复用当前 AST,只按新参数重新编译;
 * 3. `toggleAnalysis/toggleIntegral/toggleIntersection`:切换求值对象显隐后重新编译.
 *
 * 实体显隐不经过这里:它只改 Plotter 可见性,不需要重新编译
 * (见 RenderController.toggleObject).
 *
 * 真正的编译细节仍由 compiler/dsl 下的 DslCompiler 和静态场景缓存负责.
 */
import { compileScene } from '../compiler/dsl/DslCompiler';
import { parseMiko } from '../compiler/parser';
import { createWasmMatrixOps } from '../compiler/matrixOps';
import type { SceneIR } from '../compiler/ir/types';
import { CompileError, formatLocatedError } from '../compiler/errors';
import { SceneStore } from './SceneStore';

export class CompileController {
    private runSequence = 0;
    private disposed = false;

    constructor(private readonly store: SceneStore) {}

    /**
     * 解析并编译一份新源码.
     *
     * 返回 null 表示请求已经过期或控制器已销毁,调用方必须直接丢弃结果.
     * 这样异步 parseMiko 返回后不会覆盖用户随后发起的新运行.
     */
    async run(source: string): Promise<SceneIR | null> {
        const runId = ++this.runSequence;
        const ast = await parseMiko(source);

        if (this.disposed || runId !== this.runSequence) return null;

        this.store.commitSource(source, ast, createWasmMatrixOps());
        return this.compile({});
    }

    /**
     * 基于当前 AST 重新编译.
     *
     * 参数刷新不会重新解析 DSL,只把当前参数覆盖到静态场景上.这样可以
     * 命中 DslCompiler 内部的静态场景缓存,避免重复做声明级建模.
     */
    refresh(paramOverrides: Record<string, number>): SceneIR | null {
        if (!this.store.ast) return null;
        return this.compile(paramOverrides);
    }

    toggleAnalysis(
        name: string,
        paramOverrides: Record<string, number>,
    ): SceneIR | null {
        this.store.toggleAnalysisHidden(name);
        return this.recompileForVisibilityChange(paramOverrides);
    }

    toggleIntegral(
        name: string,
        paramOverrides: Record<string, number>,
    ): SceneIR | null {
        this.store.toggleIntegralHidden(name);
        return this.recompileForVisibilityChange(paramOverrides);
    }

    toggleIntersection(
        name: string,
        paramOverrides: Record<string, number>,
    ): SceneIR | null {
        this.store.toggleIntersectionHidden(name);
        return this.recompileForVisibilityChange(paramOverrides);
    }

    dispose(): void {
        this.disposed = true;
        this.runSequence += 1;
    }

    private recompileForVisibilityChange(
        paramOverrides: Record<string, number>,
    ): SceneIR | null {
        const scene = this.refresh(paramOverrides);
        if (!scene) return null;

        // 实体显隐不需要重新触发数值采样,但 SceneIR 中的 enabled 必须
        // 与 SceneStore 保持同步,后续对象列表和渲染层都依赖它.
        for (const object of scene.objects) {
            object.enabled = !this.store.isEntityHidden(object.id);
        }
        return scene;
    }

    private compile(paramOverrides: Record<string, number>): SceneIR {
        const ast = this.store.ast;
        if (!ast) {
            throw new Error('CompileController 没有可用的 AST,请先调用 run()');
        }
        const matrixOps = this.store.matrixOps;
        if (!matrixOps) {
            throw new Error('矩阵运算后端尚未初始化,请先调用 run()');
        }

        try {
            return compileScene(ast, paramOverrides, matrixOps, {
                hiddenAnalysisNames: this.store.hiddenAnalysisNames,
                hiddenIntegralNames: this.store.hiddenIntegralNames,
                hiddenIntersectionNames: this.store.hiddenIntersectionNames,
            });
        } catch (error) {
            throw this.locate(error);
        }
    }

    /**
     * 语句级编译错误(CompileError)由各 dsl 模块按语句 span 抛出;这里用
     * store 里的原始源码把 span 换算成"第几行第几列"拼进文案,实现错误定位.
     * 解析错误(Rust pest 文案自带行列)与运行期错误与具体语句无关,原样抛出.
     */
    private locate(error: unknown): Error {
        if (!(error instanceof CompileError)) {
            return error instanceof Error ? error : new Error(String(error));
        }
        return new Error(formatLocatedError(error.message, error.span, this.store.source));
    }
}
