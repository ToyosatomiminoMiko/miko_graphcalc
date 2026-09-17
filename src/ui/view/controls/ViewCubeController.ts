import { EventBus } from '@/core/EventBus';
import type { GraphCalcEvents } from '@/contract/events';
import type { ViewHome } from '@/contract/view';
import type { SegmentedHandle } from '@/ui/widgets/Segmented';

/**
 * ViewCube 控制器:统一 3D 场景下的预置观察方向切换.
 *
 * 老写法从 `document.querySelectorAll('[data-view]')` 拿按钮,再对每个按钮的
 * `dataset.view` 做 `isViewHome` 运行时校验.现在按钮组由
 * `createSegmented<ViewHome>` 建好:值域由泛型保证,高亮也由控件自己维护,
 * 这里只剩"选中 -> 广播"一条映射.
 */
export class ViewCubeController {
    constructor(
        private readonly eventBus: EventBus<GraphCalcEvents>,
        private readonly controls: SegmentedHandle<ViewHome>,
    ) {
        controls.onChange((view) => {
            this.eventBus.emit('camera:view', { view });
        });
    }

    dispose(): void {
        this.controls.dispose();
    }
}
