/**
 * 语句级编译错误与源码定位工具的测试.
 *
 * 覆盖:错误升级携带 span,已带 span 的错误原样放行,字节偏移换算
 * 行/列(含多字节 UTF-8),错误文案前置源码定位的边界情况.
 */
import { describe, expect, it } from 'vitest';
import {
    CompileError,
    formatLocatedError,
    lineAndColumnAt,
    withStatementSpan,
} from './errors';
import type { SourceSpan } from './ast/types';

const SPAN: SourceSpan = { start: 0, end: 4 };

describe('withStatementSpan', () => {
    function capture<T>(body: () => T): unknown {
        try {
            body();
        } catch (error) {
            return error;
        }
        return undefined;
    }

    it('把普通 Error 升级为携带语句 span 的 CompileError', () => {
        const error = capture(() =>
            withStatementSpan(SPAN, () => {
                throw new Error('曲线 c 的 range 需要 min < max');
            }),
        );
        expect(error).toBeInstanceOf(CompileError);
        expect((error as CompileError).message).toBe('曲线 c 的 range 需要 min < max');
        expect((error as CompileError).span).toEqual(SPAN);
    });

    it('已是 CompileError 的错误原样放行,保留最近的语句归属', () => {
        const error = capture(() =>
            withStatementSpan({ start: 8, end: 12 }, () => {
                withStatementSpan(SPAN, () => {
                    throw new CompileError('内部语句错误', SPAN);
                });
                return null;
            }),
        );
        expect((error as CompileError).span).toEqual(SPAN);
    });

    it('成功路径原样返回结果', () => {
        expect(withStatementSpan(SPAN, () => 42)).toBe(42);
    });
});

describe('lineAndColumnAt', () => {
    it('按 1 基返回行与列', () => {
        const source = 'param a = 2;\ncurve c = sin(x);';
        expect(lineAndColumnAt(source, 0)).toEqual({ line: 1, column: 1 });
        // 'curve' 首字符位于第 2 行开头(第 1 行含换行共 13 字节).
        expect(lineAndColumnAt(source, 13)).toEqual({ line: 2, column: 1 });
        expect(lineAndColumnAt(source, 15)).toEqual({ line: 2, column: 3 });
    });

    it('多字节 UTF-8 时列号按字符计数', () => {
        const source = '曲线 = 1;\n曲面 y = 2;';
        // 第一行 5 个字符占 12 字节('曲''线' 各 3 字节),换行后即第 2 行.
        expect(lineAndColumnAt(source, 12)).toEqual({ line: 2, column: 1 });
    });
});

describe('formatLocatedError', () => {
    it('有 span 与 source 时前置行列定位', () => {
        const source = 'param a = 2;\ncurve c = sin(x);';
        expect(formatLocatedError('曲线 c 的 range 需要 min < max', { start: 13, end: 33 }, source))
            .toBe('第 2 行第 1 列: 曲线 c 的 range 需要 min < max');
    });

    it('span 或 source 缺失时原样返回', () => {
        const message = '分析 s1 不能应用于 conic 类型对象';
        expect(formatLocatedError(message, undefined, 'source')).toBe(message);
        expect(formatLocatedError(message, SPAN, undefined)).toBe(message);
    });

    it('span 越界时原样返回', () => {
        const message = '未知错误';
        expect(formatLocatedError(message, { start: -1, end: 2 }, 'ab')).toBe(message);
        expect(formatLocatedError(message, { start: 5, end: 9 }, 'ab')).toBe(message);
        expect(formatLocatedError(message, { start: 3, end: 2 }, 'abcd')).toBe(message);
    });
});
