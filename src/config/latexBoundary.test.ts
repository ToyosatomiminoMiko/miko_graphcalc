/**
 * 公式边界:LaTeX 的**记法**归库,公式的**语义**归编译器.
 *
 * 规则分三段,前两段在别处把守,这里只管第三段:
 * 1. **排版实现**只能在库:应用不声明/不 import katex,公式 DOM 只出
 *    `createFormulaElement` -- 见 `dependencyBoundary.test.ts`;
 * 2. **数值/向量的文本口径**只能在库:应用侧只留 `numberText` /
 *    `numberVectorText` 的实例,自己算科学计数法(`toExponential`)或自己拼
 *    `\times10^{n}` 都算另起一套口径;
 * 3. **公式的领域语义**(∇/∫/∂/区域不等式/ODE 解族)留在编译器 -- 那是数学,
 *    不是 UI.搬进库会让库认识 `@/contract` 的 IR,直接撞上库自己的
 *    `domain-imports` 守卫(见 `miko_ui/scripts/check_ui_boundary.py`),所以
 *    这不是"还没搬",而是**不该搬**.
 *
 * 为什么第 3 条也要机器守:它的意义是"应用侧不出现零散的 LaTeX 字面量".
 * 一旦有人在 UI 层顺手拼一段 `\left(...\right)`,数值口径与反斜杠转义就会各写
 * 一份--ODE 解族公式的漏转义(模板字符串里 `\quad`/`\text`/`\right` 被当成
 * JS 转义吞掉,2026-10 修)就是这么发生的.这条守卫把"LaTeX 字面量只能出现在
 * 公式拼装层"钉成一张允许清单,漏了就往清单里加文件,而不是随手在别处拼.
 *
 * **射程之外(如实记下,别把"没扫描"当成"不存在")**:Rust/WASM 数学引擎
 * (`src/math/math_rs/src/symbolic/{printing,latex,ode,solve,system,integral}.rs`)
 * 自己产 LaTeX,也自带一套数字打印档(15 位定点去尾零,`pi`/`e` 保留符号形式),
 * 与库的 `numberText({ syntax: 'latex' })`(6 位 / `[1e-4, 1e6)` 外回退
 * `\times10^{n}`)不是同一档.那是 Rust crate:不能 import npm 上的库,库里也没有
 * 符号打印器,所以"表达式本体的排版"只能留在引擎里.本守卫只看 TS 侧.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../', import.meta.url);

/**
 * 允许出现 LaTeX 命令字面量与数值口径实例的文件(工作区相对路径).
 *
 * - 三个编译器拼装层:实体对象公式 / 求值条目公式 / 算子符号定义;
 * - `math/latexText.ts`:口径实例本身,它给库的向量 API 传括号与分隔符选项
 *   (`\left(` / `\right)` / `,\ `)--这是**配置**库的 API,不是另写一套排版.
 */
const LATEX_ALLOWED = [
    'src/compiler/dsl/latex.ts',
    'src/compiler/dsl/evaluationLatex.ts',
    'src/compiler/dsl/analyses.ts',
    'src/math/latexText.ts',
] as const;

/** 数值口径实例的**唯一**来源文件(只限**公式用**的 LaTeX 档). */
const NUMBER_TEXT_HOME = 'src/math/latexText.ts';

/** `src/` 下全部 `.ts`(跳过 wasm 产物目录:它不是本仓库写的代码). */
function sourceFiles(dir: URL, prefix = ''): Array<{ path: string; url: URL }> {
    const files: Array<{ path: string; url: URL }> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${prefix}${entry.name}`;
        const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
        if (entry.isDirectory()) {
            if (entry.name === 'generated') continue;
            files.push(...sourceFiles(url, `${path}/`));
        } else if (entry.name.endsWith('.ts')) {
            files.push({ path, url });
        }
    }
    return files;
}

/** 代码行(注释行不算):文件头把禁写法当数据列出来,不排掉就会自我命中. */
function codeLines(text: string): Array<{ line: string; number: number }> {
    return text.split('\n').flatMap((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            return [];
        }
        return [{ line, number: index + 1 }];
    });
}

/** 收集违例(测试文件不参与:那里的 LaTeX 是**期望值**,不是拼装). */
function offenders(pattern: RegExp, allowed: readonly string[] = []): string[] {
    const hits: string[] = [];
    for (const file of sourceFiles(new URL('src/', ROOT))) {
        if (file.path.endsWith('.test.ts')) continue;
        if (allowed.includes(`src/${file.path}`)) continue;
        for (const { line, number } of codeLines(readFileSync(file.url, 'utf8'))) {
            if (pattern.test(line)) hits.push(`src/${file.path}:${number}: ${line.trim()}`);
        }
    }
    return hits;
}

describe('公式边界:数值/向量口径归库,LaTeX 字面量归编译器', () => {
    it('公式用的 LaTeX 数值/向量口径只在 math/latexText.ts 里构造', () => {
        // 只管**公式**那一档(`syntax: 'latex'` 与向量口径):读数行另有自己的
        // 档位(如 `viewSpec.ts` 的 POINT_DISPLAY_TEXT 是 edit 档),那是控件
        // 显示/编辑的等价关系,不属于公式边界.
        const hits: string[] = [];
        for (const file of sourceFiles(new URL('src/', ROOT))) {
            if (file.path.endsWith('.test.ts')) continue;
            if (`src/${file.path}` === NUMBER_TEXT_HOME) continue;
            for (const { line, number } of codeLines(readFileSync(file.url, 'utf8'))) {
                if (/\bnumberVectorText\s*\(/.test(line) || /syntax:\s*'latex'/.test(line)) {
                    hits.push(`src/${file.path}:${number}: ${line.trim()}`);
                }
            }
        }

        expect(
            hits,
            `公式口径实例集中在 ${NUMBER_TEXT_HOME} 一处:多处各造一个 latex 实例就是"两处各记一套档位"`,
        ).toEqual([]);
    });

    it('应用侧不再自己实现"数值 -> LaTeX"(科学计数法转写)', () => {
        expect(
            offenders(/\btoExponential\s*\(/),
            '科学计数法的 LaTeX 转写归库的 numberText({ syntax: \'latex\' });应用侧只取 .toText()',
        ).toEqual([]);
        expect(
            offenders(/\\times10\^/),
            '手拼 \\times10^{n} 等于把库的口径抄了一遍,而且抄错时只有屏幕会发现',
        ).toEqual([]);
    });

    it('LaTeX 命令字面量只出现在允许清单里的公式拼装层', () => {
        // 双反斜杠才算 LaTeX 字面量:单个反斜杠是 JS 转义(`\n` / 正则的 `\s`),
        // 而**该写双反斜杠却写了单个**的坑由 latex.ts 的模板字符串注释兜住.
        expect(
            offenders(/\\\\[a-zA-Z]{2,}/, LATEX_ALLOWED),
            '公式语义留在编译器:顺手在 UI 层拼 LaTeX 会让口径与转义各写一份',
        ).toEqual([]);
    });
});
