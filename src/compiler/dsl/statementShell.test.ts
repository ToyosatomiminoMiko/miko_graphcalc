/**
 * 约束语句共用外壳(`compileConstraintStatements`)的契约测试.
 *
 * 求解与求交的端到端用例已经间接覆盖了查重/选项/hidden,这里直接锁"外壳"
 * 本身的三条契约,避免以后加第三类约束语句时两条链路悄悄漂移:
 * - 只挑匹配的语句,`index` 只数匹配到的语句(配色默认值依赖它);
 * - 查重与选项校验的文案由统一 `label` 拼出;
 * - body 抛出的普通错误升级为携带**该语句 span** 的 `CompileError`.
 */
import { describe, expect, it } from 'vitest';
import type { SolveStatement } from '../../contract/ast';
import { CompileError } from '../errors';
import { parseMiko } from '../parser';
import { compileConstraintStatements } from './statementShell';

const isSolve = (statement: { type: string }): statement is SolveStatement =>
    statement.type === 'solve';

describe('compileConstraintStatements:约束语句共用外壳', () => {
    it('只挑匹配语句,并把 hidden 与匹配序号交给 body', async () => {
        const ast = await parseMiko(
            'param a = 1;\nsolve A = a*x - 1 = 0;\nparam b = 2;\nsolve B = b*x - 2 = 0;\n',
        );
        const calls: Array<{ name: string; hidden: boolean; index: number }> = [];

        const tasks = compileConstraintStatements(
            ast,
            isSolve,
            '求解',
            ['variable'],
            new Set(['B']),
            (statement, hidden, index) => {
                calls.push({ name: statement.name, hidden, index });
                return statement.name;
            },
        );

        expect(tasks).toEqual(['A', 'B']);
        // param 语句不参与计数,所以 B 的序号是 1 而不是 3.
        expect(calls).toEqual([
            { name: 'A', hidden: false, index: 0 },
            { name: 'B', hidden: true, index: 1 },
        ]);
    });

    it('查重与选项校验的文案由统一 label 拼出', async () => {
        const duplicate = await parseMiko(
            'solve A = x - 1 = 0;\nsolve A = x - 2 = 0;\n',
        );
        expect(() =>
            compileConstraintStatements(
                duplicate,
                isSolve,
                '求解',
                ['variable'],
                new Set(),
                () => 0,
            ),
        ).toThrow(/求解 A 重复声明/);

        const unknownOption = await parseMiko('solve A = x - 1 = 0 { nope = 1; };');
        expect(() =>
            compileConstraintStatements(
                unknownOption,
                isSolve,
                '求解',
                ['variable'],
                new Set(),
                () => 0,
            ),
        ).toThrow(/求解 A 包含未知选项: nope/);
    });

    it('body 抛出的错误带上该语句的 span', async () => {
        const ast = await parseMiko('param a = 1;\nsolve A = a*x - 1 = 0;\n');
        const solveStatement = ast.statements.find(isSolve);
        expect(solveStatement).toBeDefined();

        let caught: unknown;
        try {
            compileConstraintStatements(
                ast,
                isSolve,
                '求解',
                ['variable'],
                new Set(),
                () => {
                    throw new Error('内核拒绝');
                },
            );
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(CompileError);
        expect((caught as CompileError).message).toBe('内核拒绝');
        expect((caught as CompileError).span).toEqual(solveStatement!.span);
    });
});
