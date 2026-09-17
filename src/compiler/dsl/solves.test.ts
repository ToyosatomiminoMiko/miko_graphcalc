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
import type { SceneIR, SolveTask } from '../../contract/ir';
import { parseMiko } from '../parser';
import { compileScene } from './DslCompiler';
import { testMatrixOps } from '../../testing/matrixOps';

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
        // 统一词汇:求解恒为精确后端,未知量以列表形式给出(为联立留的接口).
        expect(task.method).toBe('exact');
        expect(task.unknowns).toEqual(['x']);
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

    it('系数是参数时紧跟"参数取值"一步:方程 + a=1 叠成两行', async () => {
        const task = await solveTask(
            'param a = 1 in [1, 4, 0.5];\nsolve S = a*x^2 - 2 = 0;',
            { a: 2 },
        );

        // 原式之后就是取值:读者先看到"哪个方程,哪些系数",再看到数.
        expect(task.steps[0].reason).toBe('原式');
        expect(task.steps[1].reason).toBe('参数取值');
        expect(task.steps[1].kind).toBe('numeric');
        expect(task.steps[1].latex).toBe(
            '\\begin{gathered} a\\,x^{2} - 2=0 \\\\ a=2 \\end{gathered}',
        );
        // 方程本身保留符号写法,不把 a 直接换成 2.
        expect(task.steps[0].latex).toContain('a\\,x^{2}');

        // 覆盖值一路带到公式:2x^2 - 2 = 0 -> Δ = 0² - 4·2·(-2) = 16(完全平方),
        // 分母是 2a = 4,根号按精确值给.
        const formulaStep = task.steps.find((step) => step.reason === '求根公式');
        expect(formulaStep?.latex).toBe('x = \\frac{+ 0 \\pm \\sqrt{4}}{4}');
    });

    it('variable 选项指定未知量', async () => {
        const task = await solveTask('solve S = t^2 - 9 = 0 { variable = t; };');

        expect(task.variable).toBe('t');
        expect(task.unknowns).toEqual(['t']);
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
        expect(task.method).toBe('exact');
        // 没调用内核就没有未知量可报.
        expect(task.unknowns).toEqual([]);
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

describe('compileSolves:联立方程组(v1)', () => {
    it('线性方程组:精确消元,未知量与解集都进 IR', async () => {
        const task = await solveTask('solve S = { x + y = 3; x - y = 1; };');

        expect(task.method).toBe('exact');
        expect(task.unknowns).toEqual(['x', 'y']);
        expect(task.equations).toEqual(['x + y = 3', 'x - y = 1']);
        // `equation` / `variable` 是展示用的连接文案,结构化数据在 equations/unknowns.
        expect(task.equation).toBe('x + y = 3; x - y = 1');
        expect(task.variable).toBe('x, y');
        expect(task.solutionLatex).toBe('x = 2,\\quad y = 1');
        expect(task.realRootCount).toBe(1);
        expect(task.error).toBeNull();
        expect(task.steps.map((step) => step.reason)).toEqual([
            '原式',
            '移项,合并同类项',
            '加减消元',
            '回代求解',
        ]);
        expect(task.equationLatex).toContain('\\begin{cases}');
    });

    it('variables 选项显式指定未知量;未声明符号仍报能力边界', async () => {
        const task = await solveTask(
            'solve S = { a*x + y = 1; x - y = 0; } { variables = x, y; };',
        );

        // `a` 既不是未知量也不是已声明参数:明确报出来,不能静默当成 0.
        expect(task.error).toContain('未声明参数 a');
    });

    it('非线性方程组落到数值路径,过程里如实标注搜索区间与"数值解"', async () => {
        const task = await solveTask(
            'solve S = { x^2 + y^2 = 1; x - y = 0; } { range = [-2, 2]; segments = 24; };',
        );

        expect(task.method).toBe('numeric');
        expect(task.realRootCount).toBe(2);
        expect(task.error).toBeNull();
        expect(task.solutionLatex).toContain('\\approx');
        const reasons = task.steps.map((step) => step.reason);
        expect(reasons).toContain('数值搜索区间');
        expect(reasons).toContain('数值解');
    });

    it('超定方程组是能力边界:列表保留占位,题目 LaTeX 照给', async () => {
        const task = await solveTask('solve S = { x + y = 1; x - y = 0; x = 1; };');

        expect(task.enabled).toBe(true);
        expect(task.error).toContain('多于未知量数');
        expect(task.solutionLatex).toBeNull();
        expect(task.equationLatex).toContain('\\begin{cases}');
    });

    it('隐藏的联立方程组不调用内核:方法取 auto,方程原文保留', async () => {
        const task = await solveTask(
            'solve S = { x + y = 3; x - y = 1; };',
            {},
            new Set(['S']),
        );

        expect(task.enabled).toBe(false);
        expect(task.method).toBe('auto');
        expect(task.equations).toEqual(['x + y = 3', 'x - y = 1']);
        expect(task.unknowns).toEqual([]);
        expect(task.equationLatex).toBe('');
        expect(task.steps).toEqual([]);
    });

    it('range/segments 只对联立有意义;单方程不接受多变量', async () => {
        await expect(
            compile('solve S = x - 1 = 0 { range = [-2, 2]; };'),
        ).rejects.toThrow(/只对联立方程组有意义/);
        await expect(
            compile('solve S = x - 1 = 0 { variables = x, y; };'),
        ).rejects.toThrow(/只有一个方程/);
    });
});

describe('随仓库分发的求解示例', () => {
    it('example/solve_equations.miko 的四条方程各给出预期结果', async () => {
        const source = await readFile(
            new URL('../../../example/solve_equations.miko', import.meta.url),
            'utf8',
        );
        const scene = await compile(source);
        const byName = new Map(scene.solves.map((task) => [task.name, task]));

        expect([...byName.keys()]).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
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
        // S5:联立线性方程组 -> 精确消元.
        expect(byName.get('S5')?.method).toBe('exact');
        expect(byName.get('S5')?.unknowns).toEqual(['x', 'y']);
        expect(byName.get('S5')?.solutionLatex).toBe('x = 2,\\quad y = 1');
        // S6:联立非线性方程组 -> 数值路径.
        expect(byName.get('S6')?.method).toBe('numeric');
        expect(byName.get('S6')?.realRootCount).toBe(2);
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
