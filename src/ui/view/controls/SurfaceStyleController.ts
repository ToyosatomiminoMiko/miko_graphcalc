import { EventBus } from '@/core/EventBus';
import type { GraphCalcEvents } from '@/contract/events';
import type { SurfaceStyle } from '@/contract/view';
import type { SurfaceControls } from '@/ui/view/ViewPanel';

/**
 * 曲面全局样式控制(右侧"视图"面板的"曲面"小节).
 *
 * 控制所有曲面对象的两种全局显示属性,与"点"/"坐标轴"/"网格"面板一致:
 * - 网格:曲面线框网格显隐(关闭后只显示曲面主体,不叠加采样网格);
 * - 颜色映射:z->HSL 伪彩色映射开关(关闭后曲面显示自身 color 基色).
 *
 * 变化通过 EventBus 广播 `surface:changed`,由 RenderController 应用到场景.
 *
 * 两个开关的初值由面板按 `RENDER_CONFIG.surfaceMesh` 写入,这里从句柄读回,
 * 不再出现 `getElementById('surfaceWireframeVisible')` 这样的 id 字符串.
 */
export class SurfaceStyleController {
    private wireframeVisible: boolean;
    private colorMapEnabled: boolean;

    constructor(
        private readonly eventBus: EventBus<GraphCalcEvents>,
        private readonly controls: SurfaceControls,
    ) {
        this.wireframeVisible = controls.wireframe.get();
        this.colorMapEnabled = controls.colorMap.get();

        controls.wireframe.onChange((visible) => {
            this.wireframeVisible = visible;
            this._emit();
        });
        controls.colorMap.onChange((enabled) => {
            this.colorMapEnabled = enabled;
            this._emit();
        });

        // 启动时按面板初值同步一次,保证默认状态进入场景(与点/轴/网格控制器一致)
        this._emit();
    }

    dispose(): void {
        this.controls.wireframe.dispose();
        this.controls.colorMap.dispose();
    }

    private _emit(): void {
        const style: SurfaceStyle = {
            wireframeVisible: this.wireframeVisible,
            colorMapEnabled: this.colorMapEnabled,
        };
        this.eventBus.emit('surface:changed', style);
    }
}
