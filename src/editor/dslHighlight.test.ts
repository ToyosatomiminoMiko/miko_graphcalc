/**
 * DSL 分词与高亮 HTML 单测.
 *
 * 锁四件事:
 * 1. `//` 注释与字符串的优先级(`color = "#6dd5ff";` 不能被当成注释);
 * 2. 选项键只在 `{}` 选项块里着色(`color =` 是属性名,`curve c =` 里的 `c` 不是);
 * 3. 生成的 HTML 去掉标签后与源码逐字相同(高亮层是背景层,错一个字就是错位);
 * 4. 语法里的关键字真的落到关键字类名上.
 *
 * 关键字表本身不再在这里对账:它由 `compiler/dsl/keywords.ts` 从 `miko.pest`
 * 派生,不存在第二份列表;抽取规则与 AST 种类常量的对账见
 * `compiler/dsl/keywords.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
    highlightDsl,
    tokenizeDslLine,
    type DslToken,
    type DslTokenKind,
} from './dslHighlight';

function scan(line: string, braceDepth = 0): { tokens: DslToken[]; state: { braceDepth: number } } {
    const state = { braceDepth };
    return { tokens: tokenizeDslLine(line, state), state };
}

function kindsOf(line: string, braceDepth = 0): Array<[DslTokenKind, string]> {
    return scan(line, braceDepth).tokens.map((token) => [token.kind, token.text]);
}

function textsOfKind(line: string, kind: DslTokenKind, braceDepth = 0): string[] {
    return kindsOf(line, braceDepth)
        .filter(([tokenKind]) => tokenKind === kind)
        .map(([, text]) => text);
}

/** 去掉 span 标签并把实体还原,用于"逐字相同"这条不变量. */
function stripHighlight(html: string): string {
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

describe('注释与字符串', () => {
    it('// 之后的整行都是注释', () => {
        expect(kindsOf('// 定义系数 { 未闭合')).toEqual([
            ['comment', '// 定义系数 { 未闭合'],
        ]);
    });

    it('行尾注释只吃掉后半行', () => {
        const kinds = kindsOf('curve c1 = sin(x); // 投影');
        expect(kinds[kinds.length - 1]).toEqual(['comment', '// 投影']);
        expect(textsOfKind('curve c1 = sin(x); // 投影', 'keyword')).toEqual(['curve']);
    });

    it('字符串里的 // 不是注释', () => {
        const line = 'color = "#6dd5ff"; // 主色';
        expect(textsOfKind(line, 'string', 1)).toEqual(['"#6dd5ff"']);
        expect(textsOfKind(line, 'comment', 1)).toEqual(['// 主色']);
    });

    it('字符串里的转义引号不会提前收尾', () => {
        expect(textsOfKind('label = "a\\"b" ;', 'string', 1)).toEqual(['"a\\"b"']);
    });
});

describe('关键字 / 数字 / 选项键', () => {
    it('param 与 in 是关键字,-5 与 0.1 是数字', () => {
        const kinds = kindsOf('param a = 1 in [-5, 5, 0.1];');
        expect(kinds).toContainEqual(['keyword', 'param']);
        expect(kinds).toContainEqual(['keyword', 'in']);
        expect(kinds.filter(([kind]) => kind === 'number').map(([, text]) => text))
            .toEqual(['1', '5', '5', '0.1']);
    });

    it('标识符里的 in 不会被当成关键字', () => {
        expect(textsOfKind('curve c1 = sin(x * a);', 'keyword')).toEqual(['curve']);
    });

    it('只写在语句规则里的关键字也落到关键字类名', () => {
        // 这些字面量内联在 param_stmt / param_ui / cyclic / animation_stmt / at /
        // spherical_at / integral_stmt / derivative_stmt 里,以前靠手写表维持;
        // 现在由语法派生,这里守的是"派生出来的表真的被着色用了".
        for (const keyword of [
            'param',
            'in',
            'cyclic',
            'animation',
            'at',
            'spherical',
            'integral',
            'derivative',
        ]) {
            expect(highlightDsl(`${keyword} x = 1;`), keyword).toContain(
                `<span class="dsl-keyword">${keyword}</span>`,
            );
        }
    });

    it('选项键只在花括号里着色', () => {
        // 对象声明行:花括号之前深度仍是 0,`c1` 不是选项名
        expect(kindsOf('curve c1 = 1 {').filter(([kind]) => kind === 'property')).toEqual([]);
        // 进入选项块之后,`ident =` 才是选项键
        expect(kindsOf('    color = "#6dd5ff";', 1)).toContainEqual(['property', 'color']);
    });

    it('花括号深度跨行累加,注释里的花括号不参与', () => {
        const state = { braceDepth: 0 };
        tokenizeDslLine('curve c1 = 1 {', state);
        expect(state.braceDepth).toBe(1);
        tokenizeDslLine('// } 只是注释里的花括号', state);
        expect(state.braceDepth).toBe(1);
        tokenizeDslLine('}', state);
        expect(state.braceDepth).toBe(0);
    });
});

describe('高亮 HTML', () => {
    it('高亮内容去掉标签后与源码逐字相同(tokens 不丢字,不吞字符)', () => {
        const source = [
            '// 中文注释 { } <>&',
            'param a = 1 in [-5, 5, 0.1];',
            'curve c1 = sin(x * a) {',
            '    color = "#6dd5ff"; // 字符串里的 // 不是注释',
            '}',
            '',
        ].join('\n');

        expect(stripHighlight(highlightDsl(source))).toBe(`${source}\n`);
    });

    it('关键字/注释/数字分别落到对应类名', () => {
        const html = highlightDsl('curve c1 = 1;\n// 说明\n');
        expect(html).toContain('<span class="dsl-keyword">curve</span>');
        expect(html).toContain('<span class="dsl-number">1</span>');
        expect(html).toContain('<span class="dsl-comment">// 说明</span>');
    });

    it('转义 & < >,不让源码破坏高亮层的 HTML', () => {
        const html = highlightDsl('x < y && z');
        expect(html).toContain('&lt;');
        // 每个 `&` 各自成 token,所以断言的是"没有裸 &"而不是"存在 &amp;&amp;"
        expect(html).toContain('&amp;');
        expect(html).not.toContain('&&');
        expect(html).not.toContain('< y');
    });

    it('整体补一个末尾换行:pre 的行盒数与 textarea 的行数一致', () => {
        // textarea 里 "a" 是 1 行,"a\n" 是 2 行;<pre> 结尾的换行不产生行盒,
        // 所以统一补一个换行,两种情况都对上.
        expect(highlightDsl('a')).toBe('a\n');
        expect(highlightDsl('a\n')).toBe('a\n\n');
    });
});

