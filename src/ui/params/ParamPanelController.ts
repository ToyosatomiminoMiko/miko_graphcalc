/**
 * 参数面板控制器.
 * 从 DslApp 拆出,负责根据 ParamDeclaration 生成滑块与数字输入,
 * 并维护当前参数值.
 *
 * DOM 与交互件走 `miko_ui` 的 `widgets/`:一行参数就是库的**系数滑块**
 * (`createSlider` = 名称 + 滑杆 + 数值框 + 重置按钮),本类只保留**业务语义** --
 * 取值口径,归一化函数,以及"值变了通知场景".行的结构由库定义:
 *
 * ```text
 * <div class="slider-field [is-cyclic]">
 *   <input class="slider-field-range" type="range">       ← 粗调入口
 *   <div class="slider-field-meta">
 *     <label class="slider-field-label" for=滑杆>a</label> ← 命名滑杆(一行里的大热区)
 *     <input class="slider-field-value" type="number">    ← 精调入口,自带 aria-label
 *     <button class="slider-field-reset">reset</button>    ← 重置
 *   </div>
 * </div>
 * ```
 *
 * ## 状态源(P3:一行一个 signal)
 *
 * 过去这一行有**两个状态源**:滑块的 `input.value` 与数字框的 `input.value`,
 * 外加本类的一份 `values` 缓存;三者在 `writeValue()` 里手工对齐.现在一行只有
 * 一个 `signal<number>`(见 `miko_ui` 的 `reactive/`),滑块与数字框都以它为
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
 * 循环类系数(`param angle = 0 in cyclic [...]`)的取值在圆周上,越界输入按区间长度
 * 回绕到 `[min, max)`,而不是像普通参数那样夹到端点;回绕口径与编译期共用
 * `math/paramValue.ts` 的 normalizeParamValue.归一化收在**数字框**的
 * `normalize` 选项里(滑块自己不会越界,不需要再过一遍),于是信号里永远不会
 * 出现未归一化的值.标签上的 cyclic 只是**显式声明**的可视提示,不改变取值语义.
 *
 * 数字输入框的写回时机就是数字框"保守策略"的那一种接线:
 * - `input` 阶段只把**已能解析**的值同步给信号(进而同步滑块与场景),
 *   不覆盖用户正在编辑的文本;
 * - 空串与非有限中途态(`-`,`1e`,以及会被浏览器清洗成空串的 `0.`)一律不写回,
 *   否则 `Number('') === 0`,`Number('0.') === 0` 会把输入框改写成 `0`,
 *   用户既清不掉内容,也再打不出小数点;
 * - 归一化后的文本只在 `change`(失焦/回车)时写回输入框.
 *
 * 每条参数行末端还有一个重置按钮(reset):把该参数退回 DSL `in` 前的声明值
 * (`param a = 1 in [0, 5, 0.1]` 里的 `1`).它与拖动滑块走同一条链路(写信号 ->
 * 订阅者通知场景),这几条都由库的系数滑块自己接好(目标值走 `resetValue`,
 * 已经停在声明值上时置灰,判据里同时比较数值框文本,见 `widgets/Slider.ts`);
 * 本类只需要把声明值与归一化函数传进去.
 */
import type { ParamDeclaration } from '@/contract/ir';
import { normalizeParamValue } from '@/math/paramValue';
import {
    createSlider,
    onValueChange,
    signal,
    type Signal,
    type SliderHandle,
} from 'miko_ui';

export type ParamChangeHandler = (name: string, value: number) => void;

/** 一行参数持有的交互件与它的状态源:重建面板时按这个清单统一解绑. */
interface ParamRow {
    readonly name: string;
    /** 这一行的**唯一状态源**(P3):系数滑块与场景广播都读它. */
    readonly value: Signal<number>;
    readonly element: HTMLElement;
    readonly slider: SliderHandle;
    /** 退订"值变化 -> 通知场景". */
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

    /** 解绑上一轮行:系数滑块自己解绑它的三个子控件与全部监听. */
    private _disposeRows(): void {
        for (const row of this.rows) {
            row.stopChange();
            row.slider.dispose();
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
            // 名称,循环标记,重置目标,以及归一化一起交给库的系数滑块:
            // 一行里的名称/滑杆/数值框/重置按钮由它组合并互相同步.
            label: param.name,
            cyclic: param.cyclic,
            resetValue: declaredValue,
            // 归一化只挂在数值框上:滑杆本身不会越界(range 由浏览器夹住),
            // 再走一遍回绕反而会把"拖到 max"变成 min.
            normalize: (raw) => normalizeParamValue(raw, param),
        });

        // 值**变化**才通知场景(建行时那一次不算).重置按钮的可用态,数值框
        // 文本的归一化都收在滑块内部,这里只剩"这个参数变了"这一件业务语义.
        const stopChange = onValueChange(value, (next) => {
            this.onChange(param.name, next);
        });

        return { name: param.name, value, element: slider.element, slider, stopChange };
    }
}
