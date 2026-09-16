/**
 * 参数面板控制器.
 * 从 DslApp 拆出,负责根据 ParamDeclaration 生成滑块与数字输入,
 * 并维护当前参数值.
 *
 * DOM 与交互件走 `ui/widgets/`:`createSlider` / `createNumberField` /
 * `createFieldLabel` / `createButton`,本类只保留**业务语义**--
 * 取值口径,写回时机,重置目标.产出的行结构与手写 HTML 时一致:
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
 * 循环类系数(`param φ = 0 in cyclic [...]`)的取值在圆周上,越界输入按
 * 区间长度回绕到 `[min, max)`,而不是像普通参数那样夹到端点;回绕口径与
 * 编译期共用 math/paramValue.ts 的 normalizeParamValue,避免"滑块显示 0,
 * 表达式按 2π 求值"的漂移.标签上的 ↻ 只是**显式声明**的可视提示,
 * 不改变任何取值语义.
 *
 * 数字输入框的写回时机(见 UI-P2.1),就是数字框"保守策略"的那一种接线
 * (另一种"即时回退"见 `NumberField` 文件头):
 * - `input` 阶段只把**已能解析**的值同步给滑块/场景,不覆盖用户正在编辑的文本;
 * - 空串与非有限中途态(`-`,`1e`,以及会被浏览器清洗成空串的 `0.`)一律不写回,
 *   否则 `Number('') === 0`,`Number('0.') === 0` 会把输入框改写成 `0`,
 *   用户既清不掉内容,也再打不出小数点;
 * - 归一化(夹取/回绕)后的文本写回只发生在 `change`(失焦/回车)时.
 *
 * 每条参数行末端还有一个重置按钮(↺):把该参数退回 DSL `in` 前的声明值
 * (`param a = 1 in [0, 5, 0.1]` 里的 `1`).它与拖动滑块走同一条 onChange
 * 链路,所以点一下就会触发场景重绘;按钮在"已经是声明值"时置灰,避免无意义
 * 点击.置灰判据里同时比较数字框文本,这样用户把输入框清空或写成 `1.` 之后
 * (值没变而文本变了)仍然能用它把文本恢复成声明值.
 */
import type { ParamDeclaration } from '../../contract/ir';
import { normalizeParamValue } from '../../math/paramValue';
import { createButton, type ButtonHandle } from '../widgets/Button';
import { el } from '../widgets/dom';
import { createNumberField, type NumberFieldHandle } from '../widgets/NumberField';
import { createFieldLabel } from '../widgets/Row';
import { createSlider, type SliderHandle } from '../widgets/Slider';

export type ParamChangeHandler = (name: string, value: number) => void;

/** 一行参数持有的三个交互件:重建面板时按这个清单统一解绑. */
interface ParamRow {
    readonly element: HTMLElement;
    readonly slider: SliderHandle;
    readonly number: NumberFieldHandle;
    readonly reset: ButtonHandle;
}

export class ParamPanelController {
    /**
     * @cache
     * 缓存目的:维护参数面板的当前值,供编译覆盖和滑块双向同步.
     * 键/失效策略:参数名 -> 当前值;render 时整体重建,输入时逐项更新.
     * 生命周期:跟随 ParamPanelController 实例.
     */
    private readonly values = new Map<string, number>();

    /**
     * @cache
     * 缓存目的:当前这一轮渲染出来的行句柄,重建/销毁时据此解绑 DOM 监听.
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
     * 用新参数声明整体重建当前值缓存和面板 DOM.
     */
    render(params: ParamDeclaration[]): void {
        this._disposeRows();
        this.panel.replaceChildren();
        this.values.clear();

        for (const param of params) {
            this.values.set(param.name, param.value);
            const row = this._createParamRow(param);
            this.rows.push(row);
            this.panel.appendChild(row.element);
        }
    }

    /**
     * @cache_access
     * 从当前值缓存生成编译覆盖对象.
     */
    getValues(): Record<string, number> {
        return Object.fromEntries(this.values);
    }

    /**
     * @cache_access
     * 清空参数面板和当前值缓存.
     */
    dispose(): void {
        this._disposeRows();
        this.panel.replaceChildren();
        this.values.clear();
    }

    /** 解绑上一轮行的控件监听(控件自己持有 AbortController). */
    private _disposeRows(): void {
        for (const row of this.rows) {
            row.slider.dispose();
            row.number.dispose();
            row.reset.dispose();
        }
        this.rows = [];
    }

    private _createParamRow(param: ParamDeclaration): ParamRow {
        // 先建件(只有外观),再定义互相依赖的写值闭包,最后接线 -- 与
        // widgets 的约定一致:选项不回调,回调用 onChange/onClick 事后注册.
        const slider = createSlider({
            value: param.value,
            min: param.min,
            max: param.max,
            step: param.step,
        });
        const number = createNumberField({
            value: param.value,
            min: param.min,
            max: param.max,
            step: param.step,
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
        const row = el(
            'div',
            { class: 'param-row' },
            label,
            slider.element,
            number.input,
            reset.element,
        );
        row.classList.toggle('is-cyclic', param.cyclic);

        /**
         * "`in` 前定义的值",也就是重置按钮的目标值.
         *
         * 面板只在 `DslApp.run()` 里用**空覆盖**编译出的场景重建(见
         * CompileController.run / compileScene),所以这里的 `param.value`
         * 就是声明值本身,不是滑块当前的覆盖值.若将来改成参数刷新后也重建
         * 面板,必须先把声明值随 IR 一起带出来,否则重置目标会被当前值顶掉.
         */
        const declaredValue = param.value;

        /**
         * 是否已停在声明值上:值取自当前值缓存,文本取自数字框.
         *
         * 文本必须一起比:输入框被清空/写成 `1.` 时值没变,但用户正需要
         * 用重置把文本恢复回去,此时按钮不能是禁用的.
         */
        const isAtDeclaredValue = (): boolean =>
            this.values.get(param.name) === declaredValue
            && number.readText() === String(declaredValue);

        /** 按当前值/文本刷新重置按钮的可用态(判据只有 isAtDeclaredValue 一份). */
        const refreshResetAvailability = (): void => {
            reset.setDisabled(isAtDeclaredValue());
        };

        /**
         * 行内唯一写值口:滑块,数字框文本,当前值缓存,重置按钮可用态一起
         * 更新,避免某条路径漏同步(此处原有三处重复的写回,重置按钮再来
         * 一份就会四处漂移).
         *
         * `writeNumberText` 为 false 时不碰输入框文本:那是 `input` 阶段,
         * 用户可能正在编辑中途态(见文件头 UI-P2.1).
         */
        const writeValue = (next: number, writeNumberText: boolean): void => {
            if (writeNumberText) number.write(next);
            slider.set(next);
            this.values.set(param.name, next);
            refreshResetAvailability();
        };

        slider.onInput((value) => {
            writeValue(value, true);
            this.onChange(param.name, value);
        });

        /** input 阶段:只同步已能解析的值,不动用户正在编辑的文本. */
        number.onInput((raw) => {
            if (raw === null) {
                // 解析不出值就不写值,但文本已经变了(清空 / `-` / `1e`):
                // 可用态要跟着文本走,否则用户清空后反而点不了重置来恢复.
                refreshResetAvailability();
                return;
            }
            const next = normalizeParamValue(raw, param);
            writeValue(next, false);
            this.onChange(param.name, next);
        });

        /**
         * change 阶段:归一化后把最终文本写回输入框.
         *
         * 两条路径分工不同,不是同一条的装饰:
         * - 解析成功:归一化(夹取/回绕)后的值写回,并广播给场景;
         * - 解析失败(清空 / `-` / `1e`):把文本恢复成当前值,不广播 -- 值本身
         *   没变,input 阶段也没有广播过,没有需要通知下游的变化.
         */
        number.onCommit((raw) => {
            if (raw === null) {
                writeValue(this.values.get(param.name) ?? declaredValue, true);
                return;
            }
            const next = normalizeParamValue(raw, param);
            writeValue(next, true);
            this.onChange(param.name, next);
        });

        /** 重置:回到声明值;与拖动滑块同一条链路,场景跟着刷新. */
        reset.onClick(() => {
            writeValue(declaredValue, true);
            this.onChange(param.name, declaredValue);
        });

        // 初值就是声明值,所以重置按钮开局即置灰(判据与写值路径同一份).
        refreshResetAvailability();

        return { element: row, slider, number, reset };
    }
}
