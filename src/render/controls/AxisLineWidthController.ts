import { EventBus } from '../../service/EventBus';
import type { GraphCalcEvents } from '../../types';
import { RENDER_CONFIG } from '../../config/renderConfig';
import type { NumberFieldHandle } from '../../ui/widgets/NumberField';

/**
 * 坐标轴线宽控制.
 *
 * XYZ 轴使用 Line2 绘制,线宽以像素为单位,最小 1px.
 * 变化通过 EventBus 广播,由 RenderController 应用到场景.
 *
 * 写回策略:这是"即时回退"型输入框 -- `input` 阶段只要解析不出合法值
 * (空串/中途态/小于下限/非有限),就把文本回填成上一个合法值,用户打不出
 * 中途态.需要"保留用户文本,失焦才归一化"的那种(参数面板,UI-P2.1)用同一个
 * 控件的另一种接线,见 `NumberField` 文件头.
 */
export class AxisLineWidthController {
    private width: number;

    constructor(
        private readonly eventBus: EventBus<GraphCalcEvents>,
        private readonly field: NumberFieldHandle,
    ) {
        this.width = field.read() ?? RENDER_CONFIG.scene.axisLineWidth;

        const apply = (raw: number | null): void => this._apply(raw);
        field.onInput(apply);
        field.onCommit(apply);

        // 启动时按面板初值同步一次,保证默认状态进入场景
        this._emit();
    }

    dispose(): void {
        this.field.dispose();
    }

    private _apply(raw: number | null): void {
        if (raw === null || raw < 1) {
            // 非法输入:文本回填上一个合法值,不广播
            this.field.write(this.width);
            return;
        }
        if (raw === this.width) return;
        this.width = raw;
        this._emit();
    }

    private _emit(): void {
        this.eventBus.emit('axis:lineWidthChanged', { width: this.width });
    }
}
