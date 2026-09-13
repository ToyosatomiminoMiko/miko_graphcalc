/**
 * 纯文本工具.
 *
 * `splitTopLevel` 被 DSL 选项解析与对象 transform 表达式解析
 * (`compiler/dsl/transforms.ts`)共用,放在这里避免每个模块各自维护
 * 一份带括号深度计数的复制.
 *
 * 曾随 MATLAB 兼容层一同存在的 `splitTopLevelWhitespace` /
 * `findMatchingDelimiter` 因唯一消费者(matlabCompat.ts)已删除而移除.
 */
export function splitTopLevel(source: string, separator: string): string[] {
    const parts: string[] = [];
    let start = 0;
    let parenDepth = 0;
    let bracketDepth = 0;

    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '(') parenDepth += 1;
        else if (ch === ')') parenDepth -= 1;
        else if (ch === '[') bracketDepth += 1;
        else if (ch === ']') bracketDepth -= 1;
        else if (ch === separator && parenDepth === 0 && bracketDepth === 0) {
            parts.push(source.slice(start, i));
            start = i + 1;
        }
    }

    parts.push(source.slice(start));
    return parts;
}
