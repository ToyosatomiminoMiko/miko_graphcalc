import { EventBus } from '@/core/EventBus';
import type { GraphCalcEvents } from '@/contract/events';
import type { UpAxis } from '@/contract/view';
import type { SegmentedHandle } from '@/ui/widgets/Segmented';

/**
 * 坐标轴"向上"方向控制.
 *
 * 三选一:X / Y / Z 的正方向朝上.默认值由面板按 `RENDER_CONFIG.scene.upAxis`
 * 写进按钮组,这里只把当前选中值收进状态.
 *
 * 老写法对每个按钮的 `data-axis-up` 做 `isUpAxis` 校验,并在点击后自己
 * `_syncUI` 刷 `.active`;现在这两件事分别由泛型与 `createSegmented` 承担.
 */
export class AxisUpController {
    private axis: UpAxis;

    constructor(
        private readonly eventBus: EventBus<GraphCalcEvents>,
        private readonly controls: SegmentedHandle<UpAxis>,
    ) {
        this.axis = controls.get();

        controls.onChange((axis) => {
            if (axis === this.axis) return;
            this.axis = axis;
            this._emit();
        });

        // 启动时按面板初值同步一次,保证默认状态进入场景
        this._emit();
    }

    dispose(): void {
        this.controls.dispose();
    }

    private _emit(): void {
        this.eventBus.emit('axis:upChanged', { axis: this.axis });
    }
}
