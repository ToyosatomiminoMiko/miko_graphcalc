/**
 * 约束语句编译骨架(求解 / 求交 / 后续联立共用).
 *
 * 三条链路的"外壳"完全同形,过去在 `solves.ts` 与 `intersections.ts` 各写一遍
 * (新增一类约束就再抄一遍,容易漂移).这里把外壳收成一处:
 * 1. 按语句类型筛选;
 * 2. 语句名查重("重复声明"契约与 param/object/animation 一致);
 * 3. 选项白名单校验(`assertKnownOptions`);
 * 4. 语句级错误定位(`withStatementSpan`,应用层据此换算源码行列);
 * 5. hidden 只作为**结论**传进 body:完整校验必须已经在 body 里做完(约定 1
 *    "先完整校验,后禁用,仅跳过计算"),body 只决定"是否跳过计算".
 *
 * 这里**不做**任何具体校验与计算:那些是各链路自己的事(求交要查对象存在,
 * 种类支持与静态变换可逆;求解要组系数并调内核).本模块只保证"外壳"一致,
 * 不碰数学语义.
 */
import type {
    AstProgram,
    AstStatement,
    OptionPair,
    SourceSpan,
} from '../../contract/ast';
import { withStatementSpan } from '../errors';
import { assertKnownOptions } from './options';

/**
 * 约束语句的最小形状:三种约束语句都有 `name` / `options` / `span`.
 *
 * 用结构类型而不是联合类型:调用方给具体的语句类型参数 `TStatement`,这里
 * 只约束"外壳"用得到的字段.
 */
interface ConstraintStatement {
    readonly name: string;
    readonly options: OptionPair[];
    readonly span: SourceSpan;
}

/**
 * 编译一类约束语句.
 *
 * @param ast 整个程序;只挑 `isKind` 认下的语句,其余原样跳过.
 * @param isKind 语句类型判别(如 `s.type === 'solve'`);写成类型谓词,
 *   调用方拿到的 `compileBody` 参数就是具体语句类型,不必再断言.
 * @param label 错误文案里的类别名(`'求解'` / `'求交'`),决定
 *   "`求解 X 重复声明`" 与 "`求解 X 包含未知选项`" 的措辞.
 * @param optionNames 该类语句允许的选项白名单.
 * @param hiddenNames 隐藏集合;命中的语句以 `hidden = true` 传进 body.
 * @param compileBody 单条语句的完整编译;`index` 是该类语句里的序号
 *   (从 0 起,用于配色这类与语句顺序相关的默认值).
 */
export function compileConstraintStatements<
    TStatement extends ConstraintStatement & AstStatement,
    TTask,
>(
    ast: AstProgram,
    isKind: (statement: AstStatement) => statement is TStatement,
    label: string,
    optionNames: readonly string[],
    hiddenNames: ReadonlySet<string>,
    compileBody: (statement: TStatement, hidden: boolean, index: number) => TTask,
): TTask[] {
    const tasks: TTask[] = [];
    const seen = new Set<string>();
    let index = 0;

    for (const statement of ast.statements) {
        if (!isKind(statement)) continue;
        // 语句级错误定位:单条语句编译抛错时携带本语句 span.
        withStatementSpan(statement.span, () => {
            if (seen.has(statement.name)) {
                throw new Error(`${label} ${statement.name} 重复声明`);
            }
            seen.add(statement.name);
            assertKnownOptions(statement.options, optionNames, `${label} ${statement.name}`);
            tasks.push(compileBody(statement, hiddenNames.has(statement.name), index));
        });
        index += 1;
    }

    return tasks;
}
