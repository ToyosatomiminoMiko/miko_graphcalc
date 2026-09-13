/**
 * 实体 item:一个场景实体就是一行 DOM(`EntityItem`).
 *
 * 结构:
 *
 * ```text
 * <article class="object-row entity-row" role="listitem">
 *   <button class="row-visibility-btn">隐藏/显示</button>   ← ┐
 *   <span class="kind-badge kind-curve">曲线</span>          │ 第一行:
 *   <span class="object-color">                              │ 显隐 + 身份
 *     <span class="object-color-swatch"></span>              │
 *     <code class="object-color-code">#6dd5ff</code>        │
 *   </span>                                                  │
 *   <div class="object-head">                                │
 *     <strong class="object-name">c1</strong>                │
 *     <span class="row-state">已隐藏</span>                  │
 *   </div>                                                   ← ┘
 *   <code class="object-expr">...</code>                     ← 第二行:公式独占整行
 * </article>
 * ```
 *
 * 行里只有两个内容块(名称行 + 公式),都是行的**直接子节点**:`.entity-row`
 * 允许换行,`.object-expr` 的 `flex-basis` 是 100%,于是公式自己占一整行,
 * 长公式有整行宽度可用;第一行只留"显隐 + 身份 + 名字",不再与公式抢横向空间.
 *
 * 行内**没有自建的开合按钮**:实体行本来就没有可展开细节;行首的**显隐按钮**
 * 是业务动作(不渲染 + 不参与计算),点它走回调,由应用层决定的编译/渲染流程
 * 处理.按钮是内容块的同级兄弟,所以不会牵连任何开合.
 *
 * 行缓存要的"内容键"是 {@link EntityItem.cacheKey}:它必须跟着**实际渲染出来的
 * 内容**走(徽章文案 + 颜色定义 + 公式/文本 + 显隐态),列表引擎据此决定整行复用
 * 还是重建--颜色已经画在行上,所以它必须进键,否则改颜色不会刷新.
 */
import type { SceneObject } from '../../ir';
import { createFormulaElement } from '../FormulaView';
import { createElement, createVisibilityButton } from '../rowDom';
import { sceneObjectExpression, sceneObjectKindLabel } from './entityText';

export class EntityItem {
    /** 列表引擎要的句柄:行根元素. */
    readonly row: HTMLElement;

    constructor(
        object: SceneObject,
        formula: string | null,
        onToggle: () => void,
    ) {
        const row = createElement('article', 'object-row entity-row');
        row.setAttribute('role', 'listitem');
        row.classList.toggle('is-hidden', !object.enabled);

        const badge = createElement(
            'span',
            `kind-badge kind-${object.kind}`,
            sceneObjectKindLabel(object),
        );

        // 颜色定义:紧跟在类型徽章后面,同一行给"色块 + 明文值".只画色块等于
        // 只靠颜色传达信息(色觉/低对比度用户读不到),所以定义值也写出来;
        // 色块用 CSS 变量承接(见 panels.css 的 .object-color-swatch),
        // 值原样来自 IR--渲染层对颜色的接受范围与 Three.js 的 CSS 颜色一致.
        const color = createElement('span', 'object-color');
        color.setAttribute('title', `颜色 ${object.color}`);
        color.setAttribute('aria-label', `颜色 ${object.color}`);
        const swatch = createElement('span', 'object-color-swatch');
        swatch.setAttribute('aria-hidden', 'true');
        swatch.style.setProperty('--object-color', object.color);
        color.append(
            swatch,
            createElement('code', 'object-color-code', object.color),
        );

        // 名称行专属容器:第一行只放"谁是谁"(名字 + 状态芯片).公式不在这里,
        // 它是行的第二个 flex 行(见下方 append 与 panels.css 的
        // `.entity-row > .object-expr`),这样长公式能占满整行宽度.
        const name = createElement('strong', 'object-name', object.name ?? `#${object.id}`);
        const expression = formula
            ? createFormulaElement(formula, 'object-expr')
            : createElement(
                'code',
                'object-expr',
                sceneObjectExpression(object),
            );
        // 名称行(`.object-head`):对象名与状态芯片同一行,状态紧跟名字,不落到
        // 公式下面单独占一行(见 panels.css 的 `.object-head`).它是行的直接子
        // 节点:行里只有"名称行 + 公式"两个内容块,不再套一层包装.
        const head = createElement('div', 'object-head');
        head.append(name);
        // 隐藏原来只靠 is-hidden 的透明度:再补一条文字状态,色觉/低对比度
        // 用户也能看出这个对象被排除了.
        if (!object.enabled) {
            head.append(createElement('span', 'row-state', '已隐藏'));
        }

        // 行首显隐按钮:点它切换该实体是否参与渲染与计算.按钮与内容块平级,
        // 不在任何 <summary> 里(实体行也没有 <summary>),不会与列表开合互相干扰.
        const toggle = createVisibilityButton(
            object.enabled,
            object.name ?? `#${object.id}`,
            onToggle,
        );

        // 顺序即两行:`toggle + 徽章 + 颜色 + 名称行` 在第一行,公式自己占第二行.
        row.append(toggle, badge, color, head, expression);
        this.row = row;
    }

    /**
     * 实体条目的内容键:徽章文案 + 颜色定义 + 实际渲染出来的表达式/文本 + 显隐态.
     *
     * `formula` 给 null 时回退到 {@link sceneObjectExpression} 的纯文本,
     * 两种形态要分别计入键,否则"公式 -> 文本"的回退不会被重绘.
     */
    static cacheKey(object: SceneObject, formula: string | null): string {
        return JSON.stringify([
            object.kind,
            object.id,
            object.name ?? null,
            object.enabled,
            sceneObjectKindLabel(object),
            object.color,
            formula,
            formula === null ? sceneObjectExpression(object) : null,
        ]);
    }
}
