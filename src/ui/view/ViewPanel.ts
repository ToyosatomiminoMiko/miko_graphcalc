/**
 * 右侧"视图"窗口正文的装配:**解释 `viewSpec.ts` 的元素清单**,不自己声明元素.
 *
 * ```text
 * viewSpec.ts     分组 / 顺序 / 行标签 / 控件种类 / 绑定的状态键   ← 元素清单(唯一处)
 *      │  VIEW_BLOCKS
 *      ▼
 * ViewPanel(本文件)  按 kind 建控件 + 收集句柄 + 统一拆卸          ← 解释器
 *      │  effect(在 RenderController 里,不是这里)
 *      ▼
 * RenderController   订阅 viewState,推到 CameraManager / Plotter / SceneManager
 * ```
 *
 * 这一块以前散在 `index.html`(约 150 行手写 `div/label/input/span`)与 10 个
 * 控制器各自的 `getElementById` 之间:加一个控件要同时改 HTML,改某个控制器的
 * id 字符串,再祈祷页面上没有同名 id.`createViewPanel` 把"结构"收进 TS 之后,
 * 结构又长在这 120 行装配里;现在它归 `viewSpec.ts`,本文件只剩两件事:
 *
 * 1. **按清单渲染**:`kind` 决定控件种类,`key` 决定绑哪个状态字段.数值
 *    (`min` / `step` / `items`)在清单里,清单引用 `UI_CONFIG.view`,所以界面
 *    默认值仍然只有一处;
 * 2. **统一持有与拆卸**:控件句柄(`own`)与内部订阅(`stop`)都进面板的袋子,
 *    `dispose()` 一处解绑.清单本身不认识 DOM 生命周期.
 *
 * 三条约定:
 * 1. **本文件不认识渲染器**:它只把控件绑到状态上;谁订阅状态,推到哪由
 *    `RenderController` 决定.所以这里是纯视图,可以在测试里单独装配断言.
 * 2. **配置只在这里被"用"**:范围/选项来自 `UI_CONFIG.view`(经清单),
 *    初值(渲染默认值)归 `createViewState()`.
 * 3. **重复装配前必须先 dispose 上一个句柄**:`host` 原有内容会被清空,但旧
 *    句柄的控件与订阅还挂在状态上,不清就泄漏(见 `ViewPanel.test.ts`).
 */
import type { PointMode, UpAxis, ViewHome } from '@/contract/view';
import {
    createControlGroup,
    createInlineToggle,
    createNumberField,
    createNumberRow,
    createRow,
    createSegmented,
    createSwitch,
    createSwitchRow,
    create_element,
} from 'miko_ui';
import type { ViewState } from './viewState';
import {
    VIEW_BLOCKS,
    type SegmentedRowSpec,
    type ViewBlockSpec,
    type ViewRowSpec,
    type ViewSpecContext,
} from './viewSpec';

/**
 * 面板句柄:建完只留一个拆卸入口(控件与订阅都归面板所有).
 *
 * 没有 `element`:正文宿主由 `src/app/appViews.ts` 建并持有(`#view-controls`),
 * 装配层拿它只是为了 `dispose()`.
 */
export interface ViewPanelHandle {
    dispose(): void;
}

/** 会被 `dispose()` 一起解绑的东西:控件句柄. */
interface Disposable {
    dispose(): void;
}

/**
 * 建出整块视图面板并挂进 `host`;**`host` 原有内容会被清空**.
 *
 * 返回值只有 `dispose()`:面板自己拥有全部控件与订阅(不再"把每个句柄交给
 * 一个控制器"),所以拆卸也只有一处.想刷新面板不要"再调一次",而是
 * `dispose()` 之后再建(否则旧订阅会留在状态上).
 */
export function createViewPanel(host: HTMLElement, state: ViewState): ViewPanelHandle {
    const abort = new AbortController();
    const disposables: Disposable[] = [];
    const stops: Array<() => void> = [];
    const context: ViewSpecContext = {
        own: (disposable) => disposables.push(disposable),
        stop: (stop) => stops.push(stop),
        signal: abort.signal,
    };

    host.replaceChildren(
        ...VIEW_BLOCKS.map((block) => renderBlock(block, state, context)),
    );

    return {
        dispose(): void {
            abort.abort();
            for (const stop of stops) stop();
            for (const disposable of disposables) disposable.dispose();
            disposables.length = 0;
        },
    };
}

/** 一块:分组包一层小节,其余(相机行 / 预置视角)原样落地. */
function renderBlock(
    block: ViewBlockSpec,
    state: ViewState,
    context: ViewSpecContext,
): HTMLElement {
    if (block.kind !== 'group') return renderRow(block, state, context);
    return createControlGroup(
        block.title,
        ...block.rows.map((row) => renderRow(row, state, context)),
    );
}

/**
 * 一行:按 `kind` 建控件.
 *
 * `switch` / `number` / `toggle-row` 三档的 `key` 落在"字段类型全是
 * `Signal<boolean>` / `Signal<number>`"的键集合里(见 `viewSpec.ts` 的
 * `BoolKey` / `NumberKey`),所以这里 `state[row.key]` 直接就是控件要的可写信号,
 * 不需要强转也不需要运行时校验.
 */
function renderRow(
    row: ViewRowSpec,
    state: ViewState,
    context: ViewSpecContext,
): HTMLElement {
    switch (row.kind) {
        case 'switch': {
            const control = createSwitch({ value: state[row.key] });
            context.own(control);
            return createSwitchRow(row.label, control);
        }
        case 'number': {
            const control = createNumberField({
                value: state[row.key],
                min: row.min,
                step: row.step,
            });
            context.own(control);
            if (row.guardLowerBound === true) {
                // 低于下限的输入到不了状态源(见 viewState 的 boundedInput),
                // 这里把框里的文本回填成当前值,免得非法输入留在眼前.
                control.onInput((raw) => {
                    if (raw === null || raw < row.min) control.write(state[row.key].peek());
                });
            }
            return createNumberRow(row.label, control).row;
        }
        case 'toggle-row': {
            const toggles = row.toggles.map((toggle) => {
                const control = createSwitch({ value: state[toggle.key] });
                context.own(control);
                return createInlineToggle(toggle.text, control);
            });
            return createRow(create_element({ tag: 'span' }, {}, row.label), ...toggles);
        }
        case 'segmented':
            return renderSegmented(row, state, context);
        case 'custom':
            return row.build(state, context);
    }
}

/**
 * 分段行.
 *
 * `switch (row.key)` 是**按键收窄**而不是按泛型硬转:三个分段行的值域
 * (`PointMode` / `UpAxis` / `ViewHome`)互不相同,逐键写出来才能让
 * `createSegmented<T>` 的 `items` 与 `value` 落到同一个 `T` 上.键只有三个,
 * 多写三行换来的是"清单里写错值域就编译不过".
 *
 * 有 `label` = 包一层 `.control-row`(行内组);没有 = 裸 `.segmented`
 * (点模式 / 预置视角:它们的名字走 `aria-label`,不需要第二行文字).
 */
function renderSegmented(
    row: SegmentedRowSpec,
    state: ViewState,
    context: ViewSpecContext,
): HTMLElement {
    const element = segmentedElement(row, state, context);
    if (row.label === undefined) return element;
    return createRow(create_element({ tag: 'span' }, {}, row.label), element);
}

function segmentedElement(
    row: SegmentedRowSpec,
    state: ViewState,
    context: ViewSpecContext,
): HTMLElement {
    switch (row.key) {
        case 'pointMode': {
            const control = createSegmented<PointMode>({
                columns: row.columns,
                modifier: row.modifier,
                ariaLabel: row.ariaLabel,
                value: state.pointMode,
                items: row.items,
            });
            context.own(control);
            return control.element;
        }
        case 'upAxis': {
            const control = createSegmented<UpAxis>({
                columns: row.columns,
                modifier: row.modifier,
                ariaLabel: row.ariaLabel,
                value: state.upAxis,
                items: row.items,
            });
            context.own(control);
            return control.element;
        }
        case 'viewHome': {
            const control = createSegmented<ViewHome>({
                columns: row.columns,
                modifier: row.modifier,
                ariaLabel: row.ariaLabel,
                value: state.viewHome,
                items: row.items,
            });
            context.own(control);
            return control.element;
        }
    }
}
