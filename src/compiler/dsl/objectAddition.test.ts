/**
 * 对象相加(curve/surface 表达式按名引用同类对象)的真实链路集成测试.
 *
 * 为什么单独一个文件:DslCompiler.test.ts 用 vi.mock 把 wasm 换成假实现,
 * 而"引用必须在归一化之前展开"正是本功能的核心--只有走真实 Rust 解析器 +
 * 真实符号引擎,才能验证 `curve c3 = c1 + c2` 里的 c1/c2 没有被当成自由
 * 参数(凭空多出两个滑块),而是被展开成两个函数表达式之和.解析器本身不改
 * 语法(`expr` 照旧吃到分号),所以这里同时守住"DSL 源码 -> AST -> SceneIR"
 * 这条完整路径.
 */
import { describe, expect, it } from 'vitest';
import { parseMiko } from '../parser';
import { compileScene } from './DslCompiler';
import { testMatrixOps } from '../../testing/matrixOps';
import type { CurveObject, SurfaceObject } from '../../contract/ir';

async function compile(source: string) {
    return compileScene(await parseMiko(source), {}, testMatrixOps);
}

function curveOf(objects: readonly { kind: string; name?: string }[], name: string): CurveObject {
    const object = objects.find((item) => item.name === name);
    expect(object?.kind).toBe('curve');
    return object as CurveObject;
}

function surfaceOf(objects: readonly { kind: string; name?: string }[], name: string): SurfaceObject {
    const object = objects.find((item) => item.name === name);
    expect(object?.kind).toBe('surface');
    return object as SurfaceObject;
}

describe('对象相加:curve + curve', () => {
    it('把引用展开成表达式之和,区间取交集,且不产生同名滑块', async () => {
        const scene = await compile(`
param a = 1 in [-5, 5, 0.1];
curve c1 = sin(x * a) {
    range = [-8, 8];
}
curve c2 = cos(x) {
    range = [-4, 4];
}
curve c3 = c1 + c2;
`);

        expect(scene.objects).toHaveLength(3);
        const c3 = curveOf(scene.objects, 'c3');
        expect(c3.expr).toBe('sin(x * a) + cos(x)');
        // 定义域是两条曲线 x 区间的交集,不是各自的默认区间.
        expect(c3.range).toEqual([-4, 4]);
        // 系数来自展开后的表达式;a 之外的 c1/c2 不能变成参数.
        expect(scene.params.map((param) => param.name)).toEqual(['a']);
        expect(c3.coefficients.map((coefficient) => coefficient.name)).toEqual(['a']);
    });

    it('支持前向引用与链式相加,运算顺序与声明顺序无关', async () => {
        const scene = await compile(`
curve c4 = c3 * 2 {
    range = [-1, 1];
}
curve c3 = c1 + c2;
curve c1 = sin(x);
curve c2 = x;
`);
        const c4 = curveOf(scene.objects, 'c4');
        expect(c4.expr).toBe('(sin(x) + x) * 2');
        expect(c4.range).toEqual([-1, 1]);
        // 链式相加里的 c1/c2/c3 都不是参数.
        expect(scene.params).toEqual([]);
    });

    it('显式 range 优先于引用交集', async () => {
        const scene = await compile(`
curve c1 = sin(x) {
    range = [-8, 8];
}
curve c2 = cos(x) {
    range = [-4, 4];
}
curve c3 = c1 + c2 {
    range = [-2, 2];
}
`);
        expect(curveOf(scene.objects, 'c3').range).toEqual([-2, 2]);
    });

    it('候选引用名取自符号引擎的自由符号:内置函数名不被劫持', async () => {
        // 对象名与内置函数同名时,只有"当值用"的那个位置是引用,
        // cos(x) 仍是余弦(紧跟 `(` 的位置由符号引擎认成函数调用).
        const scene = await compile(`
curve cos = 1;
curve c = cos(x) + cos;
`);
        expect(curveOf(scene.objects, 'c').expr).toBe('cos(x) + 1');
    });

    it('引用可以层层嵌套(引用链上每一层都展开)', async () => {
        const scene = await compile(`
curve c1 = x;
curve c2 = c1 + 1;
curve c3 = c2 * 2;
`);
        expect(curveOf(scene.objects, 'c3').expr).toBe('(x + 1) * 2');
    });

    it('region 的边界可以是相加得到的曲线,区间与系数同源', async () => {
        const scene = await compile(`
param a = 1 in [-5, 5, 0.1];
param b = 1 in [-5, 5, 0.1];
curve c1 = sin(x * a) {
    range = [-8, 8];
}
curve c2 = cos(x * b) {
    range = [-4, 4];
}
curve c3 = c1 + c2;
region R = region(c3, c1) {
    color = "#6bffb8";
}
`);
        const region = scene.objects.find((object) => object.kind === 'region');
        expect(region?.kind).toBe('region');
        if (region?.kind !== 'region') return;
        // c3 的有效区间是 [-4, 4],与 c1 的 [-8, 8] 再取交集.
        expect(region.range).toEqual([-4, 4]);
        expect(region.coefficients.map((coefficient) => coefficient.name).sort())
            .toEqual(['a', 'b']);
        // 边界公式用的是展开后的 c3,而不是看不出内容的 "c3".
        expect(scene.objectFormulas[region.id]).toContain('\\cos');
    });

    it('求导可以作用在相加得到的曲线上', async () => {
        const scene = await compile(`
curve c1 = sin(x);
curve c2 = cos(x);
curve c3 = c1 + c2;
derivative d = derivative(c3);
`);
        const derivative = curveOf(scene.objects, 'd');
        expect(derivative.derivativeOrigin?.sourceExpr).toBe('sin(x) + cos(x)');
    });
});

describe('对象相加:surface + surface', () => {
    it('x/y 矩形分别取交集', async () => {
        const scene = await compile(`
surface s1 = sin(x) * cos(y) {
    range = [-6, 6, -6, 6];
}
surface s2 = x * y {
    range = [-2, 2, -3, 3];
}
surface s3 = s1 + s2;
`);
        const s3 = surfaceOf(scene.objects, 's3');
        expect(s3.expr).toBe('sin(x) * cos(y) + x * y');
        expect(s3.range).toEqual([-2, 2, -3, 3]);
        expect(scene.params).toEqual([]);
    });
});

describe('对象相加:错误', () => {
    it('拒绝不同维度对象相加', async () => {
        await expect(compile(`
curve c1 = sin(x);
surface s1 = x * y;
curve c3 = c1 + s1;
`)).rejects.toThrow('曲线 c3 不能引用曲面 s1:对象相加要求同为曲线');
    });

    it('拒绝引用非 curve/surface 的已声明名字', async () => {
        await expect(compile(`
curve c1 = sin(x);
sphere S = [0, 0, 0] { radius = 1; }
curve c3 = c1 + S;
`)).rejects.toThrow('曲线 c3 引用了 S(sphere 对象):对象相加只能引用已声明的 curve/surface 对象');
    });

    it('拒绝引用 derivative 产物(它不是对象声明)', async () => {
        await expect(compile(`
curve c1 = sin(x);
derivative d1 = derivative(c1);
curve c3 = c1 + d1;
`)).rejects.toThrow('曲线 c3 引用了 d1(derivative 产物)');
    });

    it('检测循环引用而不是无限递归', async () => {
        await expect(compile(`
curve a = b + 1;
curve b = a + 1;
`)).rejects.toThrow('循环引用');
    });

    it('区间交集为空时报错', async () => {
        await expect(compile(`
curve c1 = sin(x) {
    range = [-8, -4];
}
curve c2 = cos(x) {
    range = [4, 8];
}
curve c3 = c1 + c2;
`)).rejects.toThrow('曲线 c3 引用的对象 x 区间没有交集');
    });

    it('拒绝同名参数与对象产生的歧义引用', async () => {
        await expect(compile(`
param c1 = 2;
curve c1 = sin(x);
curve c3 = c1 * x;
`)).rejects.toThrow('引用有歧义');
    });
});
