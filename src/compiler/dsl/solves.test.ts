/**
 * 方程求解编译端到端测试(真实 Rust 解析器 + 真实求解内核,不 mock).
 *
 * 这里锁的是"源码 -> AST -> IR 的 solves"整条链路:
 * - 求解在编译期完成,步骤/解集直接进 IR;
 * - 参数按当前值代入(与积分/分析同一条链路);
 * - 能力边界错误落在 `SolveTask.error`,不打断整份源码编译;
 * - 隐藏项不调用内核,只留占位.
 *
 * 内核自身的数学正确性由 `math_rs` 的 `symbolic::solve::tests` 覆盖.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { SceneIR, SolveTask } from '../../ir';
import { parseMiko } from '../parser';
import { compileScene } from './DslCompiler';
import { testMatrixOps } from '../../test/matrixOps';

async function compile(
    source: string,
    overrides: Record<string, number> = {},
    hiddenSolveNames?: ReadonlySet<string>,
): Promise<SceneIR> {
    const ast = await parseMiko(source);
    return compileScene(ast, overrides, testMatrixOps, { hiddenSolveNames });
}

async function solveTask(
    source: string,
    overrides: Record<string, number> = {},
    hidden?: ReadonlySet<string>,
): Promise<SolveTask> {
    const scene = await compile(source, overrides, hidden);
    expect(scene.solves).toHaveLength(1);
    return scene.solves[0];
}

describe('compileSolves:声明级求解', () => {
    it('因式分解路径:步骤,依据分区与解集都进 IR', async () => {
        const task = await solveTask('solve S = x^2 - 5*x + 6 = 0;');

        expect(task.name).toBe('S');
        expect(task.variable).toBe('x');
        expect(task.enabled).toBe(true);
        expect(task.error).toBeNull();
        expect(task.identity).toBe(false);
        expect(task.realRootCount).toBe(2);
        expect(task.solutionLatex).toContain('x = 2');
        expect(task.solutionLatex).toContain('x = 3');
        expect(task.steps.map((step) => step.reason)).toEqual([
            '原式',
            '因式分解',
            '零积律',
            '移项',
        ]);
        // 依据分区是 UI 配色用的契约,必须原样来自内核.
        expect(task.steps[0].kind).toBe('definition');
        expect(task.steps[2].kind).toBe('rule');
        // 题目 LaTeX 不含外层 `$`.
        expect(task.equationLatex).toContain('x^{2}');
    });

    it('参数按声明值代入;覆盖值改变解集', async () => {
        const declared = await solveTask(
            'param a = 1 in [1, 4, 0.5];\nsolve S = a*x^2 - 4 = 0;',
        );
        expect(declared.solutionLatex).toContain('x = 2');

        const overridden = await solveTask(
            'param a = 1 in [1, 4, 0.5];\nsolve S = a*x^2 - 4 = 0;',
            { a: 2 },
        );
        // 2x^2 - 4 = 0 -> x = ±√2,判别式 32 不是完全平方,走根式路径.
        expect(overridden.solutionLatex).toContain('\\sqrt{32}');
    });

    it('求根公式把系数代进去:步骤里不出现字面 a/b/c', async () => {
        const task = await solveTask(
            'param a = 1 in [1, 4, 0.5];\nsolve S = a*x^2 - 2 = 0;',
            { a: 1 },
        );

        const formulaStep = task.steps.find((step) => step.reason === '求根公式');
        expect(formulaStep?.latex).toBe('x = \\frac{+ 0 \\pm \\sqrt{8}}{2}');
        // 板书要求:公式模板里的字母一律换成当前系数,不能停在 `2a` / `-b`.
        expect(formulaStep?.latex).not.toContain('2a');
        expect(formulaStep?.latex).not.toContain('-b');
    });

    it('variable 选项指定未知量', async () => {
        const task = await solveTask('solve S = t^2 - 9 = 0 { variable = t; };');

        expect(task.variable).toBe('t');
        expect(task.solutionLatex).toContain('t = 3');
    });

    it('能力边界错误落在 error,列表照常保留占位', async () => {
        const cubic = await solveTask('solve S = x^3 - 1 = 0;');
        expect(cubic.enabled).toBe(true);
        expect(cubic.error).toContain('只支持一次/二次');
        expect(cubic.steps).toEqual([]);
        // 方程解析成功过,题目 LaTeX 就该留着:UI 不因为"解不出来"而退回纯文本.
        expect(cubic.equationLatex).toContain('x^{3}');

        const multi = await solveTask('solve S = x + y = 0;');
        expect(multi.error).toContain('多个未知量');
        expect(multi.equationLatex).toContain('x');

        // 显式指定未知量后,剩下的自由符号必须是已声明参数;否则明确报出来,
        // 不静默当成 0.
        const undeclared = await solveTask('solve S = q*x - 6 = 0 { variable = x; };');
        expect(undeclared.error).toContain('未声明参数 q');
    });

    it('隐藏项不调用内核:只留占位与方程原文', async () => {
        const task = await solveTask(
            'solve S = x^2 - 5*x + 6 = 0;',
            {},
            new Set(['S']),
        );

        expect(task.enabled).toBe(false);
        expect(task.equation).toBe('x^2 - 5*x + 6 = 0');
        expect(task.equationLatex).toBe('');
        expect(task.steps).toEqual([]);
        expect(task.error).toBeNull();
    });

    it('同名求解语句重复声明时报错', async () => {
        const ast = await parseMiko(
            'solve S = x^2 - 1 = 0;\nsolve S = x - 1 = 0;\n',
        );

        expect(() => compileScene(ast, {}, testMatrixOps)).toThrow(/求解 S 重复声明/);
    });

    it('未知选项报错', async () => {
        const ast = await parseMiko('solve S = x - 1 = 0 { unknown = 1; };');

        expect(() => compileScene(ast, {}, testMatrixOps)).toThrow(/未知选项/);
    });
});

describe('随仓库分发的求解示例', () => {
    it('example/solve_equations.scad 的四条方程各给出预期结果', async () => {
        const source = await readFile(
            new URL('../../../example/solve_equations.scad', import.meta.url),
            'utf8',
        );
        const scene = await compile(source);
        const byName = new Map(scene.solves.map((task) => [task.name, task]));

        expect([...byName.keys()]).toEqual(['S1', 'S2', 'S3', 'S4']);
        // S1:因式分解板书路径.
        expect(byName.get('S1')?.steps.map((step) => step.reason)).toEqual([
            '原式',
            '因式分解',
            '零积律',
            '移项',
        ]);
        // S2:a=1 时 x^2 - 2 = 0 -> 根式路径.
        expect(byName.get('S2')?.solutionLatex).toContain('\\sqrt{8}');
        // S3:两边都有未知量,移项后解一次方程.
        expect(byName.get('S3')?.solutionLatex).toBe('x = -4');
        // S4:判别式小于 0.
        expect(byName.get('S4')?.solutionLatex).toBeNull();
        expect(byName.get('S4')?.realRootCount).toBe(0);
    });

    it('默认场景里的两条 solve 也产出步骤', async () => {
        const html = await readFile(new URL('../../../index.html', import.meta.url), 'utf8');
        const match = html.match(/<textarea id="dsl-editor"[^>]*>([\s\S]*?)<\/textarea>/);
        expect(match).not.toBeNull();

        const scene = await compile(match![1]);
        expect(scene.solves.map((task) => task.name)).toEqual(['S1', 'S2']);
        for (const task of scene.solves) {
            expect(task.error).toBeNull();
            expect(task.steps.length).toBeGreaterThan(0);
        }
    });
});
