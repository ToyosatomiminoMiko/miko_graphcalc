import { EventBus } from '../../service/EventBus';
import type { GraphCalcEvents } from '../../types';
import { RENDER_CONFIG } from '../../config/renderConfig';

/**
 * 网格与坐标轴刻度控制.
 *
 * - XZ/XY/YZ 三个坐标平面网格各自独立的可见性开关 + 刻度开关;
 * - 刻度单位开关:普通整数步长 / π 步长(网格与刻度改按 π/2 重排);
 * - 大刻度线宽,小刻度线宽(像素),同时作用于网格线和坐标轴刻度.
 * 变化通过 EventBus 广播,由 RenderController 应用到场景.
 */
export class GridTicksController {
    private readonly planeToggles: Record<'xz' | 'xy' | 'yz', HTMLInputElement | null>;
    private readonly ticksToggle: HTMLInputElement | null;
    private readonly piUnitToggle: HTMLInputElement | null;
    private readonly majorWidthInput: HTMLInputElement | null;
    private readonly minorWidthInput: HTMLInputElement | null;
    private readonly _abortController = new AbortController();

    private readonly planeVisible: Record<'xz' | 'xy' | 'yz', boolean> = {
        xz: RENDER_CONFIG.scene.grid.planes.xz,
        xy: RENDER_CONFIG.scene.grid.planes.xy,
        yz: RENDER_CONFIG.scene.grid.planes.yz,
    };
    private ticksVisible = RENDER_CONFIG.scene.axisTicks.visible;
    private piUnit = RENDER_CONFIG.scene.axisTicks.piUnit;
    private majorWidth = RENDER_CONFIG.scene.grid.majorLineWidth;
    private minorWidth = RENDER_CONFIG.scene.grid.minorLineWidth;

    constructor(private readonly eventBus: EventBus<GraphCalcEvents>) {
        this.planeToggles = {
            xz: document.getElementById('gridVisibleXZ') as HTMLInputElement | null,
            xy: document.getElementById('gridVisibleXY') as HTMLInputElement | null,
            yz: document.getElementById('gridVisibleYZ') as HTMLInputElement | null,
        };
        this.ticksToggle =
            document.getElementById('axisTicksVisible') as HTMLInputElement | null;
        this.piUnitToggle =
            document.getElementById('axisTicksPiUnit') as HTMLInputElement | null;
        this.majorWidthInput =
            document.getElementById('gridMajorWidth') as HTMLInputElement | null;
        this.minorWidthInput =
            document.getElementById('gridMinorWidth') as HTMLInputElement | null;

        (['xz', 'xy', 'yz'] as const).forEach((plane) => {
            const toggle = this.planeToggles[plane];
            if (toggle) toggle.checked = this.planeVisible[plane];
        });
        if (this.ticksToggle) this.ticksToggle.checked = this.ticksVisible;
        if (this.piUnitToggle) this.piUnitToggle.checked = this.piUnit;
        if (this.majorWidthInput) this.majorWidthInput.value = String(this.majorWidth);
        if (this.minorWidthInput) this.minorWidthInput.value = String(this.minorWidth);

        const signal = this._abortController.signal;
        (['xz', 'xy', 'yz'] as const).forEach((plane) => {
            const toggle = this.planeToggles[plane];
            toggle?.addEventListener('change', () => {
                this.planeVisible[plane] = toggle?.checked ?? true;
                this._emit();
            }, { signal });
        });
        this.ticksToggle?.addEventListener('change', () => {
            this.ticksVisible = this.ticksToggle?.checked ?? true;
            this._emit();
        }, { signal });
        this.piUnitToggle?.addEventListener('change', () => {
            this.piUnit = this.piUnitToggle?.checked ?? false;
            this._emit();
        }, { signal });
        this.majorWidthInput?.addEventListener('input', () => this._readWidth('major'), { signal });
        this.majorWidthInput?.addEventListener('change', () => this._readWidth('major'), { signal });
        this.minorWidthInput?.addEventListener('input', () => this._readWidth('minor'), { signal });
        this.minorWidthInput?.addEventListener('change', () => this._readWidth('minor'), { signal });

        // 启动时按配置同步一次,保证默认状态进入场景
        this._emit();
    }

    dispose(): void {
        this._abortController.abort();
    }

    private _readWidth(kind: 'major' | 'minor'): void {
        const input = kind === 'major' ? this.majorWidthInput : this.minorWidthInput;
        if (!input) return;
        const min = kind === 'major' ? 1 : 0.5;
        const fallback = kind === 'major' ? this.majorWidth : this.minorWidth;
        const text = input.value.trim();
        if (text === '') {
            input.value = String(fallback);
            return;
        }
        const raw = Number(text);
        if (!Number.isFinite(raw) || raw < min) {
            input.value = String(fallback);
            return;
        }
        if (kind === 'major') {
            this.majorWidth = raw;
        } else {
            this.minorWidth = raw;
        }
        this._emit();
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
