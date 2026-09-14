/**
 * DSL 源码分词与高亮 HTML 生成(纯字符串,不碰 DOM).
 *
 * 为什么单独一层:`textarea` 只能整体着色,浏览器没有"局部着色"的输入控件,
 * 通行做法是把着色后的源码渲染到一个背景层(见 `EditorHighlight.ts`),
 * 让它透出 textarea 的文字位置.分词本身与 DOM 无关,放这里就能在 node
 * 环境直接跑单测,不必为了断言颜色去搭一棵 DOM 树.
 *
 * 语法依据是 `src/compiler/compiler_rs/src/miko.pest`(唯一真相源):
 * 这里只做**逐行**的词法着色,不做语法分析--着色错一格不影响编译,
 * 但要把注释,字符串,关键字,选项键这几类最影响阅读的部分区分出来.
 *
 * 关键字表与 `.pest` 的漂移由 `dslHighlight.test.ts` 直接读语法文件守住:
 * 语法里新增一个 `object_kind` 却忘了加进这里,测试会红.
 */

/** 一棵源码里各词法类别对应的 span 类名后缀(`dsl-<kind>`),配色在 editor.css. */
export type DslTokenKind =
    | 'comment'
    | 'string'
    | 'number'
    | 'keyword'
    | 'property'
    | 'operator'
    | 'bracket'
    | 'plain';

export interface DslToken {
    readonly kind: DslTokenKind;
    readonly text: string;
}

/**
 * 跨行扫描状态.
 *
 * 只有"选项键"这一条规则需要状态:`{ color = ...; }` 里的 `color` 是选项名,
 * 而 `curve c = 1` 里的 `c` 是对象名,二者都长成 `ident =`,只能靠花括号
 * 深度区分(DSL 里花括号只用于选项块,矩阵是方括号).
 */
export interface DslScanState {
    braceDepth: number;
}

/**
 * DSL 保留字,与 `miko.pest` 一一对应:
 * - `tensor_kind` / `object_kind` / `analysis_op` / `intersection_kind` 四个规则的全部字面量;
 * - `param` / `in` / `cyclic` / `animation` / `at` / `spherical` / `integral` / `derivative`
 *   这些直接写在规则里的字面量.
 */
export const DSL_KEYWORDS: readonly string[] = [
    'animation',
    'at',
    'box',
    'cone',
    'curl',
    'curve',
    'cyclic',
    'cylinder',
    'derivative',
    'divergence',
    'frustum',
    'gradient',
    'implicit',
    'in',
    'integral',
    'intersect',
    'intersection',
    'jacobian',
    'laplacian',
    'matrix',
    'param',
    'point',
    'region',
    'scalar',
    'sphere',
    'spherical',
    'surface',
    'transform',
    'vector',
    'vector_field',
];

const KEYWORDS = new Set(DSL_KEYWORDS);

/** 归入 `operator` 的符号:赋值/分隔与表达式里的算术,比较,逻辑符. */
const OPERATORS = '=+-*/^,;<>!&|';

/** 归入 `bracket` 的符号;花括号同时推进选项块深度. */
const BRACKETS = '{}[]()';

/** ASCII 标识符字符判定与 pest 的 `ident` 规则一致(以 `_`/字母开头). */
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

/**
 * 切一行源码.
 *
 * 顺序即优先级:`//` 注释与字符串必须先于运算符/标识符消费掉,
 * 否则 `color = "#6dd5ff";` 会从 `//` 之后被误判成注释.
 * 注释直接吃到行尾并结束本行,所以注释里的 `{` 不会污染 `braceDepth`.
 */
export function tokenizeDslLine(line: string, state: DslScanState): DslToken[] {
    const tokens: DslToken[] = [];
    let index = 0;

    while (index < line.length) {
        const char = line[index];

        if (char === ' ' || char === '\t') {
            const start = index;
            while (index < line.length && (line[index] === ' ' || line[index] === '\t')) {
                index += 1;
            }
            tokens.push({ kind: 'plain', text: line.slice(start, index) });
            continue;
        }

        if (char === '/' && line[index + 1] === '/') {
            tokens.push({ kind: 'comment', text: line.slice(index) });
            break;
        }

        if (char === '"') {
            const start = index;
            index += 1;
            while (index < line.length && line[index] !== '"') {
                // 反斜杠转义:跳过下一个字符,`"\""` 不会被提前收尾.
                if (line[index] === '\\' && index + 1 < line.length) index += 1;
                index += 1;
            }
            // 收尾引号;未闭合时停在行尾,不跨行找补(DSL 字符串本就不含换行).
            if (index < line.length) index += 1;
            tokens.push({ kind: 'string', text: line.slice(start, index) });
            continue;
        }

        if (DIGIT.test(char)) {
            const start = index;
            while (index < line.length && DIGIT.test(line[index])) index += 1;
            if (line[index] === '.' && DIGIT.test(line[index + 1] ?? '')) {
                index += 1;
                while (index < line.length && DIGIT.test(line[index])) index += 1;
            }
            tokens.push({ kind: 'number', text: line.slice(start, index) });
            continue;
        }

        if (IDENT_START.test(char)) {
            const start = index;
            index += 1;
            while (index < line.length && IDENT_PART.test(line[index])) index += 1;
            const text = line.slice(start, index);
            // 选项键优先于关键字判定:选项名一般不是保留字,但 `show = [...]`
            // 这类写法若将来把选项名取成关键字,也应显示为选项而不是保留字.
            if (state.braceDepth > 0 && /^[ \t]*=/.test(line.slice(index))) {
                tokens.push({ kind: 'property', text });
            } else if (KEYWORDS.has(text)) {
                tokens.push({ kind: 'keyword', text });
            } else {
                tokens.push({ kind: 'plain', text });
            }
            continue;
        }

        if (BRACKETS.includes(char)) {
            if (char === '{') state.braceDepth += 1;
            else if (char === '}') state.braceDepth = Math.max(0, state.braceDepth - 1);
            tokens.push({ kind: 'bracket', text: char });
            index += 1;
            continue;
        }

        if (OPERATORS.includes(char)) {
            tokens.push({ kind: 'operator', text: char });
            index += 1;
            continue;
        }

        // 其余字符(如 `:`)不改色,但仍要作为一个 token 输出,保证拼接后与原文逐字相同.
        tokens.push({ kind: 'plain', text: char });
        index += 1;
    }

    return tokens;
}

/**
 * 把整份源码渲染成高亮层的 HTML.
 *
 * 约定:每个 token 的文本都经过转义,且换行只出现在行与行之间,span 永不跨行
 * --这样高亮层的行盒与 textarea 的行一一对应,滚动时不会错位.
 *
 * 末尾补一个 `\n`:`<pre>` 里结尾的那个换行不产生行盒,而 textarea 在源码以
 * 换行结尾时确实多一行空行.不补的话高亮层比 textarea 少一行,滚到底部时
 * 最后几行会错位.
 */
export function highlightDsl(source: string): string {
    const state: DslScanState = { braceDepth: 0 };
    const rendered = source
        .split('\n')
        .map((line) => tokenizeDslLine(line, state).map(renderToken).join(''))
        .join('\n');
    return `${rendered}\n`;
}

function renderToken(token: DslToken): string {
    const text = escapeHtml(token.text);
    return token.kind === 'plain' ? text : `<span class="dsl-${token.kind}">${text}</span>`;
}

/** 高亮层走 `innerHTML`,源码里的 `&`/`<`/`>` 必须转义(注释里也可能出现). */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
