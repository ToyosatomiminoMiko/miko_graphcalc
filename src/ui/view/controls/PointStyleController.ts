import { EventBus } from '@/core/EventBus';
import type { GraphCalcEvents } from '@/contract/events';
import { RENDER_CONFIG } from '@/config/renderConfig';
import { UI_CONFIG } from '@/config/uiConfig';
import type { PointMode } from '@/contract/view';
import type { PointControls } from '@/ui/view/ViewPanel';

/**
 * 点样式控制(场景 point 对象与分析测量点共用).
 *
 * "点"只有一种渲染定义(PointRenderer),场景 point 对象和导/偏导/散度/
 * 旋度分析里的测量点都受这里控制:
 * - 大小与缩放是同一控制量(实际半径)的两种显示方式,而不是两个独立值:
 *   - 设定大小:直接输入绝对半径,默认取配置里的半径;
 *   - 按比例缩放:以该默认半径为基准输入比例,默认 1(即 100%);
 * - 可见开关:关闭后所有点(场景点对象与分析测量点)不可见.
 *
 * 状态只有一个来源 `sizeValue`(实际半径),缩放模式下的比例由它除以
 * baseRadius 换算而来 -- 因此不存在"配置里的 scale 永远被覆盖"的死配置.
 * 切换模式时会保留当前实际大小.变化通过 EventBus 广播,
 * 由 RenderController 应用到场景.
 *
 * 与老写法的差别:开关/分段按钮/数字框都由 `ViewPanel` 建好并按
 * `PointControls` 交进来,不再有 `getElementById('pointValue')` 与
 * `querySelectorAll('[data-point-mode]')` 的全局查找;模式值也从按钮组的
 * 选中态读出,`isPointMode` 那层字符串校验随类型化消失.
 */
export class PointStyleController {
    private readonly baseRadius = RENDER_CONFIG.scene.point.radius;
    private mode: PointMode;
    /** 唯一状态:点的实际半径(缩放模式只是它的另一种显示方式). */
    private sizeValue: number;
    private visible: boolean;

    constructor(
        private readonly eventBus: EventBus<GraphCalcEvents>,
        private readonly controls: PointControls,
    ) {
        this.visible = controls.visible.get();
        this.mode = controls.mode.get();
        this.sizeValue = controls.value.read() ?? this.baseRadius;

        controls.visible.onChange((visible) => {
            this.visible = visible;
            this._emit();
        });
        controls.mode.onChange((mode) => this._switchMode(mode));

        const apply = (raw: number | null): void => this._applyInput(raw);
        controls.value.onInput(apply);
        controls.value.onCommit(apply);

        this._syncModeUI();
        // 启动时按面板初值同步一次,保证默认状态进入场景
        this._emit();
    }

    dispose(): void {
        this.controls.visible.dispose();
        this.controls.mode.dispose();
        this.controls.value.dispose();
    }

    /** 切换显示方式:实际半径(`sizeValue`)不变,只换一种表示. */
    private _switchMode(mode: PointMode): void {
        this.mode = mode;
        this._syncModeUI();
        this._emit();
    }

    /**
     * 数字框写值:两种模式写的是同一个状态(实际半径).
     *
     * 非法文本(空串/负数/中途态)沿用"即时回退":文本回填成当前显示值,
     * 不广播.
     */
    private _applyInput(raw: number | null): void {
        if (raw === null || raw < UI_CONFIG.view.point.min) {
            this.controls.value.write(this._displayValue());
            return;
        }
        this.sizeValue = this.mode === 'size' ? raw : this.baseRadius * raw;
        this._emit();
    }

    private _syncModeUI(): void {
        this.controls.valueLabel.textContent = this.mode === 'size' ? '大小' : '缩放';
        // 步长随模式变:绝对值与比例各有一档,数值来自 UI_CONFIG(与建面板时
        // 写进 `min`/`step` 的是同一份配置).
        this.controls.value.input.step = String(
            this.mode === 'size'
                ? UI_CONFIG.view.point.sizeStep
                : UI_CONFIG.view.point.scaleStep,
        );
        this.controls.value.write(this._displayValue());
    }

    /**
     * 当前显示值:大小模式就是实际半径,比例模式是它相对基准半径的倍数.
     *
     * 只做数值口径(保留 4 位小数);"怎么写成文本"由数字框的 `format` 负责,
     * 所以这里返回 number,不返回字符串.
     */
    private _displayValue(): number {
        const value = this.mode === 'size'
            ? this.sizeValue
            : (this.baseRadius > 0 ? this.sizeValue / this.baseRadius : 0);
        return Number(value.toFixed(4));
    }

    private _emit(): void {
        this.eventBus.emit('point:changed', {
            radius: this.sizeValue,
            visible: this.visible,
        });
    }
}
