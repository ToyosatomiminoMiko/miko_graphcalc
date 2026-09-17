import { EventBus } from '@/core/EventBus';
import type { GraphCalcEvents } from '@/contract/events';
import { RENDER_CONFIG } from '@/config/renderConfig';
import { UI_CONFIG } from '@/config/uiConfig';
import type { GridPlane } from '@/contract/view';
import type { AxisControls } from '@/ui/view/ViewPanel';
import type { NumberFieldHandle } from '@/ui/widgets/NumberField';

/** 遍历三个坐标平面时的固定顺序;类型上就是 `GridPlane` 的全集. */
const PLANES: readonly GridPlane[] = ['xz', 'xy', 'yz'];

/**
 * 网格与坐标轴刻度控制.
 *
 * - XZ/XY/YZ 三个坐标平面网格各自独立的可见性开关 + 刻度开关;
 * - 刻度单位开关:普通整数步长 / π 步长(网格与刻度改按 π/2 重排);
 * - 大刻度线宽,小刻度线宽(像素),同时作用于网格线和坐标轴刻度.
 * 变化通过 EventBus 广播,由 RenderController 应用到场景.
 *
 * 只接管 `AxisControls` 里属于"网格/刻度"的那部分句柄(`grids` / `ticks` /
 * `piUnit` / `majorWidth` / `minorWidth`);同一分组里的 up / lineWidth /
 * labels 归别的控制器,这里不碰也就不会 dispose 错对象.
 *
 * 两个线宽输入框沿用"即时回退"策略(见 `NumberField` 文件头):非法文本当场
 * 回填上一个合法值,只是这个"上一个合法值"由本控制器的状态提供,而不是让
 * 控件自己猜.
 */
export class GridTicksController {
    private readonly planeVisible: Record<GridPlane, boolean>;
    private ticksVisible: boolean;
    private piUnit: boolean;
    private majorWidth: number;
    private minorWidth: number;

    constructor(
        private readonly eventBus: EventBus<GraphCalcEvents>,
        private readonly controls: AxisControls,
    ) {
        const { grids, ticks, piUnit, majorWidth, minorWidth } = controls;

        this.planeVisible = {
            xz: grids.xz.get(),
            xy: grids.xy.get(),
            yz: grids.yz.get(),
        };
        this.ticksVisible = ticks.get();
        this.piUnit = piUnit.get();
        this.majorWidth = majorWidth.read() ?? RENDER_CONFIG.scene.grid.majorLineWidth;
        this.minorWidth = minorWidth.read() ?? RENDER_CONFIG.scene.grid.minorLineWidth;

        for (const plane of PLANES) {
            grids[plane].onChange((visible) => {
                this.planeVisible[plane] = visible;
                this._emit();
            });
        }
        ticks.onChange((visible) => {
            this.ticksVisible = visible;
            this._emit();
        });
        piUnit.onChange((enabled) => {
            this.piUnit = enabled;
            this._emit();
        });
        this._wireWidth(majorWidth, 'major');
        this._wireWidth(minorWidth, 'minor');

        // 启动时按面板初值同步一次,保证默认状态进入场景
        this._emit();
    }

    dispose(): void {
        for (const plane of PLANES) this.controls.grids[plane].dispose();
        this.controls.ticks.dispose();
        this.controls.piUnit.dispose();
        this.controls.majorWidth.dispose();
        this.controls.minorWidth.dispose();
    }

    /** 线宽输入框接线:非法输入回填上一个合法值,合法输入立即广播. */
    private _wireWidth(field: NumberFieldHandle, kind: 'major' | 'minor'): void {
        // 下限与面板写给数字框的 `min` 同源(UI_CONFIG.view.axis)
        const min = kind === 'major'
            ? UI_CONFIG.view.axis.gridMajorMin
            : UI_CONFIG.view.axis.gridMinorMin;
        const apply = (raw: number | null): void => {
            const current = kind === 'major' ? this.majorWidth : this.minorWidth;
            if (raw === null || raw < min) {
                field.write(current);
                return;
            }
            if (raw === current) return;
            if (kind === 'major') {
                this.majorWidth = raw;
            } else {
                this.minorWidth = raw;
            }
            this._emit();
        };
        field.onInput(apply);
        field.onCommit(apply);
    }

    private _emit(): void {
        this.eventBus.emit('grid:changed', {
            xzVisible: this.planeVisible.xz,
            xyVisible: this.planeVisible.xy,
            yzVisible: this.planeVisible.yz,
            ticksVisible: this.ticksVisible,
            piUnit: this.piUnit,
            majorWidth: this.majorWidth,
            minorWidth: this.minorWidth,
        });
    }
}
