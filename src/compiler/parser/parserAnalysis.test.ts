/**
 * 真实 Rust/WASM 解析器对**分析语句**的语法契约测试.
 *
 * 为什么单独一个文件:其余编译测试用 `vi.mock` 把 wasm 换成假实现,而
 * "`at` 是否必填""`laplacian` 能否接 `sphere` 源"这类问题由 `miko.pest` 的
 * `analysis_stmt` 规则决定(mock 掉 wasm 就测不到).这里直接走 `parseMiko`,
 * 保证"DSL 源码 -> AST"这一步在 CI 里有真实覆盖;编译期语义(算子×kind
 * 矩阵,dim,数值)仍由 DslCompiler.test.ts 覆盖.
 */
import { describe, expect, it } from 'vitest';
import { parseMiko } from '../parser';
import type { AnalysisStatement } from '../../contract/ast';

describe('parseMiko 分析语句', () => {
    it('接受 laplacian 作用于 sphere(笛卡尔 at)', async () => {
        const program = await parseMiko(
            'sphere ball = [0, 0, 0] { radius = 6; opacity = 0.5; segments = 64; };\n'
            + 'laplacian L1 = laplacian(ball) at [1, 1, 1];\n',
        );

        const analysis = program.statements.find(
            (statement): statement is AnalysisStatement => statement.type === 'analysis',
        );
        expect(analysis).toMatchObject({
            type: 'analysis',
            op: 'laplacian',
            name: 'L1',
            call: 'laplacian',
            source: 'ball',
            at: ['1', '1', '1'],
        });
        // 笛卡尔形式不带 atForm(缺省即笛卡尔).
        expect(analysis?.atForm).toBeUndefined();
    });

    it('接受 laplacian 的球坐标 at spherical(θ, φ) 省略 r', async () => {
        const program = await parseMiko(
            'param theta = 0.5;\n'
            + 'param phi = 1;\n'
            + 'sphere ball = [0, 0, 0] { radius = 6; };\n'
            + 'laplacian L1 = laplacian(ball) at spherical(theta, phi);\n',
        );

        const analysis = program.statements.find(
            (statement): statement is AnalysisStatement => statement.type === 'analysis',
        );
        expect(analysis).toMatchObject({
            op: 'laplacian',
            call: 'laplacian',
            atForm: 'spherical',
            at: ['theta', 'phi'],
        });
    });

    it('允许省略 at 的语法形态(缺 at 由编译期给出坐标数量错误)', async () => {
        // `laplacian(ball);` 在 pest 里能过(`op_call` 的 `at?` 可选),AST 的
        // `at` 字段缺省;真正的拒绝发生在编译期:分析算子输出的是"某一点的
        // 点值",没有隐含缺省测量点,`analyses.ts` 按 `at 至少需要 N 个坐标`
        // 报语句级错误(见 DslCompiler.test.ts 的 laplacian 缺 at 用例).
        const program = await parseMiko(
            'sphere ball = [0, 0, 0] { radius = 6; };\n'
            + 'laplacian L1 = laplacian(ball);\n',
        );

        const analysis = program.statements.find(
            (statement): statement is AnalysisStatement => statement.type === 'analysis',
        );
        expect(analysis).toMatchObject({ op: 'laplacian', source: 'ball' });
        expect(analysis?.at).toBeUndefined();
    });
});
