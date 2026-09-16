/**
 * 真实 Rust/WASM 解析器对**方程求解语句**的语法契约测试.
 *
 * 与 `parserAnalysis.test.ts` 同一理由:`solve_stmt` 的形态(方程整段由 `expr`
 * 捕获,顶层等号原样保留,选项块可选)由 `miko.pest` 决定,mock 掉 wasm 就测
 * 不到.求解内核的数学语义由 `dsl/solves.test.ts` 覆盖.
 */
import { describe, expect, it } from 'vitest';
import { parseMiko } from '../parser';
import type { SolveStatement } from '../../contract/ast';

function findSolve(program: Awaited<ReturnType<typeof parseMiko>>): SolveStatement | undefined {
    return program.statements.find(
        (statement): statement is SolveStatement => statement.type === 'solve',
    );
}

describe('parseMiko 方程求解语句', () => {
    it('接受 `solve 名称 = 方程;`,方程整段(含顶层等号)原样进入 AST', async () => {
        const program = await parseMiko('solve S = x^2 - 5*x + 6 = 0;');

        const statement = findSolve(program);
        expect(statement).toMatchObject({
            type: 'solve',
            name: 'S',
            equation: 'x^2 - 5*x + 6 = 0',
            options: [],
        });
        expect(statement?.span.end).toBeGreaterThan(statement?.span.start ?? -1);
    });

    it('接受选项块里的 variable', async () => {
        const program = await parseMiko(
            'param a = 1 in [-5, 5, 0.1];\n'
            + 'solve S = a*x + 3 = 0 { variable = x; };\n',
        );

        expect(findSolve(program)?.options).toEqual([{ name: 'variable', value: 'x' }]);
    });

    it('与其它语句混排时顺序与类型都正确', async () => {
        const program = await parseMiko(
            'param a = 1;\n'
            + 'curve c = a*x;\n'
            + 'solve S = x^2 - a = 0;\n'
            + 'solve T = x^2 - 1 = 0;\n',
        );

        expect(program.statements.map((statement) => statement.type)).toEqual([
            'param',
            'object',
            'solve',
            'solve',
        ]);
        expect(findSolve(program)?.name).toBe('S');
        expect(program.statements.filter((statement) => statement.type === 'solve')).toHaveLength(2);
    });

    it('方程里出现多个等号时语法仍接受(由内核报"多个等号")', async () => {
        const program = await parseMiko('solve S = x = y = 0;');

        expect(findSolve(program)?.equation).toBe('x = y = 0');
    });
});
