/**
 * 微分方程编译:设计文档 `docs/plan3.md` 第 1.3 节(求值层).
 *
 * 分工与不定积分完全一致,**两层都不重复调内核**:
 * - 实体层(`odeBlueprint.ts` 的 `buildOdeBlueprints`)调一次内核,把斜率场
 *   与解曲线物化成普通 surface/curve,并登记 `odeFacts`;
 * - 本文件把那份事实转成 `OdeTask`,只做选项校验,隐藏语义与 IR 组装.
 *
 * 为什么不在本文件调内核:步骤链是展示的唯一来源,两处各调一次就有漂移风险
 * (与 `antiderivativeTasks.ts` 文件头同一条理由).隐藏语义沿用约定 1
 * ("先完整校验,后禁用,仅跳过计算"):选项/重名照常校验,只是不再下发对象与
 * 求值条目,列表保留占位.
 */
import type { AstProgram } from '../ast/types';
import type { OdeTask } from '../../ir';
import { withStatementSpan } from '../errors';
import { assertKnownOptions } from './options';
import { ODE_OPTION_NAMES } from './odeExpressions';
import type { OdeFact } from './odeBlueprint';

/** 一条微分方程的编译结果(隐藏时只有占位). */
export interface CompiledOde {
    task: OdeTask;
}

/**
 * 把静态场景层算好的微分方程事实组装成 IR 任务.
 *
 * - `facts`:静态场景层的产物;缺条目说明这条语句当时越过了能力边界(或没建
 *   对象),此时 `error` 来自事实里的理由,列表保留占位;
 * - `hiddenNames`:隐藏项只保留占位,`enabled=false`.
 */
export function collectOdeTasks(
    ast: AstProgram,
    facts: ReadonlyMap<string, OdeFact>,
    hiddenNames: ReadonlySet<string>,
): CompiledOde[] {
    const compiled: CompiledOde[] = [];
    const seen = new Set<string>();

    ast.statements.forEach((statement) => {
        if (statement.type !== 'ode') return;
        withStatementSpan(statement.span, () => {
            const name = statement.name;
            if (seen.has(name)) {
                throw new Error(`微分方程 ${name} 重复声明`);
            }
            seen.add(name);
            assertKnownOptions(statement.options, ODE_OPTION_NAMES, `微分方程 ${name}`);

            if (hiddenNames.has(name)) {
                compiled.push(disabledCompiled(name, statement.equation, statement.initialConditions));
                return;
            }

            // 事实一定存在:能力边界也在静态场景层登记(带 `error` 的理由),
            // 所以这里不再有"缺失"分支(与不定积分同一条口径).
            const fact = facts.get(name);
            if (fact === undefined) {
                throw new Error(`微分方程 ${name} 缺少编译产物(内部一致性检查):请重新运行`);
            }

            compiled.push({
                task: {
                    name,
                    equation: fact.equation,
                    independent: fact.independent,
                    dependent: fact.dependent,
                    order: fact.order,
                    equationLatex: fact.equationLatex,
                    generalLatex: fact.generalLatex,
                    particularLatex: fact.particularLatex,
                    initialConditions: [...fact.initialConditions],
                    implicit: fact.implicit,
                    slopeLatex: fact.slopeLatex === '' ? null : fact.slopeLatex,
                    slopeObjectId: fact.slopeObjectId,
                    curveNames: [...fact.curveNames],
                    notes: [...fact.notes],
                    arbitraryConstantCount: fact.arbitraryConstantCount,
                    verified: fact.verified,
                    steps: fact.steps.map((entry) => ({
                        latex: entry.latex,
                        reason: entry.reason,
                        kind: entry.kind,
                    })),
                    error: fact.error,
                    enabled: true,
                },
            });
        });
    });

    return compiled;
}

/**
 * 能力边界 / 隐藏的占位条目.
 *
 * 与求解内核同口径:**方程原文照给**(源码没写错,只是没算或算不动),
 * 列表照常保留;`slopeObjectId = 0` 表示没有下发实体.
 */
function disabledCompiled(
    name: string,
    equation: string,
    initialConditions: readonly string[],
): CompiledOde {
    return {
        task: {
            name,
            equation: equation.trim(),
            independent: '',
            dependent: '',
            order: 0,
            equationLatex: '',
            generalLatex: null,
            particularLatex: null,
            initialConditions: [...initialConditions],
            implicit: false,
            slopeLatex: null,
            slopeObjectId: 0,
            curveNames: [],
            notes: [],
            arbitraryConstantCount: 0,
            verified: false,
            steps: [],
            error: null,
            enabled: false,
        },
    };
}
