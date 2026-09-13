/**
 * 语句级编译错误与源码定位工具.
 *
 * Rust pest 解析器在产出 AST 时免费携带每条语句的字节区间 span;
 * 语句级编译循环(见 dsl/params.ts,dsl/staticScene.ts,dsl/DslCompiler.ts,
 * dsl/analyses.ts,dsl/intersections.ts)用 `withStatementSpan` 包裹后,
 * 内部抛出的普通 Error 会升级为携带该语句 span 的 CompileError.
 * 应用层(CompileController)持有原始源码,用 `formatLocatedError`
 * 把 span 换算成"第几行第几列"拼进错误文案,实现错误定位.
 *
 * 表达式运行时求值错误(例如拖动参数滑块时数值越界,发生在对象物化阶段)
 * 不经过语句循环,保持普通 Error--它们的文案已含对象/上下文,不必强行
 * 回溯声明语句,避免在 blueprint 上额外保存 span.
 */
import type { SourceSpan } from './ast/types';

/** 语句级编译错误:携带触发该错误的 DSL 语句 span. */
export class CompileError extends Error {
    constructor(
        message: string,
        readonly span: SourceSpan,
    ) {
        super(message);
        this.name = 'CompileError';
    }
}

/**
 * 在语句级边界执行 body:把抛出的普通 Error 升级为带该语句 span 的
 * CompileError.已是 CompileError 的错误原样放行,保留最近的语句归属.
 */
export function withStatementSpan<T>(span: SourceSpan, body: () => T): T {
    try {
        return body();
    } catch (error) {
        if (error instanceof CompileError) throw error;
        throw new CompileError(
            error instanceof Error ? error.message : String(error),
            span,
        );
    }
}

/**
 * 把源码字节偏移换算成 1 基 { 行, 列 }.
 *
 * span.start 是 UTF-8 字节偏移,JS 字符串按 UTF-16 代码单元索引,因此按
 * 码点遍历源码,累加每个码点的 UTF-8 字节宽,跨多字节文本时列号仍然按
 * "字符数"计(与编辑器显示一致).仅在一次错误定位时调用,线性开销可忽略.
 */
export function lineAndColumnAt(
    source: string,
    byteOffset: number,
): { line: number; column: number } {
    const encoder = new TextEncoder();
    let byte = 0;
    let line = 1;
    let column = 1;

    for (const ch of source) {
        if (byte >= byteOffset) break;
        byte += encoder.encode(ch).length;
        if (ch === '\n') {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    return { line, column };
}

/**
 * 给编译错误文案前置源码定位,如
 * `第 3 行第 12 列: 积分 I1 的 range 需要 2 个数值`.
 * span 或 source 缺失(非语句级错误/无源码上下文)时原样返回 message.
 */
export function formatLocatedError(
    message: string,
    span: SourceSpan | undefined,
    source: string | undefined,
): string {
    if (span === undefined || source === undefined) return message;
    if (span.start < 0 || span.end < span.start || span.start > source.length) {
        return message;
    }
    const { line, column } = lineAndColumnAt(source, span.start);
    return `第 ${line} 行第 ${column} 列: ${message}`;
}
