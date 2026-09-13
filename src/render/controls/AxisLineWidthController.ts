import { EventBus } from '../../service/EventBus';
import type { GraphCalcEvents } from '../../types';
import { RENDER_CONFIG } from '../../config/renderConfig';

/**
 * 坐标轴线宽控制.
 *
 * XYZ 轴使用 Line2 绘制,线宽以像素为单位,最小 1px.
 * 变化通过 EventBus 广播,由 RenderController 应用到场景.
 */
export class AxisLineWidthController {
    private readonly input: HTMLInputElement | null;
    private readonly _abortController = new AbortController();
    private width = RENDER_CONFIG.scene.axisLineWidth;

    constructor(private readonly eventBus: EventBus<GraphCalcEvents>) {
        this.input =
            document.getElementById('axisLineWidth') as HTMLInputElement | null;
        if (this.input) {
            this.input.value = String(this.width);
        }

        const signal = this._abortController.signal;
        this.input?.addEventListener('input', () => this._readInput(), { signal });
        this.input?.addEventListener('change', () => this._readInput(), { signal });

        // 启动时按配置同步一次,保证默认状态进入场景
        this._emit();
    }

    dispose(): void {
        this._abortController.abort();
    }

    private _readInput(): void {
        if (!this.input) return;
        const text = this.input.value.trim();
        if (text === '') {
            // 清空时保留上一次合法值
            this.input.value = String(this.width);
            return;
        }
        const raw = Number(text);
        if (!Number.isFinite(raw) || raw < 1) {
            this.input.value = String(this.width);
            return;
        }
        this.width = raw;
        this._emit();
    }

    private _emit(): void {
        this.eventBus.emit('axis:lineWidthChanged', { width: this.width });
    }
}
