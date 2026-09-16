/**
 * 实体 item:一个场景实体就是一行 DOM(`EntityItem`).
 *
 * 结构:
 *
 * ```text
 * <article class="object-row entity-row" role="listitem">
 *   <div class="row-main">                                  ← ┐ 主内容
 *     <span class="kind-badge kind-curve">曲线</span>        │ 第一行:
 *     <span class="object-color">                           │ 身份 + 名字
 *       <span class="object-color-swatch"></span>            │
 *       <code class="object-color-code">#6dd5ff</code>      │
 *     </span>                                               │
 *     <div class="object-head">                             │
 *       <strong class="object-name">c1</strong>             │
 *       <span class="row-state">已隐藏</span>               │
 *     </div>                                                │
 *     <code class="object-expr">...</code>                  │ 第二行:公式独占整行
 *   </div>                                                  ← ┘
 *   <div class="row-actions">                               ← 行末,靠右
 *     <button class="row-visibility-btn">隐藏/显示</button>
 *   </div>
 * </article>
 * ```
 *
 * `.row-main` 是除行末动作外的全部内容,内部沿用"可换行横排":`.object-expr`
 * 的 `flex-basis` 是 100%,于是公式自己占一整行,长公式有整行宽度可用;
 * 第一行只留"身份 + 名字",不再与公式抢横向空间.包装层把行分成"主内容 +
 * 动作"两个直接子节点,动作区因此在 DOM 里就在末位,视觉上贴右,见
 * {@link createObjectRow}.
 *
 * 行内**没有自建的开合按钮**:实体行本来就没有可展开细节;行末的**显隐按钮**
 * 是业务动作(不渲染 + 不参与计算),点它走回调,由应用层决定的编译/渲染流程
 * 处理.按钮与主内容同级,且不在任何 `<summary>` 内,所以不会牵连任何开合.
 *
 * 行缓存要的"内容键"是 {@link EntityItem.cacheKey}:它必须跟着**实际渲染出来的
 * 内容**走(徽章文案 + 颜色定义 + 公式/文本 + 显隐态),列表引擎据此决定整行复用
 * 还是重建--颜色已经画在行上,所以它必须进键,否则改颜色不会刷新.
 */
import type { SceneObject } from '../../ir';
import { createFormulaElement } from '../formula/FormulaView';
import { createObjectRow, createRowActions, createVisibilityButton } from '../shared/rowDom';
import { el } from '../widgets/dom';
import { sceneObjectExpression, sceneObjectKindLabel } from './entityText';

export class EntityItem {
    /** 列表引擎要的句柄:行根元素. */
    readonly row: HTMLElement;

    constructor(
        object: SceneObject,
        formula: string | null,
        onToggle: () => void,
    ) {
        const badge = el('span', {
            class: `kind-badge kind-${object.kind}`,
            text: sceneObjectKindLabel(object),
        });

        // 颜色定义:紧跟在类型徽章后面,同一行给"色块 + 明文值".只画色块等于
        // 只靠颜色传达信息(色觉/低对比度用户读不到),所以定义值也写出来;
        // 色块用 CSS 变量承接(见 panels.css 的 .object-color-swatch),
        // 值原样来自 IR--渲染层对颜色的接受范围与 Three.js 的 CSS 颜色一致.
        const color = el('span', { class: 'object-color' });
        color.setAttribute('title', `颜色 ${object.color}`);
        color.setAttribute('aria-label', `颜色 ${object.color}`);
        const swatch = el('span', { class: 'object-color-swatch' });
        swatch.setAttribute('aria-hidden', 'true');
        swatch.style.setProperty('--object-color', object.color);
        color.append(
            swatch,
            el('code', { class: 'object-color-code', text: object.color }),
        );

        // 名称行专属容器:第一行只放"谁是谁"(名字 + 状态芯片).公式不在这里,
        // 它是 `.row-main` 里的第二个 flex 行(见下方 append 与 panels.css 的
        // `.entity-row > .row-main > .object-expr`),这样长公式能占满整行宽度.
        const name = el('strong', {
            class: 'object-name',
            text: object.name ?? `#${object.id}`,
        });
        const expression = formula
            ? createFormulaElement(formula, 'object-expr')
            : el('code', {
                class: 'object-expr',
                text: sceneObjectExpression(object),
            });
        // 名称行(`.object-head`):对象名与状态芯片同一行,状态紧跟名字,不落到
        // 公式下面单独占一行(见 panels.css 的 `.object-head`).它与徽章/颜色/
        // 公式同处 `.row-main`,是把显隐按钮让到行末的那层包装.
        const head = el('div', { class: 'object-head' });
        head.append(name);
        // 隐藏原来只靠 is-hidden 的透明度:再补一条文字状态,色觉/低对比度
        // 用户也能看出这个对象被排除了.
        if (!object.enabled) {
            head.append(el('span', { class: 'row-state', text: '已隐藏' }));
        }

        // 行末显隐按钮:点它切换该实体是否参与渲染与计算.按钮与主内容包装
        // `.row-main` 平级(见 createObjectRow),不在任何 <summary> 里
        // (实体行也没有 <summary>),不会与列表开合互相干扰.
        const toggle = createVisibilityButton(
            object.enabled,
            object.name ?? `#${object.id}`,
            onToggle,
        );

        // 主内容内部顺序即两行:`徽章 + 颜色 + 名称行` 在第一行,公式自己占
        // 第二行;按钮由 createObjectRow 放在行末.
        const { row, main } = createObjectRow('entity-row', createRowActions(toggle));
        main.append(badge, color, head, expression);
        row.classList.toggle('is-hidden', !object.enabled);
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
