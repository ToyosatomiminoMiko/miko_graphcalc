/**
 * 不定积分(原函数)编译:设计文档 `docs/calculus-suite-plan.md` 第 3 节.
 *
 * 分工与既有模块一致,**两层都不重复调内核**:
 * - 实体层(`antiderivativeBlueprint.ts` 的 `buildAntiderivativeBlueprint`)
 *   调一次内核,把原函数表达式物化成普通 curve/surface,并登记
 *   `antiderivativeFacts`(题目/原函数 LaTeX/验证结论/步骤链);
 * - 本文件把那份事实转成 `AntiderivativeTask`,只做选项校验,隐藏语义与
 *   IR 组装.
 *
 * 为什么不在这里调内核:内核是纯函数,调两次结果一致,但步骤链是展示的唯一
 * 来源,一旦两处各调一次就有漂移风险(改了一处忘记另一处).让静态场景层
 * 一次算完,求值层只消费,是既有 `solves.ts`(内核一次)的同款口径.
 *
 * 隐藏语义沿用约定 1("先完整校验,后禁用,仅跳过计算"):选项/重名/源对象
 * 照常校验,只是不再调内核,也不下发对象.
 */
import type { AstProgram } from '../ast/types';
import type { AntiderivativeTask, SceneObject } from '../../ir';
import { withStatementSpan } from '../errors';
import { assertKnownOptions } from './options';
import {
    ANTIDERIVATIVE_OPTION_NAMES,
    type AntiderivativeFact,
} from './antiderivativeBlueprint';

/** 一条不定积分的编译结果:求值条目 + 下发的实体对象(失败/隐藏时为 null). */
export interface CompiledAntiderivative {
    task: AntiderivativeTask;
    /**
     * 下发的实体对象(从 `objects` 里按名取出,不是这里新建的).
     *
     * 静态场景层已经把原函数物化成 curve/surface;这里只做"认领",从而保证
     * 求值条目与实体的表达式**同一个来源**.
     */
    object: SceneObject | null;
}

/**
 * 把静态场景层算好的不定积分事实组装成 IR 任务.
 *
 * - `facts`:静态场景层的产物;缺条目说明这条语句当时越过了能力边界(或没建
 *   对象),此时 `error` 来自 facts 里的理由,列表保留占位;
 * - `objects`:当前物化后的对象表(静态场景产物 + 原函数对象),按名认领;
 * - `hiddenNames`:隐藏项只保留占位,`enabled=false`.
 */
export function collectAntiderivativeTasks(
    ast: AstProgram,
    facts: ReadonlyMap<string, AntiderivativeFact>,
    objects: readonly SceneObject[],
    hiddenNames: ReadonlySet<string>,
): CompiledAntiderivative[] {
    const byName = new Map<string, SceneObject>();
    for (const object of objects) {
        if (object.name !== undefined) byName.set(object.name, object);
    }

    const compiled: CompiledAntiderivative[] = [];
    const seen = new Set<string>();

    ast.statements.forEach((statement) => {
        if (statement.type !== 'antiderivative') return;
        withStatementSpan(statement.span, () => {
            const name = statement.name;
            if (seen.has(name)) {
                throw new Error(`不定积分 ${name} 重复声明`);
            }
            seen.add(name);
            assertKnownOptions(statement.options, ANTIDERIVATIVE_OPTION_NAMES, `不定积分 ${name}`);

            if (hiddenNames.has(name)) {
                compiled.push(disabledCompiled(name));
                return;
            }

            // 事实一定存在:能力边界(非初等/超出规则)也在静态场景层登记
            // (带 `error` 的理由),所以这里不再有"缺失"分支.
            const fact = facts.get(name);
            if (fact === undefined) {
                throw new Error(
                    `不定积分 ${name} 缺少编译产物(内部一致性检查):请重新运行`,
                );
            }

            const task: AntiderivativeTask = {
                name,
                objectId: byName.get(name)?.id ?? 0,
                sourceKind: fact.sourceKind,
                variable: fact.variable,
                integrand: fact.integrand,
                integrandLatex: fact.integrandLatex,
                antiderivativeText: fact.antiderivativeText,
                antiderivativeLatex: fact.antiderivativeLatex,
                constant: fact.constant,
                constantSymbol: fact.constantSymbol,
                verified: fact.verified,
                steps: fact.steps.map((entry) => ({
                    latex: entry.latex,
                    reason: entry.reason,
                    kind: entry.kind,
                })),
                error: fact.error,
                enabled: true,
            };
            compiled.push({
                task,
                object: fact.error === null ? byName.get(name) ?? null : null,
            });
        });
    });

    return compiled;
}

/**
 * 能力边界(非初等 / 超出规则)的占位条目.
 *
 * 与求解内核同口径:**题目 LaTeX 仍有效**(被积函数已解析成功),列表照常
 * 保留并给理由;`objectId=0` 表示没有下发对象(算不出原函数就没有曲线).
 */
function disabledCompiled(name: string): CompiledAntiderivative {
    return {
        task: {
            name,
            objectId: 0,
            sourceKind: 'curve',
            variable: 'x',
            integrand: '',
            integrandLatex: '',
            antiderivativeText: '',
            antiderivativeLatex: '',
            constant: 0,
            constantSymbol: 'C',
            verified: false,
            steps: [],
            error: null,
            enabled: false,
        },
        object: null,
    };
}
