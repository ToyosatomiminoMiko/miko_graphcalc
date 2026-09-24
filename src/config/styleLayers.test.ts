import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * 样式分层契约:两层,库层在前,应用层在后.
 *
 * ```text
 *   库层  @miko/ui/styles.css     默认主题 token + 控件 + 桌面窗口 + 编辑器外壳
 *   应用层 css/*.css              应用自己的类 / id / 页面级规则
 * ```
 *
 * 顺序即层叠顺序(Vite 按 import 顺序抽成产物里的一个 `<link>`).为什么要求
 * **整层压**而不是逐份交错:交错时"谁赢"由"文件排在第几位"决定,而不是由
 * "这块样式归谁负责"决定.踩过的坑:`css/panels.css` 里的 `.row-visibility-btn`
 * 声明被排在它后面的库 `widgets.css` 盖掉,在应用里改 `background` 完全无效,
 * 而且不报错,看不出来.
 *
 * 下面三条断言把这件事从"注释里的约定"变成"会红的测试":
 *
 * 1. **入口顺序**:库层全部在前,应用层全部在后;两层的成员都写死,新增样式表
 *    必须显式决定放哪一层(库层一行是聚合入口,所以库以后加表这里不用改).
 * 2. **应用的类**:应用选择器里至少要有一个"库不拥有的类",或者干脆只用 id /
 *    元素选择器.直接给库的类写样式 = 把库的职责抄进应用.
 * 3. **不抄基线**:应用规则不许整组照抄库的按钮基线 `:where(.ui-button)` --
 *    那条基线就是"每个 `createButton` 按钮的默认外观",抄一遍不改变外观,只会
 *    让"改样式该改哪里"变成两个地方.
 *
 * 配色/token 的纪律在 `cssPalette.test.ts`,编辑器文件归属在
 * `src/editor/editorStyles.test.ts`,这里是"层"的纪律.
 */

/** 应用自己的样式表(库的不在此列).顺序 = 层叠顺序,与 `src/main.ts` 一致. */
const APP_CSS = [
    'base.css',
    'panels.css',
    'editor.css',
    'diagnostics.css',
    'process.css',
] as const;

/**
 * 库的样式表:按**包路径**解析,跟随包的 exports 映射(与 `cssPalette.test.ts`
 * 同一套写法).库层在入口里是一行聚合导入,这里仍逐份读,是为了能按文件给出
 * "是哪个类被应用重定义了"的报错.
 */
const LIB_CSS = [
    '@miko/ui/styles/tokens.css',
    '@miko/ui/styles/widgets.css',
    '@miko/ui/styles/desktop.css',
    '@miko/ui/styles/editor.css',
] as const;

const require = createRequire(import.meta.url);
const readApp = (name: string): string =>
    readFileSync(new URL(`../../css/${name}`, import.meta.url), 'utf8');
const readLib = (specifier: string): string =>
    readFileSync(require.resolve(specifier), 'utf8');
const readMain = (): string => readFileSync(new URL('../main.ts', import.meta.url), 'utf8');

function stripComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

interface CssRule {
    readonly selector: string;
    readonly declarations: readonly string[];
}

/**
 * 一份样式表里的规则.
 *
 * 两边的样式表都**没有**嵌套 at-rule(`@media` / `@keyframes` / `@supports`),
 * 所以按"选择器 + 花括号"扫一遍就够;真出现嵌套时这里会把它当成以 `@` 开头的
 * 选择器跳过,不会静默算错.
 */
function rulesOf(css: string): CssRule[] {
    const rules: CssRule[] = [];

    for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = match[1].replace(/\s+/g, ' ').trim();
        if (!selector || selector.startsWith('@')) continue;
        const declarations = match[2]
            .split(';')
            .map((declaration) => declaration.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
        rules.push({ selector, declarations });
    }
    return rules;
}

/** 规则展开成单条选择器(`, ` 分组拆开),便于逐条检查. */
function selectorsOf(css: string): string[] {
    return rulesOf(css).flatMap((rule) =>
        rule.selector
            .split(',')
            .map((selector) => selector.trim())
            .filter(Boolean),
    );
}

/** 一条选择器里出现的类名(`.a.b`,`.a > .b`,`:not(.a)` 都算). */
function classesOf(selector: string): string[] {
    return [...selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]);
}

describe('样式分层', () => {
    it('入口顺序:库层全部在前,应用层全部在后', () => {
        // 顺序即层叠顺序,所以这里连成员带次序一起钉死:新增一份样式表必须自己
        // 决定放哪一层,不能随手插到中间(插进去就可能让别人的声明静默失效).
        const imported = [...readMain().matchAll(/^import\s+'([^']+\.css)';/gm)].map(
            (match) => match[1],
        );

        expect(imported).toEqual([
            '@miko/ui/styles.css',
            ...APP_CSS.map((name) => `../css/${name}`),
        ]);
    });

    it('应用不给库的类定样式(选择器里必须有库不拥有的类,或只用 id/元素)', () => {
        const libClasses = new Set(
            LIB_CSS.flatMap((specifier) => selectorsOf(readLib(specifier))).flatMap(classesOf),
        );
        const offenders: string[] = [];

        for (const name of APP_CSS) {
            for (const selector of selectorsOf(readApp(name))) {
                const classes = classesOf(selector);
                // 没有类的选择器(`*` / `html, body` / `#app` / `#viewport`)是应用
                // 自己的页面级宿主,库的样式表里没有 id 选择器,放行.
                if (classes.length === 0) continue;
                if (classes.every((className) => libClasses.has(className))) {
                    offenders.push(`css/${name}: ${selector}`);
                }
            }
        }

        expect(
            offenders,
            '这些规则只写库的类:要改外观就改库(库的 tokens 或库的变体),或给节点加一个应用自有的类只写增量',
        ).toEqual([]);
    });

    it('应用规则不整组照抄库的按钮基线', () => {
        // 库把 `createButton` 的默认外观写成零优先级的 `:where(.ui-button*)`,
        // 正是为了让消费方无需关心加载顺序就能覆盖它.照抄一遍等于零收益.
        const baseline = new Set(
            LIB_CSS.flatMap((specifier) => rulesOf(readLib(specifier)))
                .filter((rule) => rule.selector.includes('ui-button'))
                .flatMap((rule) => rule.declarations),
        );
        const offenders: string[] = [];

        for (const name of APP_CSS) {
            for (const rule of rulesOf(readApp(name))) {
                // 门槛取 5:少于 5 条的规则与基线撞车多半是巧合(比如只有一条
                // `overflow`),而"照抄基线"必然是整组(基线本身就有 11 条).
                const copied =
                    rule.declarations.length >= 5 &&
                    rule.declarations.every((declaration) => baseline.has(declaration));
                if (copied) {
                    offenders.push(`css/${name}: ${rule.selector}(${rule.declarations.length} 条)`);
                }
            }
        }

        expect(
            offenders,
            '这些规则逐条重复了库的按钮基线:库已经给所有 createButton 的按钮这份默认外观,要变体就只写差异',
        ).toEqual([]);
    });
});
