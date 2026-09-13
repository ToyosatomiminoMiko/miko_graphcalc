import { describe, expect, it, vi } from 'vitest';
import { compileScene as compileSceneWithOps } from './DslCompiler';
import type { CompileSceneOptions } from './DslCompiler';
import { jsMatrixOps } from '../../math/tensor/testMatrixOps';
import type { AstProgram, ObjectStatement } from '../ast/types';
import { buildIntersectionInput } from '../../math/adapters/IntersectionMath';

vi.mock('../../wasm/math_rs/math_rs', () => {
    function evaluate(
        expr: string,
        names: string[],
        values: ArrayLike<number>,
        x: number,
        y: number,
        z: number,
    ): number {
        const scope: Record<string, number> = {};
        names.forEach((name, index) => {
            scope[name] = values[index];
        });
        scope.pi = Math.PI;
        scope.e = Math.E;
        scope.x = x;
        scope.y = y;
        scope.z = z;
        const fn = new Function(...Object.keys(scope), `return (${expr});`);
        return fn(...Object.values(scope));
    }

    return {
        evaluate_scalar: vi.fn((
            expr: string,
            names: string[],
            values: Float64Array,
            x: number,
            y: number,
            z: number,
        ) => evaluate(expr, names, values, x, y, z)),
        normalize_expression: vi.fn((expr: string) => expr),
        latex_expression: vi.fn((expr: string) => expr),
        symbolic_derivative: vi.fn(() => '0'),
        symbolic_variables: vi.fn(() => []),
        parse_array_strings: vi.fn((expr: string) => {
            const items = expr
                .slice(1, -1)
                .split(',')
                .map((item) => `"${item.trim()}"`);
            return `[${items.join(',')}]`;
        }),
        matrix4_from_expr: vi.fn(() => [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ]),
        sample_curve: vi.fn(() => ({
            points: new Float32Array(),
            offsets: new Uint32Array([0]),
        })),
        sample_surface_values: vi.fn(() => new Float64Array()),
        evaluate_gradient_point: vi.fn(() => ({ f0: 0, fx: 0, fy: 0 })),
        evaluate_divergence_point: vi.fn(() => 0),
        evaluate_curl_point: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
    };
});

function object(
    kind: ObjectStatement['kind'],
    name: string,
    expr: string,
    options: Array<{ name: string; value: string }> = [],
): ObjectStatement {
    return {
        type: 'object',
        kind,
        name,
        expr,
        options,
        span: { start: 0, end: 0 },
    };
}

function intersection(
    name: string,
    a: string,
    b: string,
    options: Array<{ name: string; value: string }> = [],
): AstProgram['statements'][number] {
    return {
        type: 'intersection',
        name,
        a,
        b,
        options,
        span: { start: 0, end: 0 },
    };
}

function curve(name: string, expr: string, range = '[-2, 2]'): ObjectStatement {
    return object('curve', name, expr, [
        { name: 'range', value: range },
        { name: 'segments', value: '64' },
    ]);
}

function surface(name: string, expr: string, range = '[-2, 2, -2, 2]'): ObjectStatement {
    return object('surface', name, expr, [
        { name: 'range', value: range },
        { name: 'segments', value: '32' },
    ]);
}

function program(...statements: AstProgram['statements']): AstProgram {
    return { statements };
}

function compileScene(
    programAst: AstProgram,
    paramOverrides: Record<string, number> = {},
    options: CompileSceneOptions = {},
) {
    return compileSceneWithOps(programAst, paramOverrides, jsMatrixOps, options);
}

describe('compileIntersections', () => {
    it('emits a task with source ids and default segments', () => {
        const scene = compileScene(program(
            curve('a', 'x'),
            curve('b', '-x + 2'),
            intersection('I', 'a', 'b'),
        ));

        expect(scene.intersections).toHaveLength(1);
        const task = scene.intersections[0];
        expect(task.name).toBe('I');
        expect(task.aName).toBe('a');
        expect(task.bName).toBe('b');
        expect(task.aId).toBe(scene.objects.find((o) => o.name === 'a')!.id);
        expect(task.bId).toBe(scene.objects.find((o) => o.name === 'b')!.id);
        expect(task.segments).toBe(128);
        expect(task.enabled).toBe(true);
    });

    it('honors the segments option', () => {
        const scene = compileScene(program(
            curve('a', 'x'),
            curve('b', '-x + 2'),
            intersection('I', 'a', 'b', [{ name: 'segments', value: '96' }]),
        ));
        expect(scene.intersections[0].segments).toBe(96);
    });

    it('keeps hidden tasks in the list without scheduling computation', () => {
        const scene = compileSceneWithOps(
            program(
                curve('a', 'x'),
                curve('b', '-x + 2'),
                intersection('I', 'a', 'b'),
            ),
            {},
            jsMatrixOps,
            { hiddenIntersectionNames: new Set(['I']) },
        );

        expect(scene.intersections).toHaveLength(1);
        expect(scene.intersections[0].enabled).toBe(false);
        expect(scene.intersections[0].aId).toBe(-1);
    });

    it('assigns colors from the palette in declaration order', () => {
        const scene = compileScene(program(
            curve('a', 'x'),
            curve('b', '-x + 2'),
            surface('s', 'y'),
            intersection('I1', 'a', 'b'),
            intersection('I2', 'a', 's'),
        ));
        expect(scene.intersections[0].color).not.toBe(scene.intersections[1].color);
    });

    it('keeps intersection computation independent of source visibility', () => {
        const scene = compileScene(program(
            surface('s1', '0'),
            surface('s2', 'x'),
            intersection('I', 's1', 's2'),
        ));
        const task = scene.intersections[0];
        const source = scene.objects.find((object) => object.name === 's1')!;
        source.enabled = false;

        expect(buildIntersectionInput(task, scene.objects, {})).not.toBeNull();
    });

    it('rejects unknown options instead of ignoring them', () => {
        expect(() => compileScene(program(
            curve('a', 'x'),
            curve('b', '-x + 2'),
            intersection('I', 'a', 'b', [{ name: 'foo', value: '1' }]),
        ))).toThrow('求交 I 包含未知选项: foo');
    });

    it('rejects references to missing objects', () => {
        expect(() => compileScene(program(
            curve('a', 'x'),
            intersection('I', 'a', 'missing'),
        ))).toThrow('求交 I 引用了不存在的对象 missing');
    });

    it('rejects self-intersection', () => {
        expect(() => compileScene(program(
            curve('a', 'x'),
            intersection('I', 'a', 'a'),
        ))).toThrow('两个对象不能相同');
    });

    it('rejects animated sources', () => {
        expect(() => compileScene(program(
            {
                type: 'animation',
                name: 'drift',
                expr: 'translate([1, 0, 0])',
                options: [{ name: 'duration', value: '1' }],
                span: { start: 0, end: 0 },
            },
            {
                ...curve('c', 'x'),
                options: [
                    { name: 'range', value: '[-2, 2]' },
                    { name: 'segments', value: '64' },
                    { name: 'animation', value: '[drift]' },
                ],
            },
            surface('s', 'y'),
            intersection('I', 'c', 's'),
        ))).toThrow('带动画,暂不支持');
    });

    it('rejects unsupported object kinds', () => {
        expect(() => compileScene(program(
            curve('c', 'x'),
            object('vector_field', 'F', '[x, y, z]'),
            intersection('I', 'c', 'F'),
        ))).toThrow('求交 I 不支持 vector_field 类型的对象 F');
    });

    it('rejects singular transform matrices at compile time', () => {
        expect(() => compileScene(program(
            {
                type: 'tensor',
                kind: 'transform',
                name: 'Z',
                expr: 'scale([0, 0, 0])',
                span: { start: 0, end: 0 },
            },
            {
                ...curve('c', 'x'),
                options: [
                    { name: 'range', value: '[-2, 2]' },
                    { name: 'segments', value: '64' },
                    { name: 'transform', value: 'Z' },
                ],
            },
            surface('s', 'y'),
            intersection('I', 'c', 's'),
        ))).toThrow('变换矩阵不可逆');
    });

    // 202609 review 结论:intersections 与 analyses/integrals 统一为
    // "hidden = 先完整校验,后禁用,仅跳过计算",见 intersections.ts 文件头.
    it('rejects duplicate intersection names', () => {
        expect(() => compileScene(program(
            curve('a', 'x'),
            curve('b', '-x + 2'),
            intersection('I', 'a', 'b'),
            intersection('I', 'a', 'b'),
        ))).toThrow('求交 I 重复声明');
    });

    it('validates hidden intersections like visible ones (missing source still errors)', () => {
        expect(() => compileScene(
            program(
                curve('a', 'x'),
                intersection('I', 'a', 'missing'),
            ),
            {},
            { hiddenIntersectionNames: new Set(['I']) },
        )).toThrow('求交 I 引用了不存在的对象 missing');
    });

    it('rejects hidden intersections that reference animated sources', () => {
        expect(() => compileScene(
            program(
                {
                    type: 'animation',
                    name: 'drift',
                    expr: 'translate([1, 0, 0])',
                    options: [{ name: 'duration', value: '1' }],
                    span: { start: 0, end: 0 },
                },
                {
                    ...curve('c', 'x'),
                    options: [
                        { name: 'range', value: '[-2, 2]' },
                        { name: 'segments', value: '64' },
                        { name: 'animation', value: '[drift]' },
                    ],
                },
                surface('s', 'y'),
                intersection('I', 'c', 's'),
            ),
            {},
            { hiddenIntersectionNames: new Set(['I']) },
        )).toThrow('带动画,暂不支持');
    });
});
