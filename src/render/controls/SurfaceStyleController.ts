import { EventBus } from '../../service/EventBus';
import type { GraphCalcEvents } from '../../types';
import { RENDER_CONFIG } from '../../config/renderConfig';
import type { SurfaceStyle } from '../types';

/**
 * 曲面全局样式控制(右侧"视图"面板的"曲面"小节).
 *
 * 控制所有曲面对象的两种全局显示属性,与"点"/"坐标轴"/"网格"面板一致:
 * - 网格:曲面线框网格显隐(关闭后只显示曲面主体,不叠加采样网格);
 * - 颜色映射:z->HSL 伪彩色映射开关(关闭后曲面显示自身 color 基色).
 *
 * 变化通过 EventBus 广播 `surface:changed`,由 RenderController 应用到场景.
 */
export class SurfaceStyleController {
    private readonly wireframeToggle: HTMLInputElement | null;
    private readonly colorMapToggle: HTMLInputElement | null;
    private readonly _abortController = new AbortController();

    private wireframeVisible = RENDER_CONFIG.surfaceMesh.wireframeVisible;
    private colorMapEnabled = RENDER_CONFIG.surfaceMesh.colorMapEnabled;

    constructor(private readonly eventBus: EventBus<GraphCalcEvents>) {
        this.wireframeToggle =
            document.getElementById('surfaceWireframeVisible') as HTMLInputElement | null;
        this.colorMapToggle =
            document.getElementById('surfaceColorMapEnabled') as HTMLInputElement | null;

        if (this.wireframeToggle) this.wireframeToggle.checked = this.wireframeVisible;
        if (this.colorMapToggle) this.colorMapToggle.checked = this.colorMapEnabled;

        const signal = this._abortController.signal;
        this.wireframeToggle?.addEventListener('change', () => {
            this.wireframeVisible = this.wireframeToggle?.checked ?? true;
            this._emit();
        }, { signal });
        this.colorMapToggle?.addEventListener('change', () => {
            this.colorMapEnabled = this.colorMapToggle?.checked ?? true;
            this._emit();
        }, { signal });

        // 启动时按配置同步一次,保证默认状态进入场景(与点/轴/网格控制器一致)
        this._emit();
    }

    dispose(): void {
        this._abortController.abort();
    }

    private _emit(): void {
        const style: SurfaceStyle = {
            wireframeVisible: this.wireframeVisible,
            colorMapEnabled: this.colorMapEnabled,
        };
        this.eventBus.emit('surface:changed', style);
    }
}
