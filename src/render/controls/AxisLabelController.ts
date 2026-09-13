import { EventBus } from '../../service/EventBus';
import type { GraphCalcEvents } from '../../types';
import { RENDER_CONFIG } from '../../config/renderConfig';

type AxisName = 'x' | 'y' | 'z';

/**
 * 各轴标签开关.
 *
 * 隐藏某条轴的标签时,该轴的刻度数字也一起隐藏(刻度线保留).
 * 变化通过 EventBus 广播,由 RenderController 应用到场景.
 */
export class AxisLabelController {
    private readonly toggles: Record<AxisName, HTMLInputElement | null>;
    private readonly _abortController = new AbortController();
    private readonly visible: Record<AxisName, boolean> = {
        x: RENDER_CONFIG.scene.axisLabels.x,
        y: RENDER_CONFIG.scene.axisLabels.y,
        z: RENDER_CONFIG.scene.axisLabels.z,
    };

    constructor(private readonly eventBus: EventBus<GraphCalcEvents>) {
        this.toggles = {
            x: document.getElementById('axisLabelX') as HTMLInputElement | null,
            y: document.getElementById('axisLabelY') as HTMLInputElement | null,
            z: document.getElementById('axisLabelZ') as HTMLInputElement | null,
        };

        const signal = this._abortController.signal;
        (['x', 'y', 'z'] as const).forEach((axis) => {
            const toggle = this.toggles[axis];
            if (toggle) toggle.checked = this.visible[axis];
            toggle?.addEventListener('change', () => {
                this.visible[axis] = toggle?.checked ?? true;
                this._emit();
            }, { signal });
        });

        // 启动时按配置同步一次,保证默认状态进入场景
        this._emit();
    }

    dispose(): void {
        this._abortController.abort();
    }

    private _emit(): void {
        this.eventBus.emit('axis:labelVisibility', {
            x: this.visible.x,
            y: this.visible.y,
            z: this.visible.z,
        });
    }
}
