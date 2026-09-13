import { EventBus } from '../../service/EventBus';
import type { GraphCalcEvents, ViewHome } from '../../types';

/** 预置视角名单,与 `ViewHome` 一一对应,用于校验 HTML 里的 data-view. */
const VIEW_HOMES: readonly ViewHome[] = [
    'top', 'bottom', 'front', 'back', 'left', 'right', 'isometric',
];

/** 运行时校验:HTML 的 data-* 是字符串,非法值不能直接当 ViewHome 用. */
function isViewHome(value: unknown): value is ViewHome {
    return VIEW_HOMES.includes(value as ViewHome);
}

/**
 * ViewCube 控制器:统一 3D 场景下的预置观察方向切换.
 */
export class ViewCubeController {
    private readonly buttons: NodeListOf<HTMLElement>;
    private readonly _abortController = new AbortController();

    constructor(private readonly eventBus: EventBus<GraphCalcEvents>) {
        this.buttons = document.querySelectorAll<HTMLElement>('[data-view]');
        const signal = this._abortController.signal;

        this.buttons.forEach((button) => {
            button.addEventListener('click', () => {
                const view = button.dataset.view;
                if (!isViewHome(view)) return;

                this.buttons.forEach((item) => item.classList.toggle('active', item === button));
                this.eventBus.emit('camera:view', { view });
            }, { signal });
        });
    }

    dispose(): void {
        this._abortController.abort();
    }
}
