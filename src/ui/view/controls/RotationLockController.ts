import { EventBus } from '../../../core/EventBus';
import type { GraphCalcEvents } from '../../../contract/events';
import type { SwitchHandle } from '../../widgets/Switch';

/**
 * 旋转锁定开关:锁定旋转时仍允许平移和缩放.
 *
 * 初值取开关当前勾选态(面板建它时给了 `false`)而不是 `RENDER_CONFIG`:
 * 面板是唯一给视图灌初值的地方,控制器只把视图当前值收进自己的状态.
 *
 * 注意与老写法的行为差别:老代码读 DOM 的 `checked`,是想接住"浏览器软重载
 * 恢复表单勾选态";现在开关由脚本生成,浏览器不会恢复动态节点的表单态,
 * 所以锁定态一律从默认值起,不再有软重载残留.
 */
export class RotationLockController {
    private rotationLocked: boolean;

    constructor(
        private readonly eventBus: EventBus<GraphCalcEvents>,
        private readonly toggle: SwitchHandle,
    ) {
        this.rotationLocked = toggle.get();
        toggle.onChange((locked) => {
            this.rotationLocked = locked;
            this.eventBus.emit('camera:rotationLock', { locked });
        });

        // 启动时同步一次:面板已经给了初值,这里把同一份值广播出去,
        // 订阅方(OrbitControls)才与 UI 一致.
        this.eventBus.emit('camera:rotationLock', { locked: this.rotationLocked });
    }

    /** 当前是否锁定旋转,供切换向上轴重建 OrbitControls 后恢复. */
    get locked(): boolean {
        return this.rotationLocked;
    }

    dispose(): void {
        this.toggle.dispose();
    }
}
