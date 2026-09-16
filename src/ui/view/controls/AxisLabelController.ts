import { EventBus } from '../../../core/EventBus';
import type { GraphCalcEvents } from '../../../contract/events';
import type { AxisName } from '../../../contract/view';
import type { SwitchHandle } from '../../widgets/Switch';

/** 遍历三条轴时的固定顺序;类型上就是 `AxisName` 的全集. */
const AXES: readonly AxisName[] = ['x', 'y', 'z'];

/**
 * 各轴标签开关.
 *
 * 隐藏某条轴的标签时,该轴的刻度数字也一起隐藏(刻度线保留).
 * 变化通过 EventBus 广播,由 RenderController 应用到场景.
 *
 * 老写法按 `axisLabelX/Y/Z` 三个 id 去 `getElementById`,初值来自
 * `RENDER_CONFIG.scene.axisLabels`;现在三个开关由面板按同一份配置建好并
 * 以 `Record<AxisName, SwitchHandle>` 交进来,这里不再出现 id 字符串.
 */
export class AxisLabelController {
    private readonly visible: Record<AxisName, boolean>;

    constructor(
        private readonly eventBus: EventBus<GraphCalcEvents>,
        private readonly toggles: Readonly<Record<AxisName, SwitchHandle>>,
    ) {
        this.visible = {
            x: toggles.x.get(),
            y: toggles.y.get(),
            z: toggles.z.get(),
        };

        for (const axis of AXES) {
            toggles[axis].onChange((visible) => {
                this.visible[axis] = visible;
                this._emit();
            });
        }

        // 启动时按面板初值同步一次,保证默认状态进入场景
        this._emit();
    }

    dispose(): void {
        for (const axis of AXES) this.toggles[axis].dispose();
    }

    private _emit(): void {
        this.eventBus.emit('axis:labelVisibility', {
            x: this.visible.x,
            y: this.visible.y,
            z: this.visible.z,
        });
    }
}
