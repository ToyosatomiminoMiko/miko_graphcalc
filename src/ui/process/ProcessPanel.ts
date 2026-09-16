/**
 * 过程页视图(右栏"过程"标签页的内容).
 *
 * 一行一步的递等式:序号 + 一行 KaTeX + 依据徽章,当前步高亮,其余降饱和度;
 * 点击任意行跳转,`上一个 / 下一个` 与键盘左右方向键翻步.
 *
 * 几条刻意的不变量:
 * - **状态机是纯的**(`processState.ts`),本类只负责把状态写成 DOM:高亮只改
 *   类名,不重建行(见 `keyedRowList` 的复用约定与 `stepRows`);
 * - **出口只有一个** `onStepChange(index)`:一期没有订阅者(高亮计数由本类
 *   写),二期把第 k 步当成虚拟参数驱动几何时接在这里,前端不必重做(见设计
 *   文档第 4.3 节);
 * - **键盘不在这里绑 document**:`keyboardBinding()` 交给全应用唯一的
 *   `KeyboardController` 注册;本类自己只在步骤行上绑点击;
 * - 空过程给一句明文,超长过程截断并注明,隐藏对象不生成过程(入口置灰的理由
 *   由条目给,见 `evaluation/evaluationDom.ts`).
 *
 * 公式沿用 `FormulaView`(KaTeX 不换行,排不下由该行横向滚动),模板缓存上限
 * 不在这里扩:步骤 LaTeX 键是"表达式签名 × 步数",是有限集合.
 */
import { UI_CONFIG } from '../../config/uiConfig';
import type { KeyboardBinding } from '../shared/KeyboardController';
import { isTypingTarget } from '../shared/KeyboardController';
import { createFormulaElement } from '../formula/FormulaView';
import { KeyedRowList, type KeyedRowHandles } from '../shared/keyedRowList';
import { createButton, type ButtonHandle } from '../widgets/Button';
import { el } from '../widgets/dom';
import {
    EMPTY_PROCESS_INDEX,
    clampProcessIndex,
    createProcessState,
    processGoto,
    processIndexChanged,
    processNext,
    processPrev,
    type ProcessState,
} from './processState';
import {
    PROCESS_STEP_KIND_LABELS,
    partitionStepsByKind,
    type ProcessDocument,
    type ProcessStep,
} from './processSteps';

export interface ProcessPanelHandlers {
    /**
     * 当前步变化的唯一出口.
     *
     * **一期没有订阅者**:高亮与计数是面板自己写的,这个出口是二期"把第 k 步
     * 当成虚拟参数驱动几何"(割线->切线,黎曼矩形加细)的指定接入点,因此这里
     * **只发索引**,不发公式--二期不必改签名,只加一个消费者.接口按二期需要
     * 定是一次性决定(见 docs/equation-solving-process.md 4.3 / 6).
     */
    onStepChange?(index: number): void;
}

export interface ProcessPanelOptions extends ProcessPanelHandlers {
    /** 当前参数的只读回显(R6);缺省不显示.每次刷新都会调用一次. */
    readonly getParamEcho?: () => string;
}

/** 列表引擎要的句柄:一行步骤只有根元素. */
interface ProcessStepRow extends KeyedRowHandles {
    readonly row: HTMLElement;
}

/** 步骤 + 它在文档里的下标(行缓存的键必须能区分同内容不同位置的两步). */
interface IndexedStep {
    readonly index: number;
    readonly step: ProcessStep;
}

const EMPTY_TEXT = '该对象没有可展开的过程';

/** 参数只读回显的文本:一行 `a=1 · b=2`;没有参数时返回空串(调用方隐藏). */
export function formatProcessParamEcho(values: Readonly<Record<string, number>>): string {
    return Object.entries(values)
        .map(([name, value]) => `${name}=${value}`)
        .join(' · ');
}

function setHidden(element: HTMLElement, hidden: boolean): void {
    if (hidden) element.setAttribute('hidden', '');
    else element.removeAttribute('hidden');
}

/** 事件目标是否落在标签栏里:那里方向键有自己的语义(切换标签). */
function isInsideTablist(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return target.closest('[role="tablist"]') !== null;
}

export class ProcessPanel {
    private readonly list: KeyedRowList<IndexedStep, ProcessStepRow>;
    private readonly title: HTMLElement;
    private readonly legend: HTMLElement;
    private readonly counter: HTMLElement;
    private readonly problem: HTMLElement;
    private readonly echo: HTMLElement;
    private readonly empty: HTMLElement;
    private readonly truncated: HTMLElement;
    private readonly stepsContainer: HTMLElement;
    private readonly prevButton: ButtonHandle;
    private readonly nextButton: ButtonHandle;

    /**
     * 当前步骤行,下标即步骤下标(与文档里的顺序一一对应).
     *
     * 高亮是每步都跑的热路径:留一份行引用就不必每次 `querySelectorAll` 全表
     * 扫描(见 `_applyIndex`);`show()`/`clear()` 是它唯一的重建点.
     */
    private stepRows: HTMLElement[] = [];
    private document: ProcessDocument | null = null;
    private state: ProcessState = createProcessState(0);

    constructor(
        private readonly root: HTMLElement,
        private readonly options: ProcessPanelOptions = {},
    ) {
        this.title = el('span', { class: 'process-title', text: '过程' });
        this.legend = el('span', { class: 'process-legend' });
        this.counter = el('span', { class: 'process-counter' });
        // 题目区:过程页先给"在解什么",再给步骤(见 ProcessDocument.problem).
        this.problem = el('div', { class: 'process-problem' });
        setHidden(this.problem, true);
        this.echo = el('div', { class: 'process-param-echo' });
        setHidden(this.echo, true);

        this.prevButton = createButton({
            class: 'process-nav-btn',
            text: '上一个',
            ariaLabel: '上一步',
        });
        this.nextButton = createButton({
            class: 'process-nav-btn',
            text: '下一个',
            ariaLabel: '下一步',
        });
        this.prevButton.onClick(() => this.prev());
        this.nextButton.onClick(() => this.next());

        const header = el(
            'div',
            { class: 'process-header' },
            el('div', { class: 'process-heading' }, this.title, this.legend),
            el(
                'div',
                { class: 'process-nav' },
                this.prevButton.element,
                this.counter,
                this.nextButton.element,
            ),
            this.problem,
            this.echo,
        );

        this.empty = el('p', { class: 'process-empty', text: EMPTY_TEXT });
        this.truncated = el('p', { class: 'process-truncated' });
        setHidden(this.truncated, true);

        this.stepsContainer = el('div', { class: 'process-steps' });
        // KeyedRowList 构造时会给容器加 role="list"(与两个对象列表同一约定).
        this.list = new KeyedRowList<IndexedStep, ProcessStepRow>(this.stepsContainer);

        this.root.replaceChildren(header, this.empty, this.stepsContainer, this.truncated);
        this._renderEmptyState();
    }

    /**
     * 载入一条过程:重建步骤行(按指纹复用)并把游标复位到第一步.
     *
     * `onStepChange(0)` 也会发出:消费者据此把几何切到整条过程的起点,而不是
     * 沿用上一条过程停下的那一步.
     */
    show(doc: ProcessDocument): void {
        this.document = doc;
        this.title.textContent = doc.title;

        const indexed: IndexedStep[] = doc.steps.map((step, index) => ({ index, step }));
        this.stepRows = [];
        this.list.sync(indexed, {
            name: (entry) => String(entry.index),
            key: (entry) => `${entry.step.latex}|${entry.step.kind}|${entry.step.reason}`,
            build: (entry) => this._buildStepRow(entry),
        });

        this.state = createProcessState(doc.steps.length);
        this._renderProblem(doc.problem ?? null);
        this._renderMeta(doc);
        this._renderEmptyState();
        this._applyIndex(this.state.index);
    }

    /** 清空过程:回到空状态明文,不留下上一条的步骤与标题. */
    clear(): void {
        this.document = null;
        this.stepRows = [];
        this.list.clear();
        this.state = createProcessState(0);
        this.title.textContent = '过程';
        this.legend.textContent = '';
        this.counter.textContent = '';
        this._renderProblem(null);
        this._refreshEcho();
        this._renderEmptyState();
    }

    next(): void {
        const next = processNext(this.state);
        if (!processIndexChanged(this.state, next)) return;
        this._applyIndex(next.index);
    }

    prev(): void {
        const next = processPrev(this.state);
        if (!processIndexChanged(this.state, next)) return;
        this._applyIndex(next.index);
    }

    goto(index: number): void {
        const next = processGoto(this.state, index);
        if (!processIndexChanged(this.state, next)) return;
        this._applyIndex(next.index);
    }

    /**
     * 键盘入口:过程页激活且已载入步骤时,左右方向键翻步.
     *
     * 焦点在编辑器/输入框(让位给光标移动)或标签栏(方向键切换标签)里时
     * 返回 null,不抢它们的方向键.
     */
    keyboardBinding(isActive: () => boolean): KeyboardBinding {
        return {
            keys: ['ArrowLeft', 'ArrowRight'],
            resolve: (event) => {
                if (!isActive()) return null;
                if (this.document === null || this.state.stepCount === 0) return null;
                if (isTypingTarget(event.target) || isInsideTablist(event.target)) return null;
                return event.key === 'ArrowLeft' ? () => this.prev() : () => this.next();
            },
        };
    }

    /** 解绑导航按钮的监听;DOM 由调用方随面板一起丢弃. */
    dispose(): void {
        this.prevButton.dispose();
        this.nextButton.dispose();
        this.list.clear();
    }

    /**
     * 刷新参数只读回显.
     *
     * 参数只在参数页被改,过程页在前时看不到;切回过程页要重新拉一次,否则回显
     * 停在上次离开时的值.单独开这个入口而不是让调用方重载过程:重载会把当前步
     * 复位到第 0 步.
     */
    refreshEcho(): void {
        this._refreshEcho();
    }

    private _buildStepRow(entry: IndexedStep): ProcessStepRow {
        const formula = createFormulaElement(entry.step.latex, 'process-step-formula', false);
        const reason = el('span', {
            class: 'kind-badge process-step-reason',
            text: entry.step.reason,
        });
        // kind 决定徽章配色(样式归 CSS),title 给出分区的中性名字.
        reason.dataset.kind = entry.step.kind;
        reason.title = PROCESS_STEP_KIND_LABELS[entry.step.kind];

        const row = el('div', { class: 'process-step' });
        row.setAttribute('role', 'listitem');
        row.dataset.stepIndex = String(entry.index);
        row.append(
            el('span', { class: 'process-step-index', text: String(entry.index + 1) }),
            formula,
            reason,
        );
        // 点击任意行跳转;键盘路径是全局左右方向键(见 keyboardBinding).
        row.addEventListener('click', () => this.goto(entry.index));
        this.stepRows[entry.index] = row;
        return { row };
    }

    /**
     * 当前步的唯一写入点:高亮只改类名/属性,不重建行.
     *
     * 行引用由 `_buildStepRow` 填进 `stepRows`(下标即步骤下标),所以这里不查
     * DOM:翻步是连按/长按路径,每步扫一遍根节点没有必要.
     *
     * 有步骤时一定经出口播报:载入一条过程播报第 0 步(把几何切到起点),
     * 翻步播报新下标.边界上的 no-op 在 next/prev/goto 里就被状态机挡掉了,
     * 不会走到这里重复播报.
     */
    private _applyIndex(index: number): void {
        const stepCount = this.state.stepCount;
        const clamped = stepCount === 0 ? EMPTY_PROCESS_INDEX : clampProcessIndex(index, stepCount);
        this.state = { stepCount, index: clamped };

        for (let position = 0; position < this.stepRows.length; position += 1) {
            const row = this.stepRows[position];
            if (row === undefined) continue;
            const current = position === clamped;
            row.classList.toggle('is-current', current);
            if (current) row.setAttribute('aria-current', 'step');
            else row.removeAttribute('aria-current');
        }

        const hasSteps = stepCount > 0 && clamped >= 0;
        this.counter.textContent = hasSteps ? `${clamped + 1} / ${stepCount}` : '';
        this.prevButton.setDisabled(!hasSteps || clamped <= 0);
        this.nextButton.setDisabled(!hasSteps || clamped >= stepCount - 1);
        this._refreshEcho();

        if (hasSteps) this.options.onStepChange?.(clamped);
    }

    /** 页头元信息:依据图例与截断明文(都只在这里写). */
    private _renderMeta(document: ProcessDocument): void {
        this.legend.textContent = partitionStepsByKind(document.steps)
            .map((group) => `${PROCESS_STEP_KIND_LABELS[group.kind]} ${group.steps.length}`)
            .join(' · ');

        if (document.droppedSteps === null) {
            setHidden(this.truncated, true);
            this.truncated.textContent = '';
        } else {
            this.truncated.textContent =
                `过程过长,另有 ${document.droppedSteps} 步未显示(上限 ${UI_CONFIG.process.maxSteps} 步)`;
            setHidden(this.truncated, false);
        }
    }

    /** 空状态:给一句明文,并把步骤容器收起来(不给空盒子). */
    private _renderEmptyState(): void {
        const empty = this.document === null || this.state.stepCount === 0;
        setHidden(this.empty, !empty);
        setHidden(this.stepsContainer, empty);
    }

    /**
     * 题目区:把题目 LaTeX 排成一行公式(可点击复制 TeX).
     *
     * 没有题目就整块收起,不留空盒子.公式沿用 `FormulaView` 的模板缓存,
     * 重新载入同一条过程不会重复排版.
     */
    private _renderProblem(problem: string | null): void {
        const text = problem === null ? '' : problem.trim();
        if (text === '') {
            this.problem.replaceChildren();
            setHidden(this.problem, true);
            return;
        }
        this.problem.replaceChildren(createFormulaElement(text, 'process-problem-formula'));
        setHidden(this.problem, false);
    }

    private _refreshEcho(): void {
        const text = this.options.getParamEcho?.() ?? '';
        this.echo.textContent = text;
        setHidden(this.echo, text === '');
    }
}
