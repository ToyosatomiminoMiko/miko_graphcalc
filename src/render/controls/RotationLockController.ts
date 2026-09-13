import { EventBus } from '../../service/EventBus';
import type { GraphCalcEvents } from '../../types';

/**
 * 旋转锁定开关:锁定旋转时仍允许平移和缩放.
 */
export class RotationLockController {
    private readonly toggle: HTMLInputElement | null;
    private readonly _abortController = new AbortController();
    private rotationLocked: boolean;

    constructor(private readonly eventBus: EventBus<GraphCalcEvents>) {
        this.toggle = document.getElementById('rotationLockToggle') as HTMLInputElement | null;
        this.rotationLocked = this.toggle?.checked ?? false;
        this.toggle?.addEventListener('change', () => {
            this.rotationLocked = this.toggle?.checked ?? false;
            this.eventBus.emit('camera:rotationLock', { locked: this.rotationLocked });
        }, { signal: this._abortController.signal });

        // 启动时按 DOM 状态同步一次(与同目录其他控制器一致):浏览器软重载
        // 会恢复表单控件的勾选态,若不 emit,锁定态就与 OrbitControls 脱钩.
        this.eventBus.emit('camera:rotationLock', { locked: this.rotationLocked });
    }

    /** 当前是否锁定旋转,供切换向上轴重建 OrbitControls 后恢复. */
    get locked(): boolean {
        return this.rotationLocked;
    }

    dispose(): void {
        this._abortController.abort();
    }
}
