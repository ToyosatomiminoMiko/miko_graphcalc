/**
 * 不定积分编译端到端测试(真实 Rust 解析器 + 真实积分内核,不 mock).
 *
 * 锁的是"源码 -> AST -> IR"整条链路:
 * - 原函数在编译期算完,表达式与步骤链直接进 IR;
 * - **同一个原函数同时下发给场景**(`SceneIR.objects` 里多一条同名 curve/surface),
 *   并且可以被后续 `derivative` 引用;
 * - 参数保持符号(曲线跟手)--这是静态场景缓存的正确性要求;
 * - 能力边界(非初等/超出规则)落在 `error`,不打断整份源码编译,也不下发对象;
 * - 隐藏项不调内核,只留占位.
 *
 * 内核自身的数学正确性(每步回代验证)由 `math_rs::symbolic::integral::tests`
 * 覆盖;这里只验编译与 IR 契约.
 */
import { describe, expect, it } from 'vitest';
import type { SceneIR } from '@/contract/ir';
import { parseMiko } from '@/compiler/parser';
import { compileScene } from './DslCompiler';
import { testMatrixOps } from '@/testing/matrixOps';

async function compile(
    source: string,
    overrides: Record<string, number> = {},
    hiddenAntiderivativeNames?: ReadonlySet<string>,
): Promise<SceneIR> {
    const ast = await parseMiko(source);
    return compileScene(ast, overrides, testMatrixOps, { hiddenAntiderivativeNames });
}

const BASIC = 'curve f = x^2 + sin(x) { range = [-4, 4]; };\nantiderivative F = antiderivative(f);';

describe('antiderivative:声明级编译与对象下发', () => {
    it('原函数进求值列表,同时作为实体 curve 下发', async () => {
        const scene = await compile(BASIC);

        expect(scene.antiderivatives).toHaveLength(1);
        const task = scene.antiderivatives[0];
        expect(task.name).toBe('F');
        expect(task.variable).toBe('x');
        expect(task.sourceKind).toBe('curve');
        expect(task.enabled).toBe(true);
        expect(task.error).toBeNull();
        expect(task.verified).toBe(true);
        expect(task.antiderivativeText).not.toBe('');
        // 步骤链最后一步是回代验证(展示层据此给凭据).
        expect(task.steps[task.steps.length - 1].kind).toBe('check');
        expect(task.steps.map((step) => step.reason)).toContain('原式');

        // 实体侧:同名 curve 下发,id 与 task.objectId 一致.
        const objects = scene.objects.filter((object) => object.name === 'F');
        expect(objects).toHaveLength(1);
        const object = objects[0];
        expect(object.kind).toBe('curve');
        expect(object.id).toBe(task.objectId);
        expect(
            object.kind === 'curve' ? object.antiderivativeOrigin?.integrandExpr : null,
        ).toBe('x ^ 2 + sin(x)');
        // 公式层读 antiderivativeOrigin 写成积分式.
        expect(scene.objectFormulas[object.id]).toContain('\\int');
    });

    it('下游语句可以引用原函数(与 derivative 同一条 resolvable 链)', async () => {
        const scene = await compile(
            'curve f = x^2;\nantiderivative F = antiderivative(f);\nderivative back = derivative(F);',
        );

        const back = scene.objects.find((object) => object.name === 'back');
        expect(back?.kind).toBe('curve');
        // F 的原函数是 x^3/3,再求导回到 x^2.
        expect(back?.kind === 'curve' ? back.expr : '').toContain('x ^ 2');
    });

    it('参数保持符号:表达式里仍是 a,定义域继承源对象', async () => {
        const scene = await compile(
            'param a = 2 in [0.5, 3, 0.1];\ncurve f = a*x^2 { range = [-2, 2]; };\nantiderivative F = antiderivative(f);',
        );

        const task = scene.antiderivatives[0];
        expect(task.error).toBeNull();
        expect(task.antiderivativeText).toContain('a');
        const object = scene.objects.find((entry) => entry.name === 'F');
        expect(object?.kind === 'curve' ? object.range : null).toEqual([-2, 2]);
        // 依赖继承源对象的系数,参数变化时这条对象会被重新物化.
        expect(
            object?.kind === 'curve'
                ? object.coefficients.map((coefficient) => coefficient.name)
                : [],
        ).toContain('a');
    });

    it('constant 选项并入下发对象的表达式,展示层保留符号 C', async () => {
        const scene = await compile(
            'curve f = x^2;\nantiderivative F = antiderivative(f) { constant = 3; };',
        );

        const task = scene.antiderivatives[0];
        expect(task.constant).toBe(3);
        const object = scene.objects.find((entry) => entry.name === 'F');
        expect(object?.kind === 'curve' ? object.expr : '').toContain('3');
        expect(
            object?.kind === 'curve' ? object.antiderivativeOrigin?.constant : null,
        ).toBe(3);
    });

    it('能力边界:非初等不给对象,但保留条目与题目', async () => {
        const scene = await compile('curve f = exp(x^2);\nantiderivative F = antiderivative(f);');

        const task = scene.antiderivatives[0];
        expect(task.error).not.toBeNull();
        expect(task.error).toContain('原函数不是初等函数');
        expect(task.antiderivativeText).toBe('');
        // 题目 LaTeX 仍然有效(被积函数已解析成功).
        expect(task.integrandLatex).not.toBe('');
        expect(scene.objects.some((object) => object.name === 'F')).toBe(false);
    });

    it('隐藏项:不下发对象,也不调内核', async () => {
        const scene = await compile('curve f = x^2;\nantiderivative F = antiderivative(f);', {}, new Set(['F']));

        const task = scene.antiderivatives[0];
        expect(task.enabled).toBe(false);
        expect(task.steps).toHaveLength(0);
        expect(task.antiderivativeText).toBe('');
        expect(scene.objects.some((object) => object.name === 'F')).toBe(false);
    });

    it('曲面源可以指定对 y 积分', async () => {
        const scene = await compile(
            'surface s = x*y^2;\nantiderivative G = antiderivative(s, y);',
        );

        const task = scene.antiderivatives[0];
        expect(task.sourceKind).toBe('surface');
        expect(task.variable).toBe('y');
        expect(task.error).toBeNull();
        const object = scene.objects.find((entry) => entry.name === 'G');
        expect(object?.kind).toBe('surface');
        expect(
            object?.kind === 'surface' ? object.antiderivativeOrigin?.variable : null,
        ).toBe('y');
    });

    it('引用不存在的对象:带语句 span 的错误', async () => {
        await expect(compile('antiderivative F = antiderivative(nope);')).rejects.toThrow(
            /引用了不存在的对象/,
        );
    });

    it('curve 源只支持对 x 积分', async () => {
        await expect(
            compile('curve f = x;\nantiderivative F = antiderivative(f, y);'),
        ).rejects.toThrow(/只支持对 x 积分/);
    });
});
