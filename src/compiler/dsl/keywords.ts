/**
 * DSL 关键字表的唯一来源:直接从 `miko.pest` 派生,不再手工维护第二份列表.
 *
 * 为什么派生而不是"手写表 + 测试对账":手写表的漂移只能被测试事后发现,而且只
 * 覆盖得住测试写到的地方;派生之后关键字表是语法的函数,新增一个 `object_kind`
 * 分支不需要改任何 TS.
 *
 * 时机:`.pest` 的读取发生在构建期(Vite 的 `?raw` 把它内联成字符串常量),
 * 但**抽取发生在运行期**--本模块第一次被 import 时执行一次(主 bundle 静态
 * 依赖链 DslApp -> EditorHighlight -> dslHighlight -> 这里,所以是页面加载时).
 * 这条链的好处是改语法会触发 HMR,不必跑任何生成脚本;代价是语法内容写坏时
 * 构建不会红,只能靠 `keywords.test.ts` 在 CI 里抓住.
 *
 * 抽取规则(只认语法里真正处于关键字位置的字面量):
 * 1. 先做一次字符串感知的词法扫描:注释只在字符串 **外** 生效.
 *    (别用"先按行去掉 // 再找引号"的正则:`COMMENT = _{ "//" ~ ... }` 里的
 *    `"//"` 会把那一行截断,后面全部错位--实测会把关键字表清空.)
 * 2. 逐规则取体:
 *    - 非原子规则:体内所有"标识符形状"的字面量都算关键字(枚举规则的分支,
 *      以及 `param` / `in` / `animation` / `at` / `spherical` 这些内联字面量);
 *    - 原子规则(`@{ ... }`)是字符级片段,只有"整个规则体就是一个标识符字面量"
 *      时才算(`cyclic = @{ "cyclic" }`),否则 `ident` 里的 `"_"` 会被误收.
 *
 * 两条隐含约定(改语法时要注意):
 * - 规则头必须写在行首(允许缩进),这也是本语法文件的既有写法;
 * - 形如 `x = { ident ~ "something" }` 的标识符字面量会**自动**进入关键字表.
 *   这通常正是期望(它确实是语法关键字);若某个字面量只是占位而非关键字,
 *   需要在抽取器里显式排除.
 */
import pestSource from '@/compiler/compiler_rs/src/miko.pest?raw';

/** pest 源码里的一个字符串字面量;`[start, end)` 是含引号的原文区间. */
interface PestLiteral {
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

/** pest 里的一条规则:名字,是否原子,以及规则体的区间. */
interface PestRule {
    readonly name: string;
    readonly atomic: boolean;
    readonly bodyStart: number;
    readonly bodyEnd: number;
}

/** 规则头 `name = @{`;只允许出现在行首(允许缩进),避免匹配到规则体内部的 `=`. */
const RULE_HEAD = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([@$]?)\s*\{/;

/** 标识符形状的字面量才算关键字;`"{"` / `" in"` / `"//"` 这类一律不算. */
const IDENT_LITERAL = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 单遍扫描:抽出全部字符串字面量,以及每条规则的体区间.
 *
 * 括号深度只统计 **字符串外** 的花括号:规则体里的 `"{"` / `"}"` 字面量被整体
 * 消费,不会污染计数(靠 `"{"` 与 `"}"` 数量相抵是巧合,不可依赖).
 */
function scanPest(source: string): { rules: PestRule[]; literals: PestLiteral[] } {
    const rules: PestRule[] = [];
    const literals: PestLiteral[] = [];
    let index = 0;
    let lineStart = true;
    let open: { rule: PestRule; depth: number } | null = null;

    while (index < source.length) {
        const char = source[index];

        if (char === '\n') {
            lineStart = true;
            index += 1;
            continue;
        }
        if (char === ' ' || char === '\t') {
            index += 1;
            continue;
        }

        if (char === '/' && source[index + 1] === '/') {
            while (index < source.length && source[index] !== '\n') index += 1;
            continue;
        }

        if (char === '"') {
            const start = index;
            let text = '';
            index += 1;
            while (index < source.length && source[index] !== '"') {
                if (source[index] === '\\' && index + 1 < source.length) {
                    text += source[index] + source[index + 1];
                    index += 2;
                    continue;
                }
                text += source[index];
                index += 1;
            }
            literals.push({ start, end: index + 1, text });
            index += 1;
            lineStart = false;
            continue;
        }

        if (open === null && lineStart) {
            const head = RULE_HEAD.exec(source.slice(index));
            if (head) {
                const bodyStart = index + head[0].length - 1;
                open = {
                    rule: { name: head[1], atomic: head[2] !== '', bodyStart, bodyEnd: -1 },
                    depth: 1,
                };
                index = bodyStart + 1;
                lineStart = false;
                continue;
            }
        }

        if (char === '{') {
            if (open) open.depth += 1;
            index += 1;
            lineStart = false;
            continue;
        }
        if (char === '}') {
            if (open) {
                open.depth -= 1;
                if (open.depth === 0) {
                    rules.push({ ...open.rule, bodyEnd: index });
                    open = null;
                }
            }
            index += 1;
            lineStart = false;
            continue;
        }

        index += 1;
        lineStart = false;
    }

    return { rules, literals };
}

/**
 * 抽出"规则名 -> 该规则承载的关键字"(保持语法里的出现顺序).
 *
 * 只有真正带关键字的规则会出现在结果里:漏掉规则名比多一个 `undefined` 更好排查.
 * 导出是为了让单测能拿合成语法验证抽取规则,而不是只能对着真实语法自证.
 */
export function extractKeywordGroups(rawSource: string): Record<string, readonly string[]> {
    const { rules, literals } = scanPest(rawSource);
    const groups: Record<string, string[]> = {};

    for (const rule of rules) {
        const inside = literals.filter(
            (literal) => literal.start > rule.bodyStart && literal.end <= rule.bodyEnd,
        );
        const accepted =
            rule.atomic && !(inside.length === 1 && IDENT_LITERAL.test(inside[0].text))
                ? []
                : inside;
        const words = accepted
            .filter((literal) => IDENT_LITERAL.test(literal.text))
            .map((literal) => literal.text);
        if (words.length > 0) groups[rule.name] = words;
    }

    return groups;
}

/** 规则名 -> 关键字;`tensor_kind` / `object_kind` 这类分组给 AST 种类常量对账用. */
export const DSL_KEYWORD_GROUPS: Record<string, readonly string[]> =
    extractKeywordGroups(pestSource);

// 真语法永远非空:一条规则都没抽到说明 `.pest` 被改坏或换了路径.这里不 throw
// (那会让编辑器整体起不来),硬失败交给 keywords.test.ts 的断言,只在控制台留痕.
if (Object.keys(DSL_KEYWORD_GROUPS).length === 0) {
    console.error('[dslKeywords] miko.pest 里没抽到任何关键字规则,文件高亮会整体失效');
}

/** 高亮层用的扁平表:所有分组的并集,去重后排序. */
export const DSL_KEYWORDS: readonly string[] = [
    ...new Set(Object.values(DSL_KEYWORD_GROUPS).flat()),
].sort();
