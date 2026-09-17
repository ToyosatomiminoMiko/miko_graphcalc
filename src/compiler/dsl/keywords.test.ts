/**
 * 关键字抽取器与 AST 种类常量的对账测试.
 *
 * 锁三件事:
 * 1. 抽取规则本身(用合成语法,不依赖真实 `miko.pest` 的当前内容);
 * 2. 真实语法:枚举规则的关键字与**独立实现**的正则读法一致(互为对照),
 *    内联在语句规则里的字面量也确实被收到,而且删掉分支不会有残留;
 * 3. `ast/types.ts` 的 `TENSOR_KINDS` / `OBJECT_KINDS` / `ANALYSIS_OP_KINDS`
 *    与语法分支逐字同序--AST 那三个字面量联合由这些常量派生,所以这就是
 *    "AST 类型与语法不漂移"的对账点.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { ANALYSIS_OP_KINDS, OBJECT_KINDS, TENSOR_KINDS } from '@/contract/ast';
import { DSL_KEYWORD_GROUPS, DSL_KEYWORDS, extractKeywordGroups } from './keywords';

const PEST_URL = new URL('../compiler_rs/src/miko.pest', import.meta.url);

async function readPest(): Promise<string> {
    return readFile(PEST_URL, 'utf8');
}

/** 独立实现(正则):取 `rule = { "a" | "b" }` 的全部字面量,专门与抽取器互为对照. */
function ruleLiterals(pest: string, rule: string): string[] {
    const body = new RegExp(`^${rule}\\s*=\\s*\\{([^}]*)\\}`, 'm').exec(pest)?.[1];
    expect(body, `miko.pest 里找不到规则 ${rule}`).toBeDefined();
    return [...body!.matchAll(/"([^"]*)"/g)].map((quoted) => quoted[1]);
}

describe('抽取规则(合成语法)', () => {
    it('枚举规则与单字面量原子规则都收,字符级片段不收', () => {
        const groups = extractKeywordGroups(`
// 注释里的 "ghost" 不算,注释里的花括号 { 也不算
foo_kind = { "alpha" | "beta" }
cyclic = @{ "cyclic" }
ident = @{ (ASCII_ALPHA | "_") ~ (ASCII_ALPHANUMERIC | "_")* }
comment = _{ "//" ~ (!"\\n" ~ ANY)* }
stmt = { foo_kind ~ "gamma" ~ ident ~ cyclic }
`);
        expect(groups).toEqual({
            foo_kind: ['alpha', 'beta'],
            // `cyclic` 整体就是一个字面量,所以按关键字收
            cyclic: ['cyclic'],
            // `ident` 是字符级片段:里面的 "_" 不能被当成关键字
            // `comment` 同理:里面的 "//" 不是关键字,但它必须先被正确跳过
            stmt: ['gamma'],
        });
    });

    it('注释只在字符串外生效:字符串里的 // 不会截断后面的规则', () => {
        // 这是"先按行去掉 // 再把引号配对"那类实现会踩的坑:COMMENT 规则自己
        // 就含一个 `"//"` 字面量,截断后引号失配,后面的规则全部读不到.
        const groups = extractKeywordGroups(`
comment = _{ "//" ~ (!"\\n" ~ ANY)* }
kind = { "alpha" }
`);
        expect(groups).toEqual({ kind: ['alpha'] });
    });

    it('删掉分支后关键字随之消失(不会留下幽灵关键字)', () => {
        expect(extractKeywordGroups('kind = { "alpha" | "beta" }\n').kind).toEqual([
            'alpha',
            'beta',
        ]);
        expect(extractKeywordGroups('kind = { "alpha" }\n').kind).toEqual(['alpha']);
    });
});

describe('真实 miko.pest', () => {
    it('枚举规则的关键字与独立正则读法一致', async () => {
        const pest = await readPest();
        for (const rule of ['tensor_kind', 'object_kind', 'analysis_op']) {
            expect(DSL_KEYWORD_GROUPS[rule], `miko.pest 里找不到规则 ${rule}`).toBeDefined();
            expect([...DSL_KEYWORD_GROUPS[rule]], rule).toEqual(ruleLiterals(pest, rule));
        }
    });

    it('内联在语句规则里的关键字也被收到', () => {
        // 这批字面量直接写在 param_stmt / param_ui / cyclic / animation_stmt /
        // at / spherical_at / integral_stmt / derivative_stmt 里,是旧测试漏掉的部分.
        for (const keyword of [
            'param',
            'in',
            'cyclic',
            'animation',
            'at',
            'spherical',
            'integral',
            'intersection',
            'derivative',
            'solve',
            'antiderivative',
            'ode',
        ]) {
            expect(DSL_KEYWORDS, keyword).toContain(keyword);
        }
    });

    it('扁平表就是各分组的并集(不存在第二份列表)', () => {
        expect([...DSL_KEYWORDS]).toEqual(
            [...new Set(Object.values(DSL_KEYWORD_GROUPS).flat())].sort(),
        );
    });
});

describe('AST 种类常量与语法对账', () => {
    it('三组常量与对应规则逐字同序', () => {
        const expected: ReadonlyArray<readonly [string, readonly string[]]> = [
            ['tensor_kind', TENSOR_KINDS],
            ['object_kind', OBJECT_KINDS],
            ['analysis_op', ANALYSIS_OP_KINDS],
        ];
        for (const [rule, kinds] of expected) {
            expect(DSL_KEYWORD_GROUPS[rule], `miko.pest 里找不到规则 ${rule}`).toBeDefined();
            expect([...DSL_KEYWORD_GROUPS[rule]], rule).toEqual([...kinds]);
        }
    });
});
