/**
 * 真实 Rust/WASM 解析器的集成测试(循环类系数).
 *
 * 为什么单独一个文件:其余编译测试用 vitest 的 `vi.mock` 把 wasm 换成假实现,
 * 而 `in cyclic [...]` 的识别发生在 pest 语法层(param_value 的 `in cyclic`
 * 前瞻 + param_ui 的 cyclic 规则 + Rust 侧的显式切分),mock 掉 wasm 就测不到.
 * 这里直接走 `parseMiko`,保证 DSL 源码 -> AST 的这一步在 CI 里也被真实覆盖.
 * 编译期语义(回绕,scope)仍在 DslCompiler.test.ts / paramValue.test.ts 覆盖.
 */
import { describe, expect, it } from 'vitest';
import { parseMiko } from '../parser';
import type { ParamStatement } from '../ast/types';

/** 只取 param 语句,便于按位置断言. */
function paramsOf(
    statements: readonly { type: string }[],
): ParamStatement[] {
    return statements.filter(
        (statement): statement is ParamStatement => statement.type === 'param',
    );
}

describe('parseMiko 循环类系数', () => {
    it('把 in cyclic [...] 解析成 cyclic 标记 + ui 区间', async () => {
        const program = await parseMiko(
            'param phi = 0 in cyclic [-3.14159, 3.14159, 0.01];\n'
            + 'gradient g = grad(s) at spherical(0.9, phi);\n'
            + 'sphere s = [0, 0, 0] { radius = 2; }\n',
        );

        const [phi] = paramsOf(program.statements);
        expect(phi).toMatchObject({
            name: 'phi',
            value: '0',
            cyclic: true,
            ui: { min: '-3.14159', max: '3.14159', step: '0.01' },
        });
    });

    it('普通参数不带 cyclic 字段', async () => {
        const program = await parseMiko('param a = 1 in [-2, 2, 0.1];\nparam b = 3;\n');
        const params = paramsOf(program.statements);
        expect(params[0].cyclic).toBeUndefined();
        expect(params[0].ui).toEqual({ min: '-2', max: '2', step: '0.1' });
        expect(params[1].cyclic).toBeUndefined();
        expect(params[1].ui).toBeUndefined();
    });

    it('保留既有 param 取值边界写法', async () => {
        // 循环前瞻不能破坏原本的边界:紧凑区间头,隐式乘法,圆括号值.
        const program = await parseMiko(
            'param a = 1 in[-2, 2, 0.1];\n'
            + 'param b = 2sin(x);\n'
            + 'param c = 1in[0, 1, 1];\n'
            + 'param d = sin(a) in [0, 3, 0.1];\n',
        );
        const params = paramsOf(program.statements);
        expect(params.map((item) => item.value)).toEqual([
            '1',
            '2sin(x)',
            '1in[0, 1, 1]',
            'sin(a)',
        ]);
        expect(params[0].ui).toMatchObject({ min: '-2', max: '2' });
        expect(params[1].ui).toBeUndefined();
        expect(params[2].ui).toBeUndefined();
        expect(params[3].ui).toMatchObject({ min: '0', max: '3' });
    });

    it('cyclic 缺少区间时解析失败', async () => {
        await expect(parseMiko('param phi = 0 in cyclic;\n')).rejects.toThrow();
    });
});
