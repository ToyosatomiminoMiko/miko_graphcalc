/**
 * 参数面板控制器.
 * 从 DslApp 拆出,负责根据 ParamDeclaration 生成滑块与数字输入,
 * 并维护当前参数值.
 *
 * DOM 与交互件走 `@miko/ui` 的 `widgets/`(`createSlider` / `createNumberField` /
 * `createFieldLabel` / `createButton`),本类只保留**业务语义**--取值口径,
 * 写回时机,重置目标.产出的行结构与手写 HTML 时一致:
 *
 * ```text
 * <div class="param-row [is-cyclic]">
 *   <label for=滑块>a</label>   ← 命名滑块(一行里的大热区)
 *   <input type="range">        ← 粗调入口
 *   <input type="number">       ← 精调入口,自带 aria-label
 *   <button class="param-reset-btn">↺</button>
 * </div>
 * ```
 *
 * ## 状态源(P3:一行一个 signal)
 *
 * 过去这一行有**两个状态源**:滑块的 `input.value` 与数字框的 `input.value`,
 * 外加本类的一份 `values` 缓存;三者在 `writeValue()` 里手工对齐.现在一行只有
 * 一个 `signal<number>`(见 `@miko/ui` 的 `reactive/`),滑块与数字框都以它为
 * `value` 绑定:
 *
 * - 滑块拖动 -> 写信号 -> 数字框自己更新;
 * - 数字框输入 -> 归一化后写信号 -> 滑块自己更新;
 * - 场景广播与重置按钮可用态订阅同一个信号.
 *
 * `writeValue()` 那条"四处一起改"的手工同步因此消失.
 *
 * ## 归一化与写回时机(UI-P2.1)
 *
 * 循环类系数(`param φ = 0 in cyclic [...]`)的取值在圆周上,越界输入按区间长度
 * 回绕到 `[min, max)`,而不是像普通参数那样夹到端点;回绕口径与编译期共用
 * `math/paramValue.ts` 的 normalizeParamValue.归一化收在**数字框**的
 * `normalize` 选项里(滑块自己不会越界,不需要再过一遍),于是信号里永远不会
 * 出现未归一化的值.标签上的 ↻ 只是**显式声明**的可视提示,不改变取值语义.
 *
 * 数字输入框的写回时机就是数字框"保守策略"的那一种接线:
 * - `input` 阶段只把**已能解析**的值同步给信号(进而同步滑块与场景),
 *   不覆盖用户正在编辑的文本;
 * - 空串与非有限中途态(`-`,`1e`,以及会被浏览器清洗成空串的 `0.`)一律不写回,
 *   否则 `Number('') === 0`,`Number('0.') === 0` 会把输入框改写成 `0`,
 *   用户既清不掉内容,也再打不出小数点;
 * - 归一化后的文本只在 `change`(失焦/回车)时写回输入框.
 *
 * 每条参数行末端还有一个重置按钮(↺):把该参数退回 DSL `in` 前的声明值
 * (`param a = 1 in [0, 5, 0.1]` 里的 `1`).它与拖动滑块走同一条链路(写信号 ->
 * 订阅者通知场景),按钮在"已经是声明值"时置灰.置灰判据里同时比较数字框文本,
 * 这样用户把输入框清空或写成 `1.` 之后(值没变而文本变了)仍然能用它把文本
 * 恢复成声明值.
 */
import type { ParamDeclaration } from '@/contract/ir';
import { normalizeParamValue } from '@/math/paramValue';
import {
    createButton,
    createFieldLabel,
    createNumberField,
    createSlider,
    create_element,
    onValueChange,
    signal,
    type ButtonHandle,
    type NumberFieldHandle,
    type Signal,
    type SliderHandle,
} from '@miko/ui';

export type ParamChangeHandler = (name: string, value: number) => void;

/** 一行参数持有的交互件与它的状态源:重建面板时按这个清单统一解绑. */
interface ParamRow {
    readonly name: string;
    /** 这一行的**唯一状态源**(P3):滑块,数字框,重置判据,场景广播都读它. */
    readonly value: Signal<number>;
    readonly element: HTMLElement;
    readonly slider: SliderHandle;
    readonly number: NumberFieldHandle;
    readonly reset: ButtonHandle;
    /** 退订"值变化 -> 通知场景/刷新按钮". */
    readonly stopChange: () => void;
}

export class ParamPanelController {
    /**
     * @cache
     * 缓存目的:当前这一轮渲染出来的行(含各自的状态源),重建/销毁时据此解绑.
     * 键/失效策略:render 重建时整体替换;dispose 时清空.
     * 生命周期:跟随 ParamPanelController 实例.
     */
    private rows: ParamRow[] = [];

    constructor(
        private readonly panel: HTMLElement,
        private readonly onChange: ParamChangeHandler,
    ) {}

    /**
     * @cache_access
     * 用新参数声明整体重建面板:每行一个新的状态源,初值就是声明值.
     */
    render(params: ParamDeclaration[]): void {
        this._disposeRows();
        this.panel.replaceChildren();

        for (const param of params) {
            const row = this._createParamRow(param);
            this.rows.push(row);
            this.panel.appendChild(row.element);
        }
    }

    /**
     * @cache_access
     * 从各行状态源生成编译覆盖对象(不存在第二份缓存,读的就是控件正在显示的值).
     */
    getValues(): Record<string, number> {
        const values: Record<string, number> = {};
        for (const row of this.rows) values[row.name] = row.value.peek();
        return values;
    }

    /**
     * @cache_access
     * 清空参数面板与全部行状态源.
     */
    dispose(): void {
        this._disposeRows();
        this.panel.replaceChildren();
    }

    /** 解绑上一轮行:先摘订阅,再让控件各自 abort(它们自己持有 AbortController). */
    private _disposeRows(): void {
        for (const row of this.rows) {
            row.stopChange();
            row.slider.dispose();
            row.number.dispose();
            row.reset.dispose();
        }
        this.rows = [];
    }

    private _createParamRow(param: ParamDeclaration): ParamRow {
        /**
         * "`in` 前定义的值",也就是重置按钮的目标值.
         *
         * 面板只在 `DslApp.run()` 里用**空覆盖**编译出的场景重建(见
         * CompileController.run / compileScene),所以这里的 `param.value`
         * 就是声明值本身,不是滑块当前的覆盖值.若将来改成参数刷新后也重建
         * 面板,必须先把声明值随 IR 一起带出来,否则重置目标会被当前值顶掉.
         */
        const declaredValue = param.value;
        const value = signal(declaredValue);

        const slider = createSlider({
            value,
            min: param.min,
            max: param.max,
            step: param.step,
        });
        const number = createNumberField({
            value,
            min: param.min,
            max: param.max,
            step: param.step,
            // 归一化只挂在数字框上:滑块本身不会越界(range 由浏览器夹住),
            // 再走一遍回绕反而会把"拖到 max"变成 min.
            normalize: (raw) => normalizeParamValue(raw, param),
            // 可见 label 关联的是滑块(一行里那个大热区);数字框用 aria-label
            // 单独命名.aria-label 不画 hover 浮层(title 才会),所以这里可以
            // 安全地补"数值/循环".
            ariaLabel: param.cyclic ? `${param.name} 数值(循环)` : `${param.name} 数值`,
        });
        const reset = createButton({
            class: 'param-reset-btn',
            text: '↺',
            // 名字进 aria-label(读屏不必靠上下文猜是哪条参数),目标值进
            // title:重置是"回到某个确定的值",点之前就该能看到它是多少.
            title: `重置为 ${param.value}`,
            ariaLabel: `重置 ${param.name} 为 ${param.value}`,
        });
        // 循环参数在名字后加 ↻:让"这个量在圆周上"在面板里可见.
        const label = createFieldLabel(
            param.cyclic ? `${param.name} ↻` : param.name,
            slider.input.id,
        );
        const row = create_element(
            'div',
            { class: 'param-row' },
            label,
            slider.element,
            number.input,
            reset.element,
        );
        row.classList.toggle('is-cyclic', param.cyclic);

        /**
         * 是否已停在声明值上:值取自状态源,文本取自数字框.
         *
         * 文本必须一起比:输入框被清空/写成 `1.` 时值没变,但用户正需要
         * 用重置把文本恢复回去,此时按钮不能是禁用的.
         */
        const isAtDeclaredValue = (): boolean =>
            value.peek() === declaredValue
            && number.readText() === String(declaredValue);

        /** 按状态源与文本刷新重置按钮的可用态(判据只有 isAtDeclaredValue 一份). */
        const refreshResetAvailability = (): void => {
            reset.setDisabled(isAtDeclaredValue());
        };

        // 值**变化**才通知场景(建行时那一次不算),顺带刷新按钮可用态.
        const stopChange = onValueChange(value, (next) => {
            refreshResetAvailability();
            this.onChange(param.name, next);
        });

        /**
         * input 阶段:解析不出值时状态源没变(控件不写回),但文本已经变了
         * (清空 / `-` / `1e`):可用态要跟着文本走,否则用户清空后反而点不了
         * 重置来恢复.
         */
        number.onInput((raw) => {
            if (raw === null) refreshResetAvailability();
        });

        /**
         * change 阶段:归一化结果已经进了状态源(见 `NumberField.normalize`),
         * 这里把**最终文本**落到输入框上;解析失败时用当前值恢复文本,值不变
         * 也就不广播.
         */
        number.onCommit(() => {
            number.write(value.peek());
            refreshResetAvailability();
        });

        /**
         * 重置:回到声明值.
         *
         * 文本必须**显式**写回:值可能本来就在声明值上(用户只是把输入框清空了),
         * 那种情况下写信号是空操作,镜像不会动,不写文本输入框就会一直空着.
         */
        reset.onClick(() => {
            value.value = declaredValue;
            number.write(declaredValue);
            refreshResetAvailability();
        });

        // 初值就是声明值,所以重置按钮开局即置灰(判据与写值路径同一份).
        refreshResetAvailability();

        return { name: param.name, value, element: row, slider, number, reset, stopChange };
    }
}
