/**
 * 微分方程编译端到端测试(真实 Rust 解析器 + 真实 ODE 内核,不 mock).
 *
 * 锁的是"源码 -> AST -> IR"整条链路(与 `antiderivatives.test.ts` 同骨架):
 * - 通解/特解/步骤链在编译期算完直接进 IR;
 * - **同一条语句既进求值列表,又下发实体对象**:斜率场(`surface`)与解曲线
 *   (`curve`),后者可被下游 `derivative` 引用;
 * - 参数保持符号(曲线跟手,不冻在声明值上);
 * - 能力边界(超出清单/符号系数)落在 `error`,不打断整份源码编译;
 * - 隐藏项只留占位,并滤掉它下发的全部实体.
 *
 * 内核自身的数学正确性(每类方程解的回代验证)由 `math_rs::symbolic::ode::tests`
 * 覆盖;这里只验编译与 IR 契约.
 */
import { describe, expect, it } from 'vitest';
import type { SceneIR } from '../../ir';
import { parseMiko } from '../parser';
import { compileScene } from './DslCompiler';
import { testMatrixOps } from '../../test/matrixOps';

async function compile(
    source: string,
    overrides: Record<string, number> = {},
    hiddenOdeNames?: ReadonlySet<string>,
): Promise<SceneIR> {
    const ast = await parseMiko(source);
    return compileScene(ast, overrides, testMatrixOps, { hiddenOdeNames });
}

const SEPARABLE = "ode O1 = y' = x*y { curves = 3; };";

describe("ode:声明级编译与对象下发", () => {
    it('通解进求值列表,斜率场与解族同时作为实体下发', async () => {
        const scene = await compile(SEPARABLE);

        expect(scene.odes).toHaveLength(1);
        const task = scene.odes[0];
        expect(task.name).toBe('O1');
        expect(task.independent).toBe('x');
        expect(task.dependent).toBe('y');
        expect(task.order).toBe(1);
        expect(task.enabled).toBe(true);
        expect(task.error).toBeNull();
        expect(task.verified).toBe(true);
        expect(task.implicit).toBe(false);
        expect(task.generalLatex).not.toBeNull();
        expect(task.arbitraryConstantCount).toBe(1);
        // 步骤链最后一步是回代验证(展示层据此给凭据).
        expect(task.steps[task.steps.length - 1].kind).toBe('check');

        // 实体侧:斜率场用语句名,解族是 `<名字>_c1..3`.
        const field = scene.objects.find((object) => object.name === 'O1');
        expect(field?.kind).toBe('surface');
        expect(field?.kind === 'surface' ? field.odeOrigin?.role : null).toBe('slope');
        expect(field?.kind === 'surface' ? field.odeOrigin?.statement : null).toBe('O1');
        expect(task.slopeObjectId).toBe(field?.id);
        expect(task.curveNames).toEqual(['O1_c1', 'O1_c2', 'O1_c3']);
        for (const name of task.curveNames) {
            const curve = scene.objects.find((object) => object.name === name);
            expect(curve?.kind).toBe('curve');
            expect(curve?.kind === 'curve' ? curve.odeOrigin?.role : null).toBe('family');
        }
        // 公式层读 odeOrigin:斜率场排成 `y' = ...`,解曲线带常数标注.
        expect(scene.objectFormulas[field!.id]).toContain("y'=");
        const first = scene.objects.find((object) => object.name === 'O1_c1')!;
        expect(scene.objectFormulas[first.id]).toContain('解族');
    });

    it('下游语句可以引用解曲线(与 derivative 同一条 resolvable 链)', async () => {
        const scene = await compile(
            "ode O1 = y' = x*y { curves = 1; };\nderivative back = derivative(O1_c1);",
        );

        const back = scene.objects.find((object) => object.name === 'back');
        expect(back?.kind).toBe('curve');
        expect(back?.kind === 'curve' ? back.expr : '').not.toBe('');
    });

    it('参数保持符号:解式与斜率场里仍是 p/q,实体携带同名系数', async () => {
        const scene = await compile(
            "param p = 2 in [0.5, 3, 0.1];\nparam q = 1 in [0.5, 3, 0.1];\node O2 = y' + p*y = q { curves = 2; };",
        );

        const task = scene.odes[0];
        expect(task.error).toBeNull();
        // 参数只传名字不传值:解式里保留符号,滑块拖动才会跟着变.
        expect(task.generalLatex).not.toBeNull();
        const field = scene.objects.find((object) => object.name === 'O2');
        expect(
            field?.kind === 'surface'
                ? field.coefficients.map((coefficient) => coefficient.name)
                : [],
        ).toEqual(expect.arrayContaining(['p', 'q']));
        const curve = scene.objects.find((object) => object.name === 'O2_c1');
        expect(
            curve?.kind === 'curve'
                ? curve.coefficients.map((coefficient) => coefficient.name)
                : [],
        ).toEqual(expect.arrayContaining(['p', 'q']));
    });

    it('初值把族收成一条特解,且特解实体单独下发', async () => {
        const scene = await compile("ode O4 = y' = x*y, y(0) = 1;");

        const task = scene.odes[0];
        expect(task.initialConditions).toEqual(['y(0) = 1']);
        expect(task.particularLatex).not.toBeNull();
        expect(task.verified).toBe(true);
        const particular = scene.objects.find((object) => object.name === 'O4_p');
        expect(particular?.kind).toBe('curve');
        expect(particular?.kind === 'curve' ? particular.odeOrigin?.role : null).toBe(
            'particular',
        );
        // 初值代入的步骤写在过程链里.
        expect(task.steps.map((step) => step.reason)).toContain('代入初值');
    });

    it('二阶常系数:通解含两个常数,特解由两个初值定出', async () => {
        const scene = await compile(
            "ode O3 = y'' - 3*y' + 2*y = 0, y(0) = 0, y'(0) = 1;",
        );

        const task = scene.odes[0];
        expect(task.order).toBe(2);
        expect(task.arbitraryConstantCount).toBe(2);
        expect(task.verified).toBe(true);
        expect(task.error).toBeNull();
        expect(task.particularLatex).not.toBeNull();
        expect(scene.objects.some((object) => object.name === 'O3_p')).toBe(true);
        // 二阶没有斜率场(方程里没有 y')时不下发 surface.
        expect(scene.objects.some((object) => object.name === 'O3')).toBe(false);
    });

    it('隐式解 + 初值:特解写成关系式,不下发解曲线', async () => {
        const scene = await compile("ode I1 = y' = 1/(y^2+1), y(0) = 1;");

        const task = scene.odes[0];
        expect(task.implicit).toBe(true);
        expect(task.error).toBeNull();
        expect(task.verified).toBe(true);
        expect(task.particularLatex).not.toBeNull();
        // 隐式解的"特解"是 `Φ(x,y) = C0`,排成 `y = C0` 是错的.
        expect(task.particularLatex!.startsWith('y =')).toBe(false);
        expect(task.curveNames).toEqual([]);
        expect(scene.objects.some((object) => object.name === 'I1_p')).toBe(false);
    });

    it('能力边界:超出清单给 error + 题目,斜率场照给但不画解曲线', async () => {
        const scene = await compile("ode O9 = y' = sin(x^2);");

        const task = scene.odes[0];
        expect(task.error).not.toBeNull();
        expect(task.generalLatex).toBeNull();
        expect(task.verified).toBe(false);
        // 题目 LaTeX 仍然有效(方程已解析成功).
        expect(task.equationLatex).not.toBe('');
        // 右端 `f(x,y)` 是方程本身的一部分,解不出来也照下发斜率场:
        // 学生至少能看见"这条方程的斜率长什么样".
        expect(task.slopeObjectId).toBeGreaterThan(0);
        expect(scene.objects.some((object) => object.name === 'O9')).toBe(true);
        expect(task.curveNames).toEqual([]);
    });

    it('隐藏项:只留占位,并滤掉斜率场与解族', async () => {
        const scene = await compile(SEPARABLE, {}, new Set(['O1']));

        const task = scene.odes[0];
        expect(task.enabled).toBe(false);
        expect(task.steps).toHaveLength(0);
        expect(task.generalLatex).toBeNull();
        // 实体侧:斜率场与解曲线都不下发(靠 odeOrigin.statement 认领).
        expect(scene.objects.some((object) => object.name === 'O1')).toBe(false);
        expect(
            scene.objects.some((object) => object.name?.startsWith('O1_c') ?? false),
        ).toBe(false);
    });

    it('range 选项:2 个数只管解曲线,4 个数同时给斜率场域', async () => {
        const curvesOnly = await compile("ode O1 = y' = x*y { curves = 1; range = [-3, 3]; };");
        const curve = curvesOnly.objects.find((object) => object.name === 'O1_c1');
        expect(curve?.kind === 'curve' ? curve.range : null).toEqual([-3, 3]);
        const fieldOnly = curvesOnly.objects.find((object) => object.name === 'O1');
        expect(fieldOnly?.kind === 'surface' ? fieldOnly.range[1] : null).toBe(6);

        const both = await compile(
            "ode O1 = y' = x*y { curves = 1; range = [-2, 2, -4, 4]; };",
        );
        const field = both.objects.find((object) => object.name === 'O1');
        expect(field?.kind === 'surface' ? field.range : null).toEqual([-2, 2, -4, 4]);
    });

    it('自变量推断失败(x 与 t 同时出现)报带语句 span 的错误', async () => {
        await expect(compile("ode O = y' = x*y + t*y;")).rejects.toThrow(
            /同时出现了 x 与 t/,
        );
    });

    it('生成对象重名时报错', async () => {
        await expect(
            compile("curve O1_c1 = x;\node O1 = y' = x*y { curves = 1; };"),
        ).rejects.toThrow(/重复声明/);
    });
});
