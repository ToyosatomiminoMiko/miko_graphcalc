/**
 * 参数面板控制器.
 * 从 DslApp 拆出,负责根据 ParamDeclaration 生成滑块与数字输入,
 * 并维护当前参数值.
 *
 * 循环类系数(`param φ = 0 in cyclic [...]`)的取值在圆周上,越界输入按
 * 区间长度回绕到 `[min, max)`,而不是像普通参数那样夹到端点;回绕口径与
 * 编译期共用 math/paramValue.ts 的 normalizeParamValue,避免"滑块显示 0,
 * 表达式按 2π 求值"的漂移.标签上的 ↻ 只是**显式声明**的可视提示,
 * 不改变任何取值语义.
 *
 * 数字输入框的写回时机(见 UI-P2.1):
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
import type { ParamDeclaration } from '../ir';
import { normalizeParamValue } from '../math/paramValue';

export type ParamChangeHandler = (name: string, value: number) => void;

/** 给 label/id 配对用的实例序号:同一页面上多个面板也不会撞 id. */
let paramPanelSeq = 0;

export class ParamPanelController {
    /**
     * @cache
     * 缓存目的:维护参数面板的当前值,供编译覆盖和滑块双向同步.
     * 键/失效策略:参数名 -> 当前值;render 时整体重建,输入时逐项更新.
     * 生命周期:跟随 ParamPanelController 实例.
     */
    private readonly values = new Map<string, number>();

    /** 行序号:仅用于生成本次 render 内唯一的控件 id(与 <label for> 配对). */
    private rowSeq = 0;
    private readonly idPrefix = `param${paramPanelSeq++}`;

    constructor(
        private readonly panel: HTMLElement,
        private readonly onChange: ParamChangeHandler,
    ) {}

    /**
     * @cache_access
     * 用新参数声明整体重建当前值缓存和面板 DOM.
     */
    render(params: ParamDeclaration[]): void {
        this.panel.replaceChildren();
        this.values.clear();
        this.rowSeq = 0;

        for (const param of params) {
            this.values.set(param.name, param.value);
            this.panel.appendChild(this._createParamRow(param));
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
        this.panel.replaceChildren();
        this.values.clear();
    }

    private _createParamRow(param: ParamDeclaration): HTMLElement {
        const row = document.createElement('div');
        row.className = 'param-row';
        row.classList.toggle('is-cyclic', param.cyclic);

        const sliderId = `${this.idPrefix}-${this.rowSeq}-slider`;
        const numberId = `${this.idPrefix}-${this.rowSeq}-number`;
        this.rowSeq += 1;

        /**
         * "`in` 前定义的值",也就是重置按钮的目标值.
         *
         * 面板只在 `DslApp.run()` 里用**空覆盖**编译出的场景重建(见
         * CompileController.run / compileScene),所以这里的 `param.value`
         * 就是声明值本身,不是滑块当前的覆盖值.若将来改成参数刷新后也重建
         * 面板,必须先把声明值随 IR 一起带出来,否则重置目标会被当前值顶掉.
         */
        const declaredValue = param.value;

        const label = document.createElement('label');
        // 循环参数在名字后加 ↻:让"这个量在圆周上"在面板里可见.
        label.htmlFor = sliderId;
        label.textContent = param.cyclic ? `${param.name} ↻` : param.name;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.id = sliderId;
        slider.min = String(param.min);
        slider.max = String(param.max);
        slider.step = String(param.step);
        slider.value = String(param.value);

        const numberInput = document.createElement('input');
        numberInput.type = 'number';
        numberInput.id = numberId;
        numberInput.min = String(param.min);
        numberInput.max = String(param.max);
        numberInput.step = String(param.step);
        numberInput.value = String(param.value);
        // 可见 label 关联的是滑块(一行里那个大热区);数字框用 aria-label 单独命名.
        // aria-label 不画 hover 浮层(title 才会),所以这里可以安全地补"数值/循环".
        numberInput.setAttribute(
            'aria-label',
            param.cyclic ? `${param.name} 数值(循环)` : `${param.name} 数值`,
        );

        const resetButton = document.createElement('button');
        resetButton.type = 'button';
        resetButton.className = 'param-reset-btn';
        resetButton.textContent = '↺';
        // 名字进 aria-label(读屏不必靠上下文猜是哪条参数),目标值进 title:
        // 重置是"回到某个确定的值",点之前就该能看到它是多少.
        resetButton.title = `重置为 ${declaredValue}`;
        resetButton.setAttribute('aria-label', `重置 ${param.name} 为 ${declaredValue}`);

        /**
         * 是否已停在声明值上:值取自当前值缓存,文本取自数字框.
         *
         * 文本必须一起比:输入框被清空/写成 `1.` 时值没变,但用户正需要
         * 用重置把文本恢复回去,此时按钮不能是禁用的.
         */
        const isAtDeclaredValue = (): boolean =>
            this.values.get(param.name) === declaredValue
            && numberInput.value === String(declaredValue);

        /** 按当前值/文本刷新重置按钮的可用态(判据只有 isAtDeclaredValue 一份). */
        const refreshResetAvailability = (): void => {
            resetButton.disabled = isAtDeclaredValue();
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
            if (writeNumberText) numberInput.value = String(next);
            slider.value = String(next);
            this.values.set(param.name, next);
            refreshResetAvailability();
        };

        const syncFromSlider = (): void => {
            const next = Number(slider.value);
            writeValue(next, true);
            this.onChange(param.name, next);
        };

        /** input 阶段:只同步已能解析的值,不动用户正在编辑的文本. */
        const previewFromNumber = (): void => {
            const raw = this._readNumberText(numberInput);
            if (raw === null) {
                // 解析不出值就不写值,但文本已经变了(清空 / `-` / `1e`):
                // 可用态要跟着文本走,否则用户清空后反而点不了重置来恢复.
                refreshResetAvailability();
                return;
            }
            const next = normalizeParamValue(raw, param);
            writeValue(next, false);
            this.onChange(param.name, next);
        };

        /** change 阶段:归一化后把最终文本写回输入框. */
        const commitFromNumber = (): void => {
            const raw = this._readNumberText(numberInput);
            const previous = this.values.get(param.name) ?? declaredValue;
            const next = raw === null ? previous : normalizeParamValue(raw, param);
            writeValue(next, true);
            if (raw !== null) this.onChange(param.name, next);
        };

        /** 重置:回到声明值;与拖动滑块同一条链路,场景跟着刷新. */
        const resetToDeclared = (): void => {
            writeValue(declaredValue, true);
            this.onChange(param.name, declaredValue);
        };

        slider.addEventListener('input', syncFromSlider);
        numberInput.addEventListener('input', previewFromNumber);
        numberInput.addEventListener('change', commitFromNumber);
        resetButton.addEventListener('click', resetToDeclared);

        // 初值就是声明值,所以重置按钮开局即置灰(判据与写值路径同一份).
        refreshResetAvailability();

        row.append(label, slider, numberInput, resetButton);
        return row;
    }

    /**
     * 读输入框文本 -> 有限数;空串与任何中途态返回 null(调用方据此决定"不写回").
     *
     * 显式判空是必需的:`Number('') === 0`,不判就会把"用户清空了输入框"
     * 当成"用户输入了 0".
     */
    private _readNumberText(input: HTMLInputElement): number | null {
        const text = input.value.trim();
        if (text === '') return null;
        const raw = Number(text);
        return Number.isFinite(raw) ? raw : null;
    }
}
