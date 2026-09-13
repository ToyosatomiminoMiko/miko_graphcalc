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
 */
import type { ParamDeclaration } from '../compiler/ir/types';
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

        const syncFromSlider = (): void => {
            const next = Number(slider.value);
            numberInput.value = String(next);
            this.values.set(param.name, next);
            this.onChange(param.name, next);
        };

        /** input 阶段:只同步已能解析的值,不动用户正在编辑的文本. */
        const previewFromNumber = (): void => {
            const raw = this._readNumberText(numberInput);
            if (raw === null) return;
            const next = normalizeParamValue(raw, param);
            slider.value = String(next);
            this.values.set(param.name, next);
            this.onChange(param.name, next);
        };

        /** change 阶段:归一化后把最终文本写回输入框. */
        const commitFromNumber = (): void => {
            const raw = this._readNumberText(numberInput);
            const previous = this.values.get(param.name) ?? param.value;
            const next = raw === null ? previous : normalizeParamValue(raw, param);
            numberInput.value = String(next);
            slider.value = String(next);
            this.values.set(param.name, next);
            if (raw !== null) this.onChange(param.name, next);
        };

        slider.addEventListener('input', syncFromSlider);
        numberInput.addEventListener('input', previewFromNumber);
        numberInput.addEventListener('change', commitFromNumber);

        row.append(label, slider, numberInput);
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
