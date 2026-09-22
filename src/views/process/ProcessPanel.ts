/**
 * 过程页视图(右栏"过程"标签页的内容).
 *
 * 一行一步的递等式:序号 + 一行 KaTeX + 依据徽章,整条过程一次铺开(只读).
 *
 * 几条刻意的不变量:
 * - **渲染是纯写入**:行按指纹复用(`keyedRowList` 的复用约定与 `stepRows`),
 *   同一条过程重载不会重建同内容行;
 * - **键盘不在本类**:本类没有键盘语义,左右方向键留给标签栏与编辑器;
 * - 空过程给一句明文,超长过程截断并注明,隐藏对象不生成过程(入口置灰的理由
 *   由条目给,见 `evaluation/evaluationDom.ts`).
 *
 * 公式沿用 `FormulaView`(KaTeX 不换行,排不下由该行横向滚动),模板缓存上限
 * 不在这里扩:步骤 LaTeX 键是"表达式签名 × 步数",是有限集合.
 */
import { UI_CONFIG } from '@/config/uiConfig';
import { createFormulaElement } from '@miko/ui';
import { KeyedRowList, type KeyedRowHandles } from '@miko/ui';
import { create_element } from '@miko/ui';
import {
    PROCESS_STEP_KIND_LABELS,
    partitionStepsByKind,
    type ProcessDocument,
    type ProcessStep,
} from '@/adapters/processSteps';

export interface ProcessPanelOptions {
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

export class ProcessPanel {
    private readonly list: KeyedRowList<IndexedStep, ProcessStepRow>;
    private readonly title: HTMLElement;
    private readonly legend: HTMLElement;
    private readonly problem: HTMLElement;
    private readonly echo: HTMLElement;
    private readonly empty: HTMLElement;
    private readonly truncated: HTMLElement;
    private readonly stepsContainer: HTMLElement;

    private document: ProcessDocument | null = null;

    constructor(
        private readonly root: HTMLElement,
        private readonly options: ProcessPanelOptions = {},
    ) {
        this.title = create_element('span', { class: 'process-title' }, '过程');
        this.legend = create_element('span', { class: 'process-legend' });
        // 题目区:过程页先给"在解什么",再给步骤(见 ProcessDocument.problem).
        this.problem = create_element('div', { class: 'process-problem' });
        setHidden(this.problem, true);
        this.echo = create_element('div', { class: 'process-param-echo' });
        setHidden(this.echo, true);

        const header = create_element(
            'div',
            { class: 'process-header' },
            create_element('div', { class: 'process-heading' }, this.title, this.legend),
            this.problem,
            this.echo,
        );

        this.empty = create_element('p', { class: 'process-empty' }, EMPTY_TEXT);
        this.truncated = create_element('p', { class: 'process-truncated' });
        setHidden(this.truncated, true);

        this.stepsContainer = create_element('div', { class: 'process-steps' });
        // KeyedRowList 构造时会给容器加 role="list"(与两个对象列表同一约定).
        this.list = new KeyedRowList<IndexedStep, ProcessStepRow>(this.stepsContainer);

        this.root.replaceChildren(header, this.empty, this.stepsContainer, this.truncated);
        this._renderEmptyState();
    }

    /** 载入一条过程:重建步骤行(按指纹复用),并把页头元信息与回显一并刷新. */
    show(doc: ProcessDocument): void {
        this.document = doc;
        this.title.textContent = doc.title;

        const indexed: IndexedStep[] = doc.steps.map((step, index) => ({ index, step }));
        this.list.sync(indexed, {
            name: (entry) => String(entry.index),
            key: (entry) => `${entry.step.latex}|${entry.step.kind}|${entry.step.reason}`,
            build: (entry) => this._buildStepRow(entry),
        });

        this._renderProblem(doc.problem ?? null);
        this._renderMeta(doc);
        this._renderEmptyState();
        this._refreshEcho();
    }

    /** 清空过程:回到空状态明文,不留下上一条的步骤与标题. */
    clear(): void {
        this.document = null;
        this.list.clear();
        this.title.textContent = '过程';
        this.legend.textContent = '';
        this._renderProblem(null);
        this._refreshEcho();
        this._renderEmptyState();
    }

    /** 解绑:行的事件已经随行一起丢弃(本类不再绑任何全局监听),只清列表引擎. */
    dispose(): void {
        this.list.clear();
    }

    /**
     * 刷新参数只读回显.
     *
     * 触发点是**参数值变化**(`DslApp._scheduleRefresh` 的合并帧里调用):参数窗口
     * 与过程窗口同屏,参数一改,过程窗口顶部的回显就该跟着变.过程拆成独立窗口
     * 之前的触发点是"切回过程页",那个动作已经不存在了(见
     * docs/windowing-plan.md §3.7).
     *
     * 单独开这个入口而不是让调用方重载过程:重载要重建整张步骤表,没必要为了
     * 一行回显付这个代价.
     */
    refreshEcho(): void {
        this._refreshEcho();
    }

    private _buildStepRow(entry: IndexedStep): ProcessStepRow {
        const formula = createFormulaElement(entry.step.latex, 'process-step-formula', false);
        const reason = create_element('span', {
            class: 'kind-badge process-step-reason',
        }, entry.step.reason);
        // kind 决定徽章配色(样式归 CSS),title 给出分区的中性名字.
        reason.dataset.kind = entry.step.kind;
        reason.title = PROCESS_STEP_KIND_LABELS[entry.step.kind];

        const row = create_element('div', { class: 'process-step' });
        row.setAttribute('role', 'listitem');
        row.append(
            create_element('span', { class: 'process-step-index' }, String(entry.index + 1)),
            formula,
            reason,
        );
        return { row };
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
        const empty = this.document === null || this.document.steps.length === 0;
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
