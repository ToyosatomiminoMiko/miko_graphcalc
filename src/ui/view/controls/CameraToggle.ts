import { EventBus } from '../../../core/EventBus';
import type { GraphCalcEvents } from '../../../contract/events';
import type { CamMode } from '../../../contract/view';
import type { CameraControls } from '../ViewPanel';
import {
    CAM_MODE_WHEN_CHECKED,
    CAM_MODE_WHEN_UNCHECKED,
} from '../ViewPanel';
import type { SwitchHandle } from '../../widgets/Switch';

/**
 * 相机投影模式切换开关 透视 <-> 正交
 *
 * 同一个状态对应两套 UI:
 * - 开关 `camera.toggle`(勾选 = 正交,语义见 ViewPanel 的同名常量);
 * - 可点击的文字标签 `camera.modeLabels`(点"透视"/"正交"直接切).
 *
 * 因此这里只保留一个状态源 `_mode`:两个入口都经 `_setCamMode` 收口,
 * 再由 `_syncUI` 反向推导两套 UI,任一侧都不自行记录状态.
 *
 * 与老写法的差别:节点不再靠 `getElementById` / `querySelectorAll` 全局找,
 * 而是构造时收进 `CameraControls`;模式初值也不再直接读 `RENDER_CONFIG`,
 * 而是从开关的勾选态解释出来 -- 面板已经把配置初值灌进控件了.
 */
export class CameraToggle {
    /** 当前投影模式,初值由面板写入的勾选态解释而来. */
    private _mode: CamMode;
    private readonly toggle: SwitchHandle;
    /** 统一解绑本类注册的 label 点击监听,dispose 时 abort. */
    private readonly _abortController = new AbortController();

    constructor(
        private readonly eventBus: EventBus<GraphCalcEvents>,
        private readonly controls: CameraControls,
    ) {
        this.toggle = controls.toggle;
        this._mode = this.toggle.get() ? CAM_MODE_WHEN_CHECKED : CAM_MODE_WHEN_UNCHECKED;

        // 入口一:开关自身状态就是模式,无需再读 DOM 之外的来源
        this.toggle.onChange((checked) => {
            this._setCamMode(checked ? CAM_MODE_WHEN_CHECKED : CAM_MODE_WHEN_UNCHECKED);
        });

        // 入口二:面板交来的标签已带类型化的 mode,不必再从 data-cam 解析
        const { signal } = this._abortController;
        for (const label of controls.modeLabels) {
            label.element.addEventListener(
                'click',
                () => this._setCamMode(label.mode),
                { signal },
            );
        }

        this._syncUI();
    }

    /** 当前投影模式,供只读查询. */
    get mode(): CamMode {
        return this._mode;
    }

    /** 注销全部事件监听,防止组件重建后旧实例继续响应 DOM 事件. */
    dispose(): void {
        this._abortController.abort();
        this.toggle.dispose();
    }

    /**
     * 唯一状态写入点:更新状态,广播事件并刷新两套 UI.
     * 模式未变化时直接返回,避免重复 emit 触发下游相机无谓重建.
     */
    private _setCamMode(mode: CamMode): void {
        if (mode === this._mode) return;
        this._mode = mode;
        this.eventBus.emit('camera:changed', { camMode: mode });
        this._syncUI();
    }

    /** 由 `_mode` 推导两套 UI:开关勾选态与标签高亮,避免两边各写一套映射. */
    private _syncUI(): void {
        this.toggle.set(this._mode === CAM_MODE_WHEN_CHECKED);
        for (const label of this.controls.modeLabels) {
            label.element.classList.toggle('active', label.mode === this._mode);
        }
    }
}
