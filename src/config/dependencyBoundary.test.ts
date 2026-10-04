/**
 * 依赖边界:本项目**不直接依赖 katex**(公式显示全部归 `miko_ui`).
 *
 * 规矩只有一句,但要机器能查,否则它会悄悄长回来 -- 四条残迹各自都"看起来无害":
 * 一次 `npm i katex`,一次 `vi.mock('katex')`,一条 `dedupe`,一条给公式内部
 * 选择器写的字号规则.
 *
 * 1. **声明**:`package.json` 的 `dependencies` / `devDependencies` 里没有
 *    `katex` / `@types/katex`.库(`miko_ui`)自己带着 katex(在它的
 *    `dependencies` 里,不是可选 peer),应用侧只经库间接拿到它.
 * 2. **代码**:`src/` 里没有 `import ... from 'katex'` / `import 'katex/...'` /
 *    `vi.mock('katex')` / `require('katex')`.测试里更不许 mock 它:库的
 *    `installDomStub()` 会装上文本替身渲染器(`TEXT_FORMULA_RENDERER`),
 *    `vi.mock('katex')` 是绕开库,把"直接依赖 katex"恢复回来的写法.
 * 3. **打包**:`vite.config.ts` 的 `resolve.dedupe` 里没有 `'katex'` -- 那条
 *    dedupe 原本只为"让 `vi.mock('katex')` 拦得住库"存在,第 2 条一落地它
 *    就是多余的.
 * 4. **样式**:`css/` 里没有 `.katex` 选择器(公式内部 DOM 归库的
 *    `.ui-formula > .katex`),字号只准经库的令牌 `--katex-font-size` 设置,
 *    且写入**恰好一处**.这条不是洁癖:应用写成单类 `.katex` 会与
 *    `katex.min.css` 同特异度,又排在前面的关系**静默失效**(库的样式排在前),
 *    而删掉唯一那处写入会把公式从 24px 静默缩到库默认的 19.36px.
 *
 * 注释与文档里的"KaTeX"不受这条守卫管:公式仍然由 KaTeX 排版,只是那件事
 * 在库里面,应用不需要知道它.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../', import.meta.url);

function readRoot(name: string): string {
    return readFileSync(new URL(name, ROOT), 'utf8');
}

/** 直接依赖 katex 的**代码**写法;注释,文档,变量名都不算. */
const KATEX_CODE = [
    /from\s+['"]katex(?:\/[^'"]*)?['"]/,
    /import\s+['"]katex(?:\/[^'"]*)?['"]/,
    /require\(\s*['"]katex(?:\/[^'"]*)?['"]\s*\)/,
    /vi\.mock\(\s*['"]katex(?:\/[^'"]*)?['"]/,
] as const;

/** 应用自己的样式表(库的不在此列,与 `styleLayers.test.ts` 同一份清单). */
const APP_CSS = ['base.css', 'panels.css', 'editor.css', 'process.css'] as const;

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

describe('依赖边界:katex 只经 miko_ui 间接依赖', () => {
    it('package.json 不声明 katex / @types/katex', () => {
        const pkg = JSON.parse(readRoot('package.json')) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        const declared = [
            ...Object.keys(pkg.dependencies ?? {}),
            ...Object.keys(pkg.devDependencies ?? {}),
        ];

        expect(declared.filter((name) => name.includes('katex'))).toEqual([]);
    });

    it('src/ 里不出现 katex 的 import / require / mock', () => {
        const offenders: string[] = [];
        for (const file of sourceFiles(new URL('src/', ROOT))) {
            const text = readFileSync(file.url, 'utf8');
            text.split('\n').forEach((line, index) => {
                // 注释行放行:口径是"代码里不许依赖",而本文件自己的文件头正是
                // 把这几条禁写法当数据列出来,不排掉就会自我命中.
                const trimmed = line.trim();
                if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
                if (KATEX_CODE.some((pattern) => pattern.test(line))) {
                    offenders.push(`src/${file.path}:${index + 1}: ${trimmed}`);
                }
            });
        }

        expect(
            offenders,
            '公式排版归库(miko_ui):应用只调用 createFormulaElement 之类出口,测试靠 installDomStub() 装的文本替身渲染器',
        ).toEqual([]);
    });

    it('vite.config.ts 的 resolve.dedupe 里没有 katex', () => {
        const config = readRoot('vite.config.ts');
        const dedupe = /dedupe\s*:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? '';

        expect(dedupe).not.toMatch(/['"]katex['"]/);
        // 顺带钉住"dedupe 还在,且钉的是信号库":删空数组不算通过.
        expect(dedupe).toMatch(/['"]@preact\/signals-core['"]/);
    });

    it('样式接缝:应用 CSS 不碰公式内部选择器,字号令牌恰好一处写入', () => {
        // (a) 应用样式表里不出现 `.katex` 选择器.公式内部 DOM(以及它的字号与配色)
        //     归库:库的 `styles/widgets.css` 用 `.ui-formula > .katex`(0,2,0)读
        //     自己的令牌.应用再写一份是重复实现,而且改成单类选择器时会**静默
        //     输给** `katex.min.css` 的 `.katex`(同特异度,库的样式排在前面).
        const cssOffenders: string[] = [];
        for (const name of APP_CSS) {
            const css = readRoot(`css/${name}`).replace(/\/\*[\s\S]*?\*\//g, '');
            if (/\.katex\b/.test(css)) cssOffenders.push(`css/${name}`);
        }
        expect(
            cssOffenders,
            '公式内部选择器归库:miko_ui/styles/widgets.css 的 .ui-formula > .katex 读 --katex-font-size,应用只需给公式根节点一个自己的类',
        ).toEqual([]);

        // (b) 字号令牌的**写入**恰好一处(`applyUiConfig` 把 UI_CONFIG 翻译成变量).
        //     放宽成 0 处是不行的:库的默认档是 1.21em(KaTeX 自带),删掉这一处
        //     公式会从 24px 静默缩到 19.36px.真要换成库默认档,就同时改这条断言.
        const writes: string[] = [];
        for (const file of sourceFiles(new URL('src/', ROOT))) {
            readFileSync(file.url, 'utf8')
                .split('\n')
                .forEach((line, index) => {
                    if (/['"]--katex-font-size['"]\s*:/.test(line)) {
                        writes.push(`src/${file.path}:${index + 1}`);
                    }
                });
        }
        expect(writes).toHaveLength(1);
        expect(writes[0]).toContain('app/applyUiConfig.ts');
    });
});
