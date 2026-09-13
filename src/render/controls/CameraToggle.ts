import { EventBus } from '../../service/EventBus';
import { RENDER_CONFIG } from '../../config/renderConfig';
import type { GraphCalcEvents, CamMode } from '../../types';

/**
 * 复选框语义:勾选 = 正交,未勾选 = 透视.
 *
 * 两个模式字面量只在这里出现一次,`checked <-> CamMode` 的双向映射
 * 以及 `isCamMode` 校验全部由它们推导,避免同一语义在多处手写.
 */
const MODE_WHEN_CHECKED: CamMode = 'orthographic';
const MODE_WHEN_UNCHECKED: CamMode = 'perspective';

/** 运行时校验:把 DOM 读来的字符串收敛为 CamMode,而不是用 as 断言硬转. */
function isCamMode(value: unknown): value is CamMode {
    return value === MODE_WHEN_CHECKED || value === MODE_WHEN_UNCHECKED;
}

/**
 * 相机投影模式切换开关 透视 <-> 正交
 *
 * 同一个状态对应两套 UI:
 * - 复选框 `#camToggle`(checked = 正交);
 * - 可点击的文字标签 `.cam-label`(dataset.cam 记录其代表模式).
 *
 * 因此这里只保留一个状态源 `_mode`:两个入口都经 `_setCamMode` 收口,
 * 再由 `_syncUI` 反向推导两套 UI,任一侧都不自行记录状态.
 */
export class CameraToggle {
    /** 当前投影模式,初始值取自配置,与 CameraManager 保持一致. */
    private _mode: CamMode = RENDER_CONFIG.camera.defaultMode;
    /** 投影模式复选框;HTML 缺失时为 null(与其余控制器一致,不非空断言). */
    private readonly camToggle: HTMLInputElement | null;
    /** 所有可点击的模式标签,通过 data-cam 与 CamMode 对应. */
    private readonly camLabels: NodeListOf<HTMLElement>;
    /** 统一解绑本类注册的所有 DOM 监听,dispose 时 abort. */
    private readonly _abortController = new AbortController();

    constructor(private readonly eventBus: EventBus<GraphCalcEvents>) {
        this.camToggle = document.getElementById('camToggle') as HTMLInputElement | null;
        this.camLabels = document.querySelectorAll('.cam-label');
        const { signal } = this._abortController;

        // 入口一:复选框自身状态就是模式,无需再读 DOM 之外的来源
        this.camToggle?.addEventListener('change', () => {
            this._setCamMode(this.camToggle?.checked ? MODE_WHEN_CHECKED : MODE_WHEN_UNCHECKED);
        }, { signal });

        // 入口二:标签的 data-cam 是 HTML 字符串,先校验再当 CamMode 使用
        this.camLabels.forEach(label => {
            label.addEventListener('click', () => {
                const { cam } = label.dataset;
                if (isCamMode(cam)) this._setCamMode(cam);
            }, { signal });
        });

        // HTML 里的 active/checked 只是首屏占位,真正的初始态由配置决定
        this._syncUI();
    }

    /** 当前投影模式,供只读查询. */
    get mode(): CamMode {
        return this._mode;
    }

    /** 注销全部事件监听,防止组件重建后旧实例继续响应 DOM 事件. */
    dispose(): void {
        this._abortController.abort();
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
        const checked = this._mode === MODE_WHEN_CHECKED;
        // 先比较再赋值,避免无谓的 DOM 写入
        if (this.camToggle && this.camToggle.checked !== checked) {
            this.camToggle.checked = checked;
        }
        this.camLabels.forEach(label => {
            label.classList.toggle('active', label.dataset.cam === this._mode);
        });
    }
}
