import { describe, expect, it, vi } from 'vitest';
import { compileScene as compileSceneWithOps } from './DslCompiler';
import type { CompileSceneOptions } from './DslCompiler';
import { jsMatrixOps } from '../../math/tensor/testMatrixOps';
import {
    evaluate_curl_point,
    evaluate_divergence_point,
    evaluate_gradient_point,
    evaluate_scalar,
    symbolic_derivative,
} from '../../wasm/math_rs/math_rs';
import type { AstProgram } from '../ast/types';
import { normalizeExpression } from './expression';
import { CompileError, formatLocatedError } from '../errors';

vi.mock('../../wasm/math_rs/math_rs', () => ({
    evaluate_gradient_point: vi.fn(() => ({ f0: 0, fx: 0, fy: 0 })),
    evaluate_divergence_point: vi.fn(() => 0),
    evaluate_curl_point: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
    normalize_expression: vi.fn((expr: string) => {
        switch (expr) {
            case 'sin(x*a)':
                return 'sin(x * a)';
            case 'sin(x)*cos(y)':
                return 'sin(x) * cos(y)';
            case 'log(x)':
                return 'ln(x)';
            default:
                return expr;
        }
    }),
    latex_expression: vi.fn((expr: string) => expr),
    symbolic_derivative: vi.fn((expr: string, variable: string) => {
        switch (expr) {
            case 'sin(x * a)':
                return variable === 'x' ? 'a * cos(x * a)' : '0';
            case 'sin(x) * cos(y)':
                // 曲面是 f(x,y):对 z 求偏导恒为 0(真实 Rust 引擎同样返回 0).
                if (variable === 'x') return 'cos(y) * cos(x)';
                if (variable === 'y') return '-(sin(x) * sin(y))';
                return '0';
            case '-x':
                return variable === 'x' ? '-1' : '0';
            case 'y':
                return variable === 'y' ? '1' : '0';
            case '0':
                return '0';
            // 隐式场测试用表达式:只登记测试真正用到的偏导,保持 mock 简单.
            case 'x^2 + y^2 - 1':
                return variable === 'x' ? '2 * x' : variable === 'y' ? '2 * y' : '0';
            case 'x^2 + y^2 + z^2 - 4':
                return variable === 'x'
                    ? '2 * x'
                    : variable === 'y'
                        ? '2 * y'
                        : '2 * z';
            default:
                return '1';
        }
    }),
    symbolic_variables: vi.fn((expr: string, exclude: string[]) => {
        const excluded = new Set(exclude);
        return expr
            .split(/[^A-Za-z_]/)
            .filter((name) => name && !excluded.has(name) && !['sin', 'cos'].includes(name));
    }),
    parse_array_strings: vi.fn((expr: string) => {
        switch (expr) {
            case '[y, -x, 0]':
                return '["y", "-x", "0"]';
            case '[sin(x*a), 0, 0]':
                return '["sin(x*a)", "0", "0"]';
            case '[a, 1, 0]':
                return '["a", "1", "0"]';
            case '[[1, 2, 3], [a, 0, 1]]':
                return '[["1", "2", "3"], ["a", "0", "1"]]';
            case '[0, a, 0]':
                return '["0", "a", "0"]';
            case '[0, 1, 0]':
                return '["0", "1", "0"]';
            case '[1, 2, 3]':
                return '["1", "2", "3"]';
            case '[0, 0, 0]':
                return '["0", "0", "0"]';
            case '[0, 0, 1]':
                return '["0", "0", "1"]';
            case '[0, 0, -1]':
                return '["0", "0", "-1"]';
            case '[2, 1, 1]':
                return '["2", "1", "1"]';
            case '[1, 1, 1]':
                return '["1", "1", "1"]';
            // 隐式场求导生成的 ∇f 分量(球体走解析式,implicit 走符号求导).
            case '[2 * x, 2 * y, 2 * z]':
                return '["2 * x", "2 * y", "2 * z"]';
            case '[2 * x, 2 * y, 0]':
                return '["2 * x", "2 * y", "0"]';
            case '[2 * (x - (0)), 2 * (y - (0)), 2 * (z - (0))]':
                return '["2 * (x - (0))", "2 * (y - (0))", "2 * (z - (0))"]';
            default:
                return '[]';
        }
    }),
    matrix4_from_expr: vi.fn(() => [1, 0, 0, 2, 0, 1, 0, 3, 0, 0, 1, 4, 0, 0, 0, 1]),
    evaluate_scalar: vi.fn((
        expr: string,
        names: string[],
        values: Float64Array,
        x: number,
        y: number,
        z: number,
    ) => {
        // 坐标参与隐式场 f/∇f 的求值,必须真的绑定 x/y/z;参数/选项求值时
        // 调用方传 NaN,表达式不引用坐标,结果不变.
        const scope: Record<string, number> = { x, y, z };
        names.forEach((name, index) => {
            scope[name] = values[index];
        });
        scope.pi = Math.PI;
        scope.e = Math.E;
        // DSL 的幂是 `^`(Rust 符号引擎语义),JS 的 `^` 是按位异或;mock 里
        // 先换成 `**`,否则隐式场的 x^2 会算成 x XOR 2.
        const jsExpr = expr.replace(/\^/g, '**');
        const fn = new Function(
            ...Object.keys(scope),
            `return (${jsExpr});`,
        );
        return fn(...Object.values(scope));
    }),
}));

const ast: AstProgram = {
    statements: [
        {
            type: 'param',
            name: 'a',
            value: '2',
            ui: { min: '-5', max: '5', step: '0.1' },
            span: { start: 0, end: 0 },
        },
        {
            type: 'param',
            name: 'b',
            value: '1',
            ui: { min: '-3', max: '3', step: '0.1' },
            span: { start: 0, end: 0 },
        },
        {
            type: 'object',
            kind: 'curve',
            name: 'c',
            expr: 'sin(x*a)',
            options: [
                { name: 'range', value: '[-8, 8]' },
                { name: 'segments', value: '128' },
            ],
            span: { start: 0, end: 0 },
        },
        {
            type: 'object',
            kind: 'surface',
            name: 's',
            expr: 'sin(x)*cos(y)',
            options: [{ name: 'range', value: '[-6, 6, -6, 6]' }],
            span: { start: 0, end: 0 },
        },
        {
            type: 'object',
            kind: 'vector_field',
            name: 'F',
            expr: '[y, -x, 0]',
            options: [{ name: 'grid', value: '[8, 8, 8]' }],
            span: { start: 0, end: 0 },
        },
        {
            type: 'analysis',
            op: 'gradient',
            name: 'g',
            call: 'grad',
            source: 'c',
            at: ['a', 'b + 1'],
            options: [{ name: 'show', value: '[point, normal, tangent_plane]' }],
            span: { start: 0, end: 0 },
        },
        {
            type: 'integral',
            name: 'I',
            source: 'c',
            options: [
                { name: 'method', value: 'riemann' },
                { name: 'range', value: '[-4, 4]' },
                { name: 'segments', value: '32' },
            ],
            span: { start: 0, end: 0 },
        },
    ],
};

function compileScene(
    programAst: AstProgram,
    paramOverrides: Record<string, number> = {},
    options: CompileSceneOptions = {},
) {
    return compileSceneWithOps(programAst, paramOverrides, jsMatrixOps, options);
}

it('normalizes log() to the Rust ln() symbol', () => {
    expect(normalizeExpression('log(x)')).toBe('ln(x)');
});

describe('compileScene', () => {
    it('compiles core DSL objects and integral state', () => {
        vi.mocked(evaluate_gradient_point).mockReturnValueOnce({
            f0: 3,
            fx: 2,
            fy: 7,
            free: () => {},
            [Symbol.dispose]: () => {},
        });
        const scene = compileScene(ast);

        expect(scene.params).toHaveLength(2);
        expect(scene.objects).toHaveLength(3);
        expect(scene.objects[0].kind).toBe('curve');
        expect(scene.objects[1].kind).toBe('surface');
        expect(scene.objects[2].kind).toBe('vector_field');
        expect(scene.analyses).toHaveLength(1);
        expect(scene.analyses[0].point[0]).toBe(2);
        expect(scene.analyses[0].point[1]).toBeCloseTo(3);
        expect(scene.analyses[0].point[2]).toBe(0);
        expect(scene.analyses[0].vector[0]).toBeCloseTo(-2 / Math.sqrt(5));
        expect(scene.analyses[0].vector[1]).toBeCloseTo(1 / Math.sqrt(5));
        expect(scene.analyses[0].vector[2]).toBe(0);
        expect(scene.analyses[0].tangent).toEqual([1, 2, 0]);
        expect(scene.analyses[0].show).toContain('tangent_plane');
        const gradientPayload = JSON.parse(
            String(vi.mocked(evaluate_gradient_point).mock.calls[vi.mocked(evaluate_gradient_point).mock.calls.length - 1][0]),
        ) as Record<string, unknown>;
        expect(gradientPayload).toMatchObject({
            surface_expr: 'sin(x * a)',
            fx_expr: 'a * cos(x * a)',
            fy_expr: '0',
            coeff_names: ['a'],
            x: 2,
            y: 0,
        });
        expect(scene.integrals).toHaveLength(1);
        expect(scene.integrals[0].method).toBe('riemann:left');
        expect(scene.integrals[0].sourceKind).toBe('curve');
        expect(scene.integrals[0].segments).toBe(32);
        expect(scene.integrals[0].countCoefficients).toEqual([]);
        expect(scene.objectFormulas[1]).toBe('y=sin(x * a)');
        expect(scene.objectFormulas[2]).toBe('z=sin(x) * cos(y)');
        expect(scene.objectFormulas[3]).toContain('\\mathbf{F}');
        expect(scene.integralFormulas.I).toContain('\\int');
    });

    it('defaults univariate curve gradients to also show the tangent line', () => {
        vi.mocked(evaluate_gradient_point).mockReturnValueOnce({
            f0: 0.5,
            fx: 3,
            fy: 0,
            free: () => {},
            [Symbol.dispose]: () => {},
        });
        const curveGradientAst: AstProgram = {
            statements: [
                ast.statements[2],
                {
                    type: 'analysis',
                    op: 'gradient',
                    name: 'gt',
                    call: 'grad',
                    source: 'c',
                    at: ['a'],
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(curveGradientAst);

        // 一元求导默认画切线:方向 = (1, f'(x), 0),未归一化,不随 show 缺失丢失.
        expect(scene.analyses[0].show).toEqual(['point', 'normal', 'tangent']);
        expect(scene.analyses[0].tangent).toEqual([1, 3, 0]);
    });

    it('respects an explicit show list for curve gradients (tangent opt-in)', () => {
        vi.mocked(evaluate_gradient_point).mockReturnValueOnce({
            f0: 0.5,
            fx: 3,
            fy: 0,
            free: () => {},
            [Symbol.dispose]: () => {},
        });
        const curveGradientAst: AstProgram = {
            statements: [
                ast.statements[2],
                {
                    type: 'analysis',
                    op: 'gradient',
                    name: 'gt',
                    call: 'grad',
                    source: 'c',
                    at: ['a'],
                    options: [{ name: 'show', value: '[point, normal]' }],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(curveGradientAst);

        expect(scene.analyses[0].show).toEqual(['point', 'normal']);
        // 切向仍随导数计算出来,只是 show 里没有 tangent 时不绘制.
        expect(scene.analyses[0].tangent).toEqual([1, 3, 0]);
    });

    it('accepts tangent in explicit show lists for curve gradients', () => {
        const curveGradientAst: AstProgram = {
            statements: [
                ast.statements[2],
                {
                    type: 'analysis',
                    op: 'gradient',
                    name: 'gt',
                    call: 'grad',
                    source: 'c',
                    at: ['a'],
                    options: [{ name: 'show', value: '[point, normal, tangent]' }],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(curveGradientAst);

        expect(scene.analyses[0].show).toEqual(['point', 'normal', 'tangent']);
    });

    it('normalizes bare riemann to left and accepts right/mid variants', () => {
        const variants: Array<[string, string]> = [
            ['riemann:right', 'riemann:right'],
            ['riemann:mid', 'riemann:mid'],
            ['riemann', 'riemann:left'],
        ];

        for (const [rawMethod, expectedMethod] of variants) {
            const variantAst: AstProgram = {
                statements: [
                    ast.statements[2],
                    {
                        type: 'integral',
                        name: 'I',
                        source: 'c',
                        options: [
                            { name: 'method', value: rawMethod },
                            { name: 'range', value: '[-4, 4]' },
                            { name: 'segments', value: '32' },
                        ],
                        span: { start: 0, end: 0 },
                    },
                ],
            };

            const scene = compileScene(variantAst);
            expect(scene.integrals[0].method).toBe(expectedMethod);
        }
    });

    it('accepts right/mid riemann on surfaces (2D endpoint rule unlocked)', () => {
        for (const rawMethod of ['riemann:right', 'riemann:mid']) {
            const variantAst: AstProgram = {
                statements: [
                    ast.statements[3],
                    {
                        type: 'integral',
                        name: 'I2D',
                        source: 's',
                        options: [
                            { name: 'method', value: rawMethod },
                            { name: 'range', value: '[-1, 1, -1, 1]' },
                            { name: 'segments', value: '32' },
                        ],
                        span: { start: 0, end: 0 },
                    },
                ],
            };

            const scene = compileScene(variantAst);
            expect(scene.integrals[0]).toMatchObject({
                sourceKind: 'surface',
                dim: 2,
                domainKind: 'rectangle',
                method: rawMethod,
            });
        }
    });

    it('compiles region statements with curve references, ranges and merged coefficients', () => {
        const regionAst: AstProgram = {
            statements: [
                ast.statements[2], // curve c = sin(x*a), range [-8, 8]
                {
                    type: 'object',
                    kind: 'curve',
                    name: 'd',
                    expr: 'x * k + j',
                    options: [{ name: 'range', value: '[-2, 2]' }],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'object',
                    kind: 'region',
                    name: 'R',
                    expr: 'region(c, d)',
                    options: [
                        { name: 'color', value: '"#6bffb8"' },
                        { name: 'opacity', value: '0.35' },
                    ],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(regionAst);
        expect(scene.objects).toHaveLength(3);
        const region = scene.objects[2];
        expect(region.kind).toBe('region');
        if (region.kind !== 'region') return;
        expect(region).toMatchObject({
            curveAName: 'c',
            curveBName: 'd',
            color: '#6bffb8',
            opacity: 0.35,
        });
        // 缺省 range = 两曲线 x-range 交集:[-2, 2].
        expect(region.range).toEqual([-2, 2]);
        // 系数并集:曲线 c 有 a,曲线 d 有 k/j.
        expect(region.coefficients.map((coefficient) => coefficient.name).sort())
            .toEqual(['a', 'j', 'k']);
        // 区域公式是不等式带.
        expect(scene.objectFormulas[3]).toContain('\\le y\\le');
    });

    it('rejects region referencing a missing or non-curve boundary', () => {
        const missingAst: AstProgram = {
            statements: [
                ast.statements[2],
                {
                    type: 'object',
                    kind: 'region',
                    name: 'R',
                    expr: 'region(c, nope)',
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };
        expect(() => compileScene(missingAst)).toThrow(
            '区域 R 引用了不存在的曲线 nope',
        );

        const surfaceBoundaryAst: AstProgram = {
            statements: [
                ast.statements[2],
                ast.statements[3], // surface s
                {
                    type: 'object',
                    kind: 'region',
                    name: 'R2',
                    expr: 'region(c, s)',
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };
        expect(() => compileScene(surfaceBoundaryAst)).toThrow(
            '区域 R2 的边界必须是曲线(curve)对象',
        );
    });

    it('compiles double integrals over a region with integrand defaulting to 1', () => {
        const regionIntegralAst: AstProgram = {
            statements: [
                ast.statements[2], // curve c
                {
                    type: 'object',
                    kind: 'curve',
                    name: 'd',
                    expr: '1 - x * x',
                    options: [{ name: 'range', value: '[-1, 1]' }],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'object',
                    kind: 'region',
                    name: 'R',
                    expr: 'region(c, d)',
                    options: [{ name: 'range', value: '[-1, 1]' }],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'integral',
                    name: 'Area',
                    source: 'R',
                    options: [
                        { name: 'method', value: 'simpson' },
                        { name: 'segments', value: '64' },
                    ],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'integral',
                    name: 'Moment',
                    source: 'R',
                    options: [
                        { name: 'method', value: 'simpson' },
                        { name: 'integrand', value: 'x * x + y * y' },
                        { name: 'segments', value: '64' },
                    ],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(regionIntegralAst);
        expect(scene.integrals).toHaveLength(2);
        expect(scene.integrals[0]).toMatchObject({
            sourceKind: 'region',
            dim: 2,
            domainKind: 'region',
            method: 'simpson',
            integrand: '1',
            range: [-1, 1],
        });
        expect(scene.integrals[0].integrandCoefficients).toEqual([]);
        expect(scene.integrals[1].integrand).toBe('x * x + y * y');
        expect(scene.integralFormulas.Area).toContain('\\iint');
        expect(scene.integralFormulas.Moment).toContain('x * x + y * y');
    });

    it('compiles triple integrals over solids with world-coordinate integrands', () => {
        const solidIntegralAst: AstProgram = {
            statements: [
                {
                    type: 'object',
                    kind: 'sphere',
                    name: 'S',
                    expr: '[0, 0, 0]',
                    options: [{ name: 'radius', value: '1' }],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'integral',
                    name: 'Vol',
                    source: 'S',
                    options: [
                        { name: 'method', value: 'simpson' },
                        { name: 'segments', value: '48' },
                    ],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'integral',
                    name: 'M',
                    source: 'S',
                    options: [
                        { name: 'method', value: 'riemann:mid' },
                        { name: 'integrand', value: 'x * y + z * z' },
                        { name: 'segments', value: '32' },
                    ],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(solidIntegralAst);
        expect(scene.integrals).toHaveLength(2);
        expect(scene.integrals[0]).toMatchObject({
            sourceKind: 'sphere',
            dim: 3,
            domainKind: 'solid',
            integrand: '1',
        });
        expect(scene.integrals[0].range).toBeUndefined();
        expect(scene.integrals[1].integrand).toBe('x * y + z * z');
        expect(scene.integralFormulas.Vol).toContain('\\iiint');
        expect(scene.integralFormulas.M).toContain('\\iiint');
    });

    it('rejects unknown integral sources and solid range options', () => {
        const badSourceAst: AstProgram = {
            statements: [
                ast.statements[4], // vector_field F
                {
                    type: 'integral',
                    name: 'I',
                    source: 'F',
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };
        expect(() => compileScene(badSourceAst)).toThrow(
            '只能应用于 curve/surface/region 或体积对象',
        );

        const solidRangeAst: AstProgram = {
            statements: [
                {
                    type: 'object',
                    kind: 'sphere',
                    name: 'S',
                    expr: '[0, 0, 0]',
                    options: [{ name: 'radius', value: '1' }],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'integral',
                    name: 'I',
                    source: 'S',
                    options: [{ name: 'range', value: '[-1, 1]' }],
                    span: { start: 0, end: 0 },
                },
            ],
        };
        expect(() => compileScene(solidRangeAst)).toThrow(
            'solid 域不接受 range',
        );
    });

    it('evaluates analysis at expressions with current parameter overrides', () => {
        const surfaceAst: AstProgram = {
            statements: [
                ast.statements[0],
                ast.statements[1],
                ast.statements[3],
                {
                    type: 'analysis',
                    op: 'gradient',
                    name: 'gs',
                    call: 'grad',
                    source: 's',
                    at: ['a', 'b + 1'],
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(surfaceAst, { b: 3 });

        expect(scene.analyses[0].point[0]).toBe(2);
        expect(scene.analyses[0].point[1]).toBe(4);
        expect(scene.analyses[0].point[2]).toBe(0);
        // 曲面偏导没有唯一"切线",默认 show 不含 tangent,切向为 null.
        expect(scene.analyses[0].show).toEqual(['point', 'normal']);
        expect(scene.analyses[0].tangent).toBeNull();
        // 算子符号定义(列表展开的中间步骤):∇f = (f_x, f_y, f_z),
        // 系数保持符号,由 Rust 符号引擎对声明级表达式求偏导.
        expect(scene.analyses[0].symbolic).toBe(
            '\\nabla f=\\left(cos(y) * cos(x),\\ -(sin(x) * sin(y)),\\ 0\\right)',
        );
    });

    it('computes surface gradients from both partial derivatives', () => {
        vi.mocked(evaluate_gradient_point).mockReturnValueOnce({
            f0: 5,
            fx: 3,
            fy: 4,
            free: () => {},
            [Symbol.dispose]: () => {},
        });
        const surfaceAst: AstProgram = {
            statements: [
                ast.statements[3],
                {
                    type: 'analysis',
                    op: 'gradient',
                    name: 'gs',
                    call: 'grad',
                    source: 's',
                    at: ['2', '4'],
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(surfaceAst);

        const gradientPayload = JSON.parse(
            String(vi.mocked(evaluate_gradient_point).mock.calls[vi.mocked(evaluate_gradient_point).mock.calls.length - 1][0]),
        ) as Record<string, unknown>;
        expect(gradientPayload).toMatchObject({
            surface_expr: 'sin(x) * cos(y)',
            fx_expr: 'cos(y) * cos(x)',
            fy_expr: '-(sin(x) * sin(y))',
            coeff_names: [],
            x: 2,
            y: 4,
        });
        expect(scene.analyses[0].point).toEqual([2, 4, 5]);
        expect(scene.analyses[0].vector[0]).toBeCloseTo(-3 / Math.sqrt(26));
        expect(scene.analyses[0].vector[1]).toBeCloseTo(-4 / Math.sqrt(26));
        expect(scene.analyses[0].vector[2]).toBeCloseTo(1 / Math.sqrt(26));
    });

    it('reuses parsed nodes for repeated compiles of the same AST', () => {
        const first = compileScene(ast);
        const second = compileScene(ast, { b: 3 });

        expect((second.objects[0] as { expr: string }).expr)
            .toBe((first.objects[0] as { expr: string }).expr);
    });

    it('rejects invalid at coordinates instead of defaulting them to zero', () => {
        const badAtAst: AstProgram = {
            statements: [
                ast.statements[2],
                {
                    type: 'analysis',
                    op: 'gradient',
                    name: 'g',
                    call: 'grad',
                    source: 'c',
                    at: ['1', 'nonsense'],
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        expect(() => compileScene(badAtAst)).toThrow('at 第 2 个坐标无法求值: nonsense');
    });

    it('rejects non-finite parameter declarations instead of using defaults', () => {
        const badParamAst: AstProgram = {
            statements: [
                {
                    type: 'param',
                    name: 'a',
                    value: 'not-a-number',
                    span: { start: 0, end: 0 },
                },
                ast.statements[2],
            ],
        };

        expect(() => compileScene(badParamAst)).toThrow('参数 a 的 value 不是有效数字: not-a-number');
    });

    it('wraps cyclic coefficients onto [min, max) instead of clamping', () => {
        // 循环类系数(球坐标方位角 φ ∈ (-π, π])的覆盖值可能在域外,
        // 编译期统一回绕成主值;系数与参数 scope 必须给同一个值.
        const cyclicAst: AstProgram = {
            statements: [
                {
                    type: 'param',
                    name: 'phi',
                    value: '0',
                    ui: {
                        min: '-3.141592653589793',
                        max: '3.141592653589793',
                        step: '0.01',
                    },
                    cyclic: true,
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'object',
                    kind: 'curve',
                    name: 'c',
                    expr: 'sin(x * phi)',
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };
        const tau = 2 * Math.PI;

        const scene = compileScene(cyclicAst, { phi: Math.PI + 1 });
        expect(scene.params[0].cyclic).toBe(true);
        expect(scene.params[0].value).toBeCloseTo(Math.PI + 1 - tau, 9);
        const curve = scene.objects[0];
        if (curve.kind !== 'curve') throw new Error('期望 curve 对象');
        const [coefficient] = curve.coefficients;
        expect(coefficient.value).toBeCloseTo(Math.PI + 1 - tau, 9);
        expect(coefficient.cyclic).toBe(true);

        // 多圈同样回绕(2π 的整数倍等价于 0).
        const multiple = compileScene(cyclicAst, { phi: 3 * tau });
        expect(multiple.params[0].value).toBeCloseTo(0, 9);
    });

    it('still clamps ordinary coefficients at the declared bounds', () => {
        // 同一区间,不写 cyclic 时必须保持夹取:是否循环只能靠显式声明.
        const ordinaryAst: AstProgram = {
            statements: [
                {
                    type: 'param',
                    name: 'phi',
                    value: '0',
                    ui: { min: '-3.14', max: '3.14', step: '0.01' },
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'object',
                    kind: 'curve',
                    name: 'c',
                    expr: 'sin(x * phi)',
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(ordinaryAst, { phi: 7 });
        expect(scene.params[0].cyclic).toBe(false);
        expect(scene.params[0].value).toBe(3.14);
        const curve = scene.objects[0];
        if (curve.kind !== 'curve') throw new Error('期望 curve 对象');
        expect(curve.coefficients[0].value).toBe(3.14);
    });

    it('wraps an out-of-range initial value of a cyclic param instead of rejecting it', () => {
        const cyclicAst: AstProgram = {
            statements: [
                {
                    type: 'param',
                    name: 'phi',
                    value: '7',
                    ui: { min: '-3', max: '3', step: '0.01' },
                    cyclic: true,
                    span: { start: 0, end: 0 },
                },
                ast.statements[2],
            ],
        };

        const scene = compileScene(cyclicAst);
        expect(scene.params[0].value).toBeCloseTo(1, 9);
    });

    it('rejects fractional or non-positive object segments instead of passing them through', () => {
        const badSegmentsAst: AstProgram = {
            statements: [
                {
                    type: 'object',
                    kind: 'curve',
                    name: 'c',
                    expr: 'sin(x)',
                    options: [
                        { name: 'range', value: '[-8, 8]' },
                        { name: 'segments', value: '3.7' },
                    ],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        expect(() => compileScene(badSegmentsAst)).toThrow('曲线 c 的 segments 必须是正整数,当前为 3.7');
    });

    it('rejects reversed object ranges instead of generating NaN samples', () => {
        const badRangeAst: AstProgram = {
            statements: [
                {
                    type: 'object',
                    kind: 'curve',
                    name: 'c',
                    expr: 'sin(x)',
                    options: [{ name: 'range', value: '[8, -8]' }],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        expect(() => compileScene(badRangeAst)).toThrow('曲线 c 的 range 需要 min < max');
    });

    it('rejects invalid vector field grid values', () => {
        const badGridAst: AstProgram = {
            statements: [
                {
                    type: 'object',
                    kind: 'vector_field',
                    name: 'F',
                    expr: '[y, -x, 0]',
                    options: [{ name: 'grid', value: '[0, 8, 8]' }],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        expect(() => compileScene(badGridAst)).toThrow('向量场 F 的 grid 中的每个值都必须是正整数: [0, 8, 8]');
    });

    it('rejects unknown object options instead of silently ignoring them', () => {
        const badAst: AstProgram = {
            statements: [
                {
                    type: 'object',
                    kind: 'curve',
                    name: 'c',
                    expr: 'sin(x)',
                    options: [{ name: 'segmetns', value: '128' }],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        expect(() => compileScene(badAst)).toThrow('曲线 c 包含未知选项: segmetns');
    });

    it('rejects unknown show items instead of silently filtering them', () => {
        const badAst: AstProgram = {
            statements: [
                ast.statements[2],
                {
                    type: 'analysis',
                    op: 'gradient',
                    name: 'g',
                    call: 'grad',
                    source: 'c',
                    at: ['1'],
                    options: [{ name: 'show', value: '[point, nromal]' }],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        expect(() => compileScene(badAst)).toThrow('show 选项包含未知种类: nromal');
    });

    it('uses a separate, safer cap for 2D integral segments', () => {
        const badAst: AstProgram = {
            statements: [
                ast.statements[3],
                {
                    type: 'integral',
                    name: 'I2D',
                    source: 's',
                    options: [
                        { name: 'method', value: 'trapezoid' },
                        { name: 'range', value: '[-1, 1, -1, 1]' },
                        { name: 'segments', value: '300' },
                    ],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        expect(() => compileScene(badAst)).toThrow('积分 I2D 的 segments 不能超过 256');
    });

    it('resolves integral segments from a declared param and follows overrides', () => {
        const paramSegmentsAst: AstProgram = {
            statements: [
                {
                    type: 'param',
                    name: 'a',
                    value: '2',
                    ui: { min: '-5', max: '5', step: '0.1' },
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'param',
                    name: 'k',
                    value: '64',
                    ui: { min: '0', max: '256', step: '1' },
                    span: { start: 0, end: 0 },
                },
                ast.statements[2],
                {
                    type: 'integral',
                    name: 'I',
                    source: 'c',
                    options: [
                        { name: 'method', value: 'riemann' },
                        { name: 'range', value: '[-4, 4]' },
                        { name: 'segments', value: 'k' },
                    ],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(paramSegmentsAst);
        expect(scene.integrals[0].segments).toBe(64);
        expect(scene.integrals[0].countCoefficients.map((coefficient) => coefficient.name))
            .toEqual(['k']);

        const refreshed = compileScene(paramSegmentsAst, { k: 128 });
        expect(refreshed.integrals[0].segments).toBe(128);
        expect(refreshed.integrals[0].countCoefficients[0].value).toBe(128);

        const oddSimpsonAst: AstProgram = {
            ...paramSegmentsAst,
            statements: paramSegmentsAst.statements.map((statement) =>
                statement.type === 'integral'
                    ? {
                          ...statement,
                          options: [
                              { name: 'method', value: 'simpson' },
                              { name: 'range', value: '[-4, 4]' },
                              { name: 'segments', value: 'k' },
                          ],
                      }
                    : statement,
            ),
        };
        expect(() => compileScene(oddSimpsonAst, { k: 31 })).toThrow(
            '辛普森法要求分段数必须为偶数',
        );
    });

    it('rejects an integral segments reference to an undeclared param', () => {
        const badAst: AstProgram = {
            statements: [
                ast.statements[2],
                {
                    type: 'integral',
                    name: 'I',
                    source: 'c',
                    options: [
                        { name: 'method', value: 'riemann' },
                        { name: 'range', value: '[-4, 4]' },
                        { name: 'segments', value: 'missing' },
                    ],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        expect(() => compileScene(badAst)).toThrow('积分 I 的 segments 引用了未声明的参数 missing');
    });

    it('rejects analysis points with fewer coordinates than the operator needs', () => {
        const badAtAst: AstProgram = {
            statements: [
                ast.statements[4],
                {
                    type: 'analysis',
                    op: 'divergence',
                    name: 'd',
                    call: 'div',
                    source: 'F',
                    at: ['1', '2'],
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        expect(() => compileScene(badAtAst)).toThrow('at 至少需要 3 个坐标');
    });

    it('rejects odd Simpson segments instead of silently adjusting them', () => {
        const badAst: AstProgram = {
            statements: [
                ast.statements[2],
                {
                    type: 'integral',
                    name: 'I',
                    source: 'c',
                    options: [
                        { name: 'method', value: 'simpson' },
                        { name: 'range', value: '[-4, 4]' },
                        { name: 'segments', value: '31' },
                    ],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        expect(() => compileScene(badAst)).toThrow('辛普森法要求分段数必须为偶数');
    });

    it('routes divergence and curl through the WASM field evaluators', () => {
        const fieldAst: AstProgram = {
            statements: [
                ast.statements[4],
                {
                    type: 'analysis',
                    op: 'divergence',
                    name: 'd',
                    call: 'div',
                    source: 'F',
                    at: ['1', '2', '3'],
                    options: [],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'analysis',
                    op: 'curl',
                    name: 'c',
                    call: 'curl',
                    source: 'F',
                    at: ['1', '2', '3'],
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(fieldAst);

        expect(scene.analyses).toHaveLength(2);
        expect(scene.analyses[0].op).toBe('divergence');
        expect(scene.analyses[0].scalar).toBe(0);
        expect(scene.analyses[1].op).toBe('curl');
        expect(scene.analyses[1].vector).toEqual([0, 0, 0]);
        const divergencePayload = JSON.parse(
            String(vi.mocked(evaluate_divergence_point).mock.calls[vi.mocked(evaluate_divergence_point).mock.calls.length - 1][0]),
        ) as Record<string, unknown>;
        expect(divergencePayload).toMatchObject({
            dpx_expr: '0',
            dqy_expr: '0',
            drz_expr: '0',
            coeff_names: [],
            x: 1,
            y: 2,
            z: 3,
        });
        const curlPayload = JSON.parse(
            String(vi.mocked(evaluate_curl_point).mock.calls[vi.mocked(evaluate_curl_point).mock.calls.length - 1][0]),
        ) as Record<string, unknown>;
        expect(curlPayload).toMatchObject({
            dr_dy_expr: '0',
            dq_dz_expr: '0',
            dp_dz_expr: '0',
            dr_dx_expr: '0',
            dq_dx_expr: '-1',
            dp_dy_expr: '1',
            coeff_names: [],
            x: 1,
            y: 2,
            z: 3,
        });
    });

    it('rejects unimplemented differential operators instead of ignoring them', () => {
        const badAst: AstProgram = {
            statements: [
                ast.statements[2],
                {
                    type: 'analysis',
                    op: 'jacobian',
                    name: 'J',
                    call: 'jacobian',
                    source: 'c',
                    at: ['1', '0', '0'],
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        expect(() => compileScene(badAst)).toThrow('暂未实现');
    });

    it('rejects analysis function names that contradict the declared operator', () => {
        const badAst: AstProgram = {
            statements: [
                ast.statements[2],
                {
                    type: 'analysis',
                    op: 'gradient',
                    name: 'g',
                    call: 'curl',
                    source: 'c',
                    at: ['1'],
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        expect(() => compileScene(badAst)).toThrow(
            '函数名 curl 与算子 gradient 不匹配,应为 grad',
        );
    });

    it('compiles a transform chain with pi and function calls', () => {
        const transformAst: AstProgram = {
            statements: [
                {
                    type: 'tensor',
                    kind: 'transform',
                    name: 'T2',
                    expr: 'translate([2, 1, 0]) * rotate([0, 0, pi / 4]) * scale([1.5, 1, 1])',
                    span: { start: 0, end: 0 },
                },
            ],
        };

        expect(() => compileScene(transformAst)).not.toThrow();
    });

    it('applies a transform chain to an object with the expected matrix', () => {
        const transformAst: AstProgram = {
            statements: [
                {
                    type: 'tensor',
                    kind: 'transform',
                    name: 'T',
                    expr: 'translate([2, 1, 0]) * scale([2, 2, 2])',
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'object',
                    kind: 'curve',
                    name: 'c',
                    expr: 'x',
                    options: [
                        { name: 'transform', value: 'T' },
                        { name: 'range', value: '[-1, 1]' },
                    ],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(transformAst);

        expect(scene.objectTransforms[1]).toEqual([
            [2, 0, 0, 2],
            [0, 2, 0, 1],
            [0, 0, 2, 0],
            [0, 0, 0, 1],
        ]);
    });

    it('compiles animation clips and binds an ordered clip list to an object', () => {
        const animationAst: AstProgram = {
            statements: [
                {
                    type: 'animation',
                    name: 'spin',
                    expr: 'rotate([0, 0, pi / 2])',
                    options: [{ name: 'duration', value: '2' }],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'animation',
                    name: 'drift',
                    expr: 'translate([1, 0, 0])',
                    options: [{ name: 'duration', value: '1' }],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'object',
                    kind: 'curve',
                    name: 'c',
                    expr: 'x',
                    options: [
                        { name: 'range', value: '[-1, 1]' },
                        { name: 'animation', value: '[spin, drift]' },
                    ],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(animationAst);

        expect(scene.animations).toHaveLength(2);
        expect(scene.animations[0]).toMatchObject({ name: 'spin', duration: 2 });
        expect(scene.animations[1]).toMatchObject({ name: 'drift', duration: 1 });
        expect(scene.animations[0].matrix[0][0]).toBeCloseTo(0);
        expect(scene.animations[0].matrix[0][1]).toBeCloseTo(-1);
        expect(scene.animations[0].matrix[1][0]).toBeCloseTo(1);
        expect(scene.animations[0].matrix[1][1]).toBeCloseTo(0);
        expect(scene.animations[1].matrix).toEqual([
            [1, 0, 0, 1],
            [0, 1, 0, 0],
            [0, 0, 1, 0],
            [0, 0, 0, 1],
        ]);
        expect(scene.objectAnimations[1]).toEqual(['spin', 'drift']);
    });

    it('accepts a named matrix or transform as a single animation matrix', () => {
        const animationAst: AstProgram = {
            statements: [
                {
                    type: 'tensor',
                    kind: 'matrix',
                    name: 'M',
                    expr: '[[1, 0, 0, 2], [0, 1, 0, 3], [0, 0, 1, 4], [0, 0, 0, 1]]',
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'tensor',
                    kind: 'transform',
                    name: 'T',
                    expr: 'as_transform(M)',
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'animation',
                    name: 'move',
                    expr: 'T',
                    options: [{ name: 'duration', value: '1' }],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(animationAst);

        expect(scene.animations).toHaveLength(1);
        expect(scene.animations[0].matrix).toEqual([
            [1, 0, 0, 2],
            [0, 1, 0, 3],
            [0, 0, 1, 4],
            [0, 0, 0, 1],
        ]);
    });

    it('rejects animation declarations that compose more than one matrix', () => {
        const badAst: AstProgram = {
            statements: [
                {
                    type: 'animation',
                    name: 'bad',
                    expr: 'translate([1, 0, 0]) * rotate([0, 0, pi / 4])',
                    options: [{ name: 'duration', value: '2' }],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        expect(() => compileScene(badAst)).toThrow('动画 bad 只能包含一个矩阵变换');
    });

    it('rejects animation duration that is missing or non-positive', () => {
        const badAst: AstProgram = {
            statements: [
                {
                    type: 'animation',
                    name: 'bad',
                    expr: 'translate([1, 0, 0])',
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        expect(() => compileScene(badAst)).toThrow('动画 bad 的 duration 必须大于 0');
    });

    it('rejects object animation references to unknown clips', () => {
        const badAst: AstProgram = {
            statements: [
                {
                    type: 'object',
                    kind: 'curve',
                    name: 'c',
                    expr: 'x',
                    options: [
                        { name: 'range', value: '[-1, 1]' },
                        { name: 'animation', value: '[missing]' },
                    ],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        expect(() => compileScene(badAst)).toThrow('对象 c 引用了不存在的动画 missing');
    });

    it('evaluates matrix literals through the WASM scalar backend', () => {
        const matrixAst: AstProgram = {
            statements: [
                {
                    type: 'tensor',
                    kind: 'matrix',
                    name: 'M',
                    expr: '[[1, 0, 0, 2], [0, 1, 0, 3], [0, 0, 1, 4], [0, 0, 0, 1]]',
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'tensor',
                    kind: 'transform',
                    name: 'T',
                    expr: 'as_transform(M)',
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'object',
                    kind: 'curve',
                    name: 'c',
                    expr: 'x',
                    options: [
                        { name: 'transform', value: 'T' },
                        { name: 'range', value: '[-1, 1]' },
                    ],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(matrixAst);

        expect(scene.objectTransforms[1]).toEqual([
            [1, 0, 0, 2],
            [0, 1, 0, 3],
            [0, 0, 1, 4],
            [0, 0, 0, 1],
        ]);
        expect(evaluate_scalar).toHaveBeenCalled();
    });

    it('compiles point and vector objects, including shorthand vector direction', () => {
        const pointVectorAst: AstProgram = {
            statements: [
                {
                    type: 'param',
                    name: 'a',
                    value: '2',
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'object',
                    kind: 'point',
                    name: 'P',
                    expr: '[a, 1, 0]',
                    options: [],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'object',
                    kind: 'vector',
                    name: 'V',
                    expr: '[[1, 2, 3], [a, 0, 1]]',
                    options: [],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'object',
                    kind: 'vector',
                    name: 'W',
                    expr: '[0, a, 0]',
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(pointVectorAst, { a: 4 });

        expect(scene.objects).toHaveLength(3);
        expect(scene.objects[0]).toMatchObject({ kind: 'point', x: 4, y: 1, z: 0 });
        expect(scene.objects[1]).toMatchObject({
            kind: 'vector',
            origin: { x: 1, y: 2, z: 3 },
            direction: { x: 4, y: 0, z: 1 },
        });
        expect(scene.objects[2]).toMatchObject({
            kind: 'vector',
            origin: { x: 0, y: 0, z: 0 },
            direction: { x: 0, y: 4, z: 0 },
        });
    });

    it('compiles volume objects into one conic IR shape for cylinder/cone/frustum', () => {
        const volumeAst: AstProgram = {
            statements: [
                {
                    type: 'object',
                    kind: 'sphere',
                    name: 'S',
                    expr: '[0, 1, 0]',
                    options: [{ name: 'radius', value: '2' }],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'object',
                    kind: 'box',
                    name: 'B',
                    expr: '[1, 2, 3]',
                    options: [{ name: 'size', value: '[2, 1, 1]' }],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'object',
                    kind: 'cylinder',
                    name: 'C',
                    expr: '[0, 0, 0]',
                    options: [
                        { name: 'base', value: '1' },
                        { name: 'height', value: '2' },
                    ],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'object',
                    kind: 'cone',
                    name: 'K',
                    expr: '[0, 0, 1]',
                    options: [
                        { name: 'base', value: '2' },
                        { name: 'height', value: '3' },
                    ],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'object',
                    kind: 'frustum',
                    name: 'F',
                    expr: '[0, 0, -1]',
                    options: [
                        { name: 'base', value: '2' },
                        { name: 'height', value: '3' },
                        { name: 'top', value: '1' },
                    ],
                    span: { start: 0, end: 0 },
                },
            ],
        };

        const scene = compileScene(volumeAst);

        expect(scene.objects).toHaveLength(5);
        expect(scene.objectFormulas[1]).toBeNull();
        expect(scene.objectFormulas[2]).toBeNull();
        expect(scene.objects[0]).toMatchObject({
            kind: 'sphere',
            position: { x: 0, y: 1, z: 0 },
            radius: 2,
        });
        expect(scene.objects[1]).toMatchObject({
            kind: 'box',
            position: { x: 1, y: 2, z: 3 },
            size: [2, 1, 1],
        });
        expect(scene.objects[2]).toMatchObject({
            kind: 'conic',
            baseRadius: 1,
            topRadius: 1,
            height: 2,
        });
        expect(scene.objects[3]).toMatchObject({
            kind: 'conic',
            baseRadius: 2,
            topRadius: 0,
            height: 3,
        });
        expect(scene.objects[4]).toMatchObject({
            kind: 'conic',
            baseRadius: 2,
            topRadius: 1,
            height: 3,
        });
        const frustum = scene.objects[4];
        expect(frustum.kind).toBe('conic');
        if (frustum.kind === 'conic') {
            expect(frustum.sideAngle).toBeCloseTo(Math.atan(1 / 3));
        }
    });
});

describe('derivative 求导语句', () => {
    function derivative(
        name: string,
        source: string,
        extra: Partial<{ variable: string; options: { name: string; value: string }[] }> = {},
    ): AstProgram['statements'][number] {
        return {
            type: 'derivative',
            name,
            source,
            variable: extra.variable,
            options: extra.options ?? [],
            span: { start: 0, end: 0 },
        } as AstProgram['statements'][number];
    }

    it('compiles a curve derivative into a new curve object inheriting range/segments', () => {
        const derivAst: AstProgram = {
            statements: [
                ast.statements[2], // curve c = sin(x*a), range [-8,8], segments 128
                derivative('dc', 'c'),
            ],
        };
        const scene = compileScene(derivAst);

        expect(scene.objects).toHaveLength(2);
        const deriv = scene.objects[1] as {
            kind: 'curve';
            expr: string;
            coefficients: { name: string }[];
            range: [number, number];
            segments: number;
            id: number;
        };
        expect(deriv.kind).toBe('curve');
        expect(deriv.expr).toBe('a * cos(x * a)');
        expect(deriv.coefficients.map((coefficient) => coefficient.name)).toEqual(['a']);
        // 继承源对象的 range/segments,id 排在源对象之后.
        expect(deriv.range).toEqual([-8, 8]);
        expect(deriv.segments).toBe(128);
        expect(deriv.id).toBe(2);
        // 进入对象列表公式:微分算子 + 源函数 + 求出的导函数(缺一不可);
        // latex mock 原样返回表达式.
        expect(scene.objectFormulas[2]).toBe(
            'y=\\frac{\\mathrm{d}}{\\mathrm{d}x}\\left(sin(x * a)\\right)=a * cos(x * a)',
        );
    });

    it('compiles a surface derivative with an explicit variable', () => {
        const derivAst: AstProgram = {
            statements: [
                ast.statements[3], // surface s
                derivative('ds', 's', { variable: 'x' }),
            ],
        };
        const scene = compileScene(derivAst);

        expect(scene.objects).toHaveLength(2);
        const surface = scene.objects[1] as {
            kind: 'surface';
            expr: string;
            coefficients: { name: string }[];
        };
        expect(surface.kind).toBe('surface');
        expect(surface.expr).toBe('cos(y) * cos(x)');
        expect(surface.coefficients).toEqual([]);
        // 曲面偏导用 ∂/∂x,括号里同样是源函数,后面接 ∂f/∂x 的结果.
        expect(scene.objectFormulas[2]).toBe(
            'z=\\frac{\\partial}{\\partial x}\\left(sin(x) * cos(y)\\right)=cos(y) * cos(x)',
        );
    });

    it('uses the requested partial variable in the surface derivative formula', () => {
        const derivAst: AstProgram = {
            statements: [
                ast.statements[3], // surface s
                derivative('dsy', 's', { variable: 'y' }),
            ],
        };
        const scene = compileScene(derivAst);

        expect(scene.objectFormulas[2]).toBe(
            'z=\\frac{\\partial}{\\partial y}\\left(sin(x) * cos(y)\\right)=-(sin(x) * sin(y))',
        );
    });

    it('supports chaining to higher-order derivatives (d²f)', () => {
        const derivAst: AstProgram = {
            statements: [
                ast.statements[2],
                derivative('dc', 'c'),
                derivative('d2c', 'dc'),
            ],
        };
        const scene = compileScene(derivAst);

        expect(scene.objects).toHaveLength(3);
        const d2 = scene.objects[2] as { kind: 'curve'; expr: string };
        // mock 对未知表达式返回 '1'(对 'a * cos(x * a)' 再求 x 导).
        expect(d2.kind).toBe('curve');
        expect(d2.expr).toBe('1');
        // 高阶导数公式同样两边都在:算子括号里是上一阶导函数,等号右侧是本阶结果.
        expect(scene.objectFormulas[2]).toBe(
            'y=\\frac{\\mathrm{d}}{\\mathrm{d}x}\\left(sin(x * a)\\right)=a * cos(x * a)',
        );
        expect(scene.objectFormulas[3]).toBe(
            'y=\\frac{\\mathrm{d}}{\\mathrm{d}x}\\left(a * cos(x * a)\\right)=1',
        );
    });

    it('rejects derivative of a non-curve/surface source', () => {
        const badAst: AstProgram = {
            statements: [
                ast.statements[4], // vector_field F
                derivative('dF', 'F'),
            ],
        };
        expect(() => compileScene(badAst)).toThrow(
            '求导 dF 只能应用于 curve/surface/implicit/sphere 类型对象',
        );
    });

    it('rejects derivative referencing a missing source', () => {
        const badAst: AstProgram = {
            statements: [derivative('d', 'nope')],
        };
        expect(() => compileScene(badAst)).toThrow('求导 d 引用了不存在的对象 nope');
    });

    it('requires a variable for surface derivatives and rejects invalid ones', () => {
        const noVar: AstProgram = {
            statements: [
                ast.statements[3],
                derivative('ds', 's'),
            ],
        };
        expect(() => compileScene(noVar)).toThrow('曲面求导 ds 需要指定变量 x 或 y');

        const badVar: AstProgram = {
            statements: [
                ast.statements[3],
                derivative('ds', 's', { variable: 'z' }),
            ],
        };
        expect(() => compileScene(badVar)).toThrow('曲面求导 ds 的变量只能是 x 或 y');
    });

    it('rejects curve derivatives with a non-x variable', () => {
        const badAst: AstProgram = {
            statements: [
                ast.statements[2],
                derivative('dc', 'c', { variable: 'y' }),
            ],
        };
        expect(() => compileScene(badAst)).toThrow('曲线 dc 的求导变量只能是 x');
    });

    it('rejects unknown derivative options instead of silently using defaults', () => {
        const badAst: AstProgram = {
            statements: [
                ast.statements[2],
                derivative('dc', 'c', { options: [{ name: 'segmetns', value: '32' }] }),
            ],
        };
        expect(() => compileScene(badAst)).toThrow('求导 dc 包含未知选项: segmetns');
    });
});

describe('语句级错误定位', () => {
    it('compileScene 抛出的语句错误携带真实 span,可换算成源码行列', () => {
        const source = 'curve c = sin(x);\ngradient g = grad(nope) at [0];';
        const ast: AstProgram = {
            statements: [
                {
                    type: 'object',
                    kind: 'curve',
                    name: 'c',
                    expr: 'sin(x)',
                    options: [],
                    span: { start: 0, end: 17 },
                },
                {
                    type: 'analysis',
                    op: 'gradient',
                    name: 'g',
                    call: 'grad',
                    source: 'nope',
                    at: ['0'],
                    options: [],
                    span: { start: 18, end: 46 },
                },
            ],
        };

        let caught: unknown;
        try {
            compileSceneWithOps(ast, {}, jsMatrixOps);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(CompileError);
        expect(
            formatLocatedError(
                (caught as CompileError).message,
                (caught as CompileError).span,
                source,
            ),
        ).toBe('第 2 行第 1 列: 分析 g 引用了不存在的对象 nope');
    });
});

// 202609 review 修复的回归测试:见 DslCompiler.ts / analyses.ts / staticScene.ts
// 文件头的约定(1. hidden 先校验后禁用;2. 求值语句名唯一;3. 表达式归一化
// 收口;5. region 边界约束上收 staticScene).
describe('review 修复回归测试', () => {
    function curve(name: string, expr: string): AstProgram['statements'][number] {
        return {
            type: 'object',
            kind: 'curve',
            name,
            expr,
            options: [{ name: 'range', value: '[-4, 4]' }],
            span: { start: 0, end: 0 },
        };
    }

    it('rejects duplicate integral names instead of silently overwriting formulas', () => {
        const badAst: AstProgram = {
            statements: [
                curve('c', 'sin(x)'),
                {
                    type: 'integral',
                    name: 'I',
                    source: 'c',
                    options: [],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'integral',
                    name: 'I',
                    source: 'c',
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };
        expect(() => compileScene(badAst)).toThrow('积分 I 重复声明');
    });

    it('rejects duplicate analysis names', () => {
        const badAst: AstProgram = {
            statements: [
                curve('c', 'sin(x)'),
                {
                    type: 'analysis',
                    op: 'gradient',
                    name: 'g',
                    call: 'grad',
                    source: 'c',
                    at: ['1'],
                    options: [],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'analysis',
                    op: 'gradient',
                    name: 'g',
                    call: 'grad',
                    source: 'c',
                    at: ['1'],
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };
        expect(() => compileScene(badAst)).toThrow('分析 g 重复声明');
    });

    it('validates hidden integrals like visible ones (missing source still errors)', () => {
        const badAst: AstProgram = {
            statements: [
                curve('c', 'sin(x)'),
                {
                    type: 'integral',
                    name: 'I',
                    source: 'missing',
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };
        expect(() => compileScene(
            badAst,
            {},
            { hiddenIntegralNames: new Set(['I']) },
        )).toThrow('积分 I 引用了不存在的对象 missing');
    });

    it('validates hidden analyses against the op × kind matrix (unsupported kind still errors)', () => {
        const badAst: AstProgram = {
            statements: [
                {
                    type: 'object',
                    kind: 'box',
                    name: 'B',
                    expr: '[0, 0, 0]',
                    options: [],
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'analysis',
                    op: 'gradient',
                    name: 'g',
                    call: 'grad',
                    source: 'B',
                    at: ['0', '0', '0'],
                    options: [],
                    span: { start: 0, end: 0 },
                },
            ],
        };
        expect(() => compileScene(
            badAst,
            {},
            { hiddenAnalysisNames: new Set(['g']) },
        )).toThrow('分析 g 暂不支持 box 体积对象');
    });

    it('normalizes vector_field components at blueprint build like curve/surface exprs', () => {
        const fieldAst: AstProgram = {
            statements: [
                {
                    type: 'object',
                    kind: 'vector_field',
                    name: 'G',
                    expr: '[sin(x*a), 0, 0]',
                    options: [{ name: 'grid', value: '[4, 4, 4]' }],
                    span: { start: 0, end: 0 },
                },
            ],
        };
        const scene = compileScene(fieldAst);
        const field = scene.objects[0];
        expect(field.kind).toBe('vector_field');
        if (field.kind === 'vector_field') {
            expect(field.components).toEqual(['sin(x * a)', '0', '0']);
        }
    });

    it('accepts a bare matrix name in an object transform option (unified reference grammar)', () => {
        const transformAst: AstProgram = {
            statements: [
                {
                    type: 'tensor',
                    kind: 'matrix',
                    name: 'M',
                    expr: '[[1, 0, 0, 2], [0, 1, 0, 3], [0, 0, 1, 4], [0, 0, 0, 1]]',
                    span: { start: 0, end: 0 },
                },
                {
                    type: 'object',
                    kind: 'curve',
                    name: 'c',
                    expr: 'x',
                    options: [
                        { name: 'transform', value: 'M' },
                        { name: 'range', value: '[-1, 1]' },
                    ],
                    span: { start: 0, end: 0 },
                },
            ],
        };
        const scene = compileScene(transformAst);
        expect(scene.objectTransforms[1]).toEqual([
            [1, 0, 0, 2],
            [0, 1, 0, 3],
            [0, 0, 1, 4],
            [0, 0, 0, 1],
        ]);
    });
});

describe('隐式场(implicit)与球体梯度', () => {
    type Statement = AstProgram['statements'][number];
    type OptionList = { name: string; value: string }[];

    function objectStatement(
        kind: 'implicit' | 'sphere' | 'box',
        name: string,
        expr: string,
        options: OptionList = [],
    ): Statement {
        return {
            type: 'object',
            kind,
            name,
            expr,
            options,
            span: { start: 0, end: 0 },
        } as Statement;
    }

    function gradientStatement(
        name: string,
        source: string,
        at: string[],
        options: OptionList = [],
    ): Statement {
        return {
            type: 'analysis',
            op: 'gradient',
            name,
            call: 'grad',
            source,
            at,
            options,
            span: { start: 0, end: 0 },
        } as Statement;
    }

    function derivativeStatement(
        name: string,
        source: string,
        options: OptionList = [],
    ): Statement {
        return {
            type: 'derivative',
            name,
            source,
            options,
            span: { start: 0, end: 0 },
        } as Statement;
    }

    function implicitObject(scene: ReturnType<typeof compileScene>, name: string) {
        const object = scene.objects.find((candidate) => candidate.name === name);
        expect(object?.kind).toBe('implicit');
        if (!object || object.kind !== 'implicit') throw new Error('不是隐式对象');
        return object;
    }

    function vectorFieldObject(scene: ReturnType<typeof compileScene>, name: string) {
        const object = scene.objects.find((candidate) => candidate.name === name);
        expect(object?.kind).toBe('vector_field');
        if (!object || object.kind !== 'vector_field') throw new Error('不是向量场');
        return object;
    }

    it('infers implicit dimension from the coordinate variables and keeps level', () => {
        const scene = compileScene({
            statements: [
                objectStatement('implicit', 'C', 'x^2 + y^2 - 1'),
                objectStatement('implicit', 'S', 'x^2 + y^2 + z^2 - 4', [
                    { name: 'level', value: '2' },
                ]),
            ],
        });

        const curve = implicitObject(scene, 'C');
        expect(curve.dim).toBe(2);
        expect(curve.level).toBe(0);

        const surface = implicitObject(scene, 'S');
        expect(surface.dim).toBe(3);
        expect(surface.level).toBe(2);

        // 隐式场本身就是方程,公式层不能套 curve/surface 的 y=/z=.
        expect(scene.objectFormulas[curve.id]).toBe('x^2 + y^2 - 1=0');
        expect(scene.objectFormulas[surface.id]).toBe('x^2 + y^2 + z^2 - 4=2');
    });

    it('rejects implicit fields without coordinate variables or with unknown options', () => {
        expect(() => compileScene({
            statements: [objectStatement('implicit', 'Z', '1')],
        })).toThrow('隐式场 Z 的表达式必须包含坐标变量 x/y/z');

        expect(() => compileScene({
            statements: [
                objectStatement('implicit', 'C', 'x^2 + y^2 - 1', [
                    { name: 'colour', value: '"#fff"' },
                ]),
            ],
        })).toThrow('隐式场 C 包含未知选项: colour');
    });

    it('projects a sphere gradient onto the surface (z of at defaults to 0)', () => {
        const scene = compileScene({
            statements: [
                objectStatement('sphere', 'S', '[0, 0, 0]', [
                    { name: 'radius', value: '2' },
                ]),
                // 语法上 at 至少要两个坐标;三维场缺省的第三个按 0 补全.
                gradientStatement('g', 'S', ['1', '1']),
            ],
        });

        const analysis = scene.analyses[0];
        // 输入点 (1,1,0) 在球内,沿 ∇f 径向投影到 x²+y²=4 上的 (√2,√2,0).
        expect(analysis.point[0]).toBeCloseTo(Math.SQRT2, 6);
        expect(analysis.point[1]).toBeCloseTo(Math.SQRT2, 6);
        expect(analysis.point[2]).toBeCloseTo(0, 6);
        expect(analysis.vector[0]).toBeCloseTo(1 / Math.SQRT2, 6);
        expect(analysis.vector[1]).toBeCloseTo(1 / Math.SQRT2, 6);
        expect(analysis.vector[2]).toBeCloseTo(0, 6);
        // 3D 等值面没有唯一切线,只提供切平面.
        expect(analysis.tangent).toBeNull();
        expect(analysis.show).toEqual(['point', 'normal']);
        expect(analysis.scalar).toBeCloseTo(0, 6);
    });

    it('honours an explicit tangent_plane show on a sphere gradient', () => {
        const scene = compileScene({
            statements: [
                objectStatement('sphere', 'S', '[0, 0, 0]', [
                    { name: 'radius', value: '2' },
                ]),
                gradientStatement('g', 'S', ['1', '1'], [
                    { name: 'show', value: '[point, normal, tangent_plane]' },
                ]),
            ],
        });
        expect(scene.analyses[0].show).toEqual(['point', 'normal', 'tangent_plane']);
    });

    it('rejects a sphere gradient at the centre where ∇f vanishes', () => {
        expect(() => compileScene({
            statements: [
                objectStatement('sphere', 'S', '[0, 0, 0]', [
                    { name: 'radius', value: '2' },
                ]),
                gradientStatement('g', 'S', ['0', '0']),
            ],
        })).toThrow('∇f = 0');
    });

    it('rejects gradient on box/conic with a roadmap error', () => {
        expect(() => compileScene({
            statements: [
                objectStatement('box', 'B', '[0, 0, 0]'),
                gradientStatement('g', 'B', ['1', '1', '1']),
            ],
        })).toThrow('分析 g 暂不支持 box 体积对象');
    });

    it('keeps hidden implicit analyses validated but uncomputed', () => {
        vi.mocked(symbolic_derivative).mockClear();
        const scene = compileScene(
            {
                statements: [
                    objectStatement('sphere', 'S', '[0, 0, 0]', [
                        { name: 'radius', value: '2' },
                    ]),
                    gradientStatement('g', 'S', ['1', '1'], [
                        { name: 'show', value: '[point, tangent_plane]' },
                    ]),
                ],
            },
            {},
            { hiddenAnalysisNames: new Set(['g']) },
        );

        expect(scene.analyses[0].enabled).toBe(false);
        // show 仍在隐藏前完成校验与解析:隐藏项不能带着拼写错误静默存活.
        expect(scene.analyses[0].show).toEqual(['point', 'tangent_plane']);
        expect(scene.analyses[0].point).toEqual([0, 0, 0]);
        // 隐藏 = 只保留列表占位:隐式场闭包(符号偏导)根本不建.
        expect(vi.mocked(symbolic_derivative)).not.toHaveBeenCalled();
    });

    it('projects a 2D implicit gradient and gives an in-plane tangent', () => {
        const scene = compileScene({
            statements: [
                objectStatement('implicit', 'C', 'x^2 + y^2 - 1'),
                gradientStatement('g', 'C', ['2', '0']),
            ],
        });

        const analysis = scene.analyses[0];
        expect(analysis.point[0]).toBeCloseTo(1, 6);
        expect(analysis.point[1]).toBeCloseTo(0, 6);
        expect(analysis.point[2]).toBeCloseTo(0, 6);
        expect(analysis.vector[0]).toBeCloseTo(1, 6);
        expect(analysis.vector[1]).toBeCloseTo(0, 6);
        // 2D 隐式曲线默认画切线:t = (−fy, fx, 0) 归一化 = (0, 1, 0).
        expect(analysis.tangent?.[0]).toBeCloseTo(0, 6);
        expect(analysis.tangent?.[1]).toBeCloseTo(1, 6);
        expect(analysis.show).toEqual(['point', 'normal', 'tangent']);
    });

    it('projects a 3D implicit field onto its level set', () => {
        const scene = compileScene({
            statements: [
                objectStatement('implicit', 'S', 'x^2 + y^2 + z^2 - 4'),
                gradientStatement('g', 'S', ['0', '0', '3']),
            ],
        });

        const analysis = scene.analyses[0];
        expect(analysis.point[2]).toBeCloseTo(2, 6);
        expect(analysis.vector[2]).toBeCloseTo(1, 6);
    });

    it('compiles derivative(sphere) into a ∇f vector field with its symbol source', () => {
        const scene = compileScene({
            statements: [
                objectStatement('sphere', 'S', '[0, 0, 0]', [
                    { name: 'radius', value: '2' },
                ]),
                derivativeStatement('dS', 'S'),
            ],
        });

        const field = vectorFieldObject(scene, 'dS');
        expect(field.components).toEqual([
            '2 * (x - (0))',
            '2 * (y - (0))',
            '2 * (z - (0))',
        ]);
        // 公式要保留 ∇ 算子,括号里放源标量场 f = |p−c|²−r².
        expect(field.gradientOrigin).toEqual({
            sourceExpr: '(x - (0))^2 + (y - (0))^2 + (z - (0))^2 - (2)^2',
        });
        expect(scene.objectFormulas[field.id]).toContain('\\nabla');
    });

    it('compiles derivative(implicit) into ∇f (2D keeps a zero z component)', () => {
        const scene = compileScene({
            statements: [
                objectStatement('implicit', 'S', 'x^2 + y^2 + z^2 - 4'),
                derivativeStatement('dS', 'S', [{ name: 'grid', value: '[4, 4, 4]' }]),
                objectStatement('implicit', 'C', 'x^2 + y^2 - 1'),
                derivativeStatement('dC', 'C'),
            ],
        });

        expect(vectorFieldObject(scene, 'dS').components).toEqual(['2 * x', '2 * y', '2 * z']);
        expect(vectorFieldObject(scene, 'dS').gridSize).toEqual([4, 4, 4]);
        expect(vectorFieldObject(scene, 'dC').components).toEqual(['2 * x', '2 * y', '0']);
    });

    it('rejects derivative options that do not belong to the ∇f vector field', () => {
        expect(() => compileScene({
            statements: [
                objectStatement('implicit', 'S', 'x^2 + y^2 + z^2 - 4'),
                derivativeStatement('dS', 'S', [{ name: 'segments', value: '64' }]),
            ],
        })).toThrow('求导 dS 包含未知选项: segments');
    });

    it('still rejects derivative of a vector field source after adding field sources', () => {
        expect(() => compileScene({
            statements: [
                {
                    type: 'object',
                    kind: 'vector_field',
                    name: 'F',
                    expr: '[y, -x, 0]',
                    options: [],
                    span: { start: 0, end: 0 },
                },
                derivativeStatement('dF', 'F'),
            ],
        })).toThrow('求导 dF 只能应用于 curve/surface/implicit/sphere 类型对象');
    });
});

describe('球坐标 at spherical', () => {
    type Statement = AstProgram['statements'][number];
    type OptionList = { name: string; value: string }[];

    function sphereStatement(radius = '2'): Statement {
        return {
            type: 'object',
            kind: 'sphere',
            name: 'S',
            expr: '[0, 0, 0]',
            options: [{ name: 'radius', value: radius }],
            span: { start: 0, end: 0 },
        } as Statement;
    }

    function implicitStatement(name: string, expr: string): Statement {
        return {
            type: 'object',
            kind: 'implicit',
            name,
            expr,
            options: [],
            span: { start: 0, end: 0 },
        } as Statement;
    }

    /** 显式声明球坐标形式:atForm 由 Rust 解析器写进 AST,这里手工构造. */
    function sphericalGradient(
        name: string,
        source: string,
        at: string[],
        options: OptionList = [],
    ): Statement {
        return {
            type: 'analysis',
            op: 'gradient',
            name,
            call: 'grad',
            source,
            at,
            atForm: 'spherical',
            options,
            span: { start: 0, end: 0 },
        } as Statement;
    }

    it('interprets three arguments as [r, θ, φ] (physics default)', () => {
        const scene = compileScene({
            statements: [
                sphereStatement(),
                sphericalGradient('g', 'S', ['2', 'pi / 2', '0']),
            ],
        });

        const analysis = scene.analyses[0];
        // physics:θ = π/2 是赤道,φ = 0 指向 +X,半径 2 -> (2, 0, 0).
        expect(analysis.point[0]).toBeCloseTo(2, 9);
        expect(analysis.point[1]).toBeCloseTo(0, 9);
        expect(analysis.point[2]).toBeCloseTo(0, 9);
        expect(analysis.vector[0]).toBeCloseTo(1, 9);
        // 结果列表同时回显 [r, θ, φ].
        expect(analysis.pointSpherical?.[0]).toBeCloseTo(2, 9);
        expect(analysis.pointSpherical?.[1]).toBeCloseTo(Math.PI / 2, 9);
        expect(analysis.pointSpherical?.[2]).toBeCloseTo(0, 9);
    });

    it('defaults r to the sphere radius when only (θ, φ) are given', () => {
        const scene = compileScene({
            statements: [
                sphereStatement('2'),
                sphericalGradient('g', 'S', ['pi / 2', '0']),
            ],
        });
        expect(scene.analyses[0].point[0]).toBeCloseTo(2, 9);
        expect(scene.analyses[0].point[1]).toBeCloseTo(0, 9);
        expect(scene.analyses[0].point[2]).toBeCloseTo(0, 9);
    });

    it('measures the polar angle from +Z under the physics convention', () => {
        const scene = compileScene({
            statements: [
                sphereStatement(),
                sphericalGradient('g', 'S', ['2', '0', 'pi / 2']),
            ],
        });
        // θ = 0 是 +Z 极点,方位角 φ 此时不改变结果.
        expect(scene.analyses[0].point[0]).toBeCloseTo(0, 9);
        expect(scene.analyses[0].point[1]).toBeCloseTo(0, 9);
        expect(scene.analyses[0].point[2]).toBeCloseTo(2, 9);
        expect(scene.analyses[0].vector[2]).toBeCloseTo(1, 9);
    });

    it('rejects the (θ, φ) shorthand when the source is not a sphere', () => {
        expect(() => compileScene({
            statements: [
                implicitStatement('H', 'x^2 + y^2 + z^2 - 4'),
                sphericalGradient('g', 'H', ['pi / 2', '0']),
            ],
        })).toThrow('省略 r 时源对象必须是 sphere');
    });

    it('rejects more than three spherical coordinates', () => {
        expect(() => compileScene({
            statements: [
                sphereStatement(),
                sphericalGradient('g', 'S', ['2', '0', '0', '0']),
            ],
        })).toThrow('最多 3 个坐标');
    });
});
