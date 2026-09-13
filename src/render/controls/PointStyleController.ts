import { EventBus } from '../../service/EventBus';
import type { GraphCalcEvents } from '../../types';
import { RENDER_CONFIG } from '../../config/renderConfig';

type PointMode = 'size' | 'scale';

/** 运行时校验:HTML 的 data-* 是字符串,非法值不能直接当 PointMode 用. */
function isPointMode(value: unknown): value is PointMode {
    return value === 'size' || value === 'scale';
}

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
 */
export class PointStyleController {
    private readonly visibleToggle: HTMLInputElement | null;
    private readonly valueInput: HTMLInputElement | null;
    private readonly valueLabel: HTMLLabelElement | null;
    private readonly modeButtons: NodeListOf<HTMLButtonElement>;
    private readonly _abortController = new AbortController();

    private readonly baseRadius = RENDER_CONFIG.scene.point.radius;
    private mode: PointMode = 'size';
    /** 唯一状态:点的实际半径(缩放模式只是它的另一种显示方式). */
    private sizeValue = this.baseRadius;
    private visible = RENDER_CONFIG.scene.point.visible;

    constructor(private readonly eventBus: EventBus<GraphCalcEvents>) {
        this.visibleToggle =
            document.getElementById('pointVisible') as HTMLInputElement | null;
        this.valueInput =
            document.getElementById('pointValue') as HTMLInputElement | null;
        this.valueLabel =
            document.getElementById('pointValueLabel') as HTMLLabelElement | null;
        this.modeButtons =
            document.querySelectorAll<HTMLButtonElement>('[data-point-mode]');

        if (this.visibleToggle) {
            this.visibleToggle.checked = this.visible;
        }

        const signal = this._abortController.signal;
        this.visibleToggle?.addEventListener('change', () => {
            this.visible = this.visibleToggle?.checked ?? true;
            this._emit();
        }, { signal });

        this.modeButtons.forEach((button) => {
            button.addEventListener('click', () => {
                const mode = button.dataset.pointMode;
                if (!isPointMode(mode) || mode === this.mode) return;
                this._switchMode(mode);
            }, { signal });
        });

        this.valueInput?.addEventListener('input', () => this._readInput(), { signal });
        this.valueInput?.addEventListener('change', () => this._readInput(), { signal });

        this._syncModeUI();
        // 启动时按配置同步一次,保证默认状态进入场景
        this._emit();
    }

    dispose(): void {
        this._abortController.abort();
    }

    /** 切换显示方式:实际半径(`sizeValue`)不变,只换一种表示. */
    private _switchMode(mode: PointMode): void {
        this.mode = mode;
        this._syncModeUI();
        this._emit();
    }

    private _readInput(): void {
        if (!this.valueInput) return;
        const text = this.valueInput.value.trim();
        if (text === '') {
            // 清空时保留上一次合法值,不把空串当成 0
            this.valueInput.value = this._displayValue();
            return;
        }
        const raw = Number(text);
        if (!Number.isFinite(raw) || raw < 0) {
            this.valueInput.value = this._displayValue();
            return;
        }
        // 两种模式写的是同一个状态:实际半径
        this.sizeValue = this.mode === 'size' ? raw : this.baseRadius * raw;
        this._emit();
    }

    private _syncModeUI(): void {
        this.modeButtons.forEach((button) => {
            button.classList.toggle('active', button.dataset.pointMode === this.mode);
        });
        if (this.valueLabel) {
            this.valueLabel.textContent = this.mode === 'size' ? '大小' : '缩放';
        }
        if (this.valueInput) {
            this.valueInput.step = this.mode === 'size' ? '0.05' : '0.1';
            this.valueInput.value = this._displayValue();
        }
    }

    private _displayValue(): string {
        const value = this.mode === 'size'
            ? this.sizeValue
            : (this.baseRadius > 0 ? this.sizeValue / this.baseRadius : 0);
        return String(Number(value.toFixed(4)));
    }

    private _emit(): void {
        this.eventBus.emit('point:changed', {
            radius: this.sizeValue,
            visible: this.visible,
        });
    }
}
