/**
 * KaTeX 公式 DOM 工具.
 *
 * KaTeX 只负责把 LaTeX 字符串排版成 HTML;DSL 文本永远不要直接用
 * innerHTML 注入,统一走 `katex.render` 的转义输出.
 */
import katex from 'katex';
import 'katex/dist/katex.min.css';

/**
 * @cache
 * 缓存目的:同一 LaTeX 字符串在参数刷新时反复出现,KaTeX 排版结果不变,
 * 直接 clone 模板,避免每次重绘都调用 katex.render 重建整棵 DOM.
 * 键/失效策略:LaTeX 字符串 -> 无 class 的 span 模板;先进先出,超过上限
 * 淘汰最早的一条--积分结果把数值拼进 LaTeX,键不是有限集合,必须有界.
 * 生命周期:模块级,跟随页面存活.
 */
const formulaTemplateCache = new Map<string, HTMLElement>();

/**
 * 模板缓存上限.
 *
 * 实体/分析/细节公式的键是有限集合,但积分结果行是 `∫f dx = 数值`,
 * 数值每帧都可能不同;不设上限就是只增不回收的泄漏.热点公式会被反复
 * 回写,所以容量取一个远大于单屏公式数的值即可.
 */
const FORMULA_TEMPLATE_CACHE_LIMIT = 512;

/** 可复制公式的屏幕阅读器名称(`aria-label` 不画 hover 浮层,标题类提示才画). */
const COPY_FORMULA_LABEL = '复制公式 TeX';

function cacheTemplate(latex: string, template: HTMLElement): void {
    if (formulaTemplateCache.size >= FORMULA_TEMPLATE_CACHE_LIMIT) {
        const oldest = formulaTemplateCache.keys().next().value;
        if (oldest !== undefined) formulaTemplateCache.delete(oldest);
    }
    formulaTemplateCache.set(latex, template);
}

/** LaTeX -> 排版结果,写进传入元素.`throwOnError: false` 让排不出来的公式退化成源码文本. */
function renderLatex(
    latex: string,
    element: HTMLElement,
    displayMode = false,
): void {
    katex.render(latex, element, {
        displayMode,
        throwOnError: false,
        trust: false,
    });
}

/**
 * 把公式直接渲染进**已有元素**(元素自身就是公式根节点).
 *
 * 用在公式行/结果行:元素自己承载 KaTeX 输出,而不是再套一层 span--
 * 过去那里会同时出现 `class="eval-result is-ready"` 的外层和带 `katex` 类的
 * 内层,类名看着重复.
 *
 * 模板必须 **clone 而不是搬运**:`replaceChildren` 会把已经有父节点的子节点
 * 先从旧父节点摘除再插入,直接传 `template.childNodes` 会把缓存模板搬空,
 * 同一串 LaTeX 第二次渲染就是空白(实体/分析/积分公式全线命中).
 */
function renderLatexInto(latex: string, element: HTMLElement): void {
    let template = formulaTemplateCache.get(latex);
    if (!template) {
        template = document.createElement('span');
        renderLatex(latex, template);
        cacheTemplate(latex, template);
    }
    const clone = template.cloneNode(true) as HTMLElement;
    element.replaceChildren(...clone.childNodes);
}

/**
 * LaTeX -> 公式 DOM.
 *
 * `copyable` 控制是否挂 `data-tex`(FormulaCopyController 的复制钩子):
 * - 实体对象公式,展开细节里的公式:可复制(缺省);
 * - 求值条目的**摘要行**公式:不可复制--摘要行本身是 `<details>` 的原生开合
 *   热区,点它是"展开/收起",不该顺手把 TeX 写进剪贴板.
 *
 * 可复制 = 可聚焦(UI-P3.6):除 `data-tex` 外补 `tabindex="0"` 与 `role`/
 * `aria-label`,复制因此有键盘入口(FormulaCopyController 同时监听 Enter/Space).
 * 不可复制时这些属性一个都不加:摘要行里的公式处在 `<summary>` 内部,再塞一个
 * 可聚焦控件会造成嵌套交互元素.
 */
export function createFormulaElement(
    latex: string,
    className?: string,
    copyable = true,
): HTMLElement {
    const element = document.createElement('span');
    if (className) element.className = className;
    renderLatexInto(latex, element);

    if (copyable) {
        element.dataset.tex = latex;
        element.tabIndex = 0;
        element.setAttribute('role', 'button');
        element.setAttribute('aria-label', COPY_FORMULA_LABEL);
    }
    return element;
}
