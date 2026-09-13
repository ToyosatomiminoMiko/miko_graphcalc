import type { CamMode, ViewHome } from '../render/types';
import type { UpAxis } from '../config/renderConfig';

/**
 * EventBus 的事件映射.
 *
 * EventBus 的适用范围明确为"视图控件事件"(相机/坐标轴/网格/点样式):
 * 这些控件在 UI 面板里自行 emit,RenderController 统一订阅.
 *
 * 业务数据(参数/对象列表/诊断/积分结果)由 DslApp/RenderController 直接
 * 回调注入,不走 EventBus;避免两条通信链路在事件类型里互相纠缠.
 *
 * 注意:新增事件键之前必须先有真实 emit 点,不允许留下 dead event keys.
 */
export interface GraphCalcEvents {
    'camera:changed': { camMode: CamMode };
    'camera:view': { view: ViewHome };
    'camera:rotationLock': { locked: boolean };
    'axis:upChanged': { axis: UpAxis };
    'axis:lineWidthChanged': { width: number };
    'axis:labelVisibility': { x: boolean; y: boolean; z: boolean };
    'grid:changed': {
        xzVisible: boolean;
        xyVisible: boolean;
        yzVisible: boolean;
        ticksVisible: boolean;
        /** 刻度数字是否使用 π 单位显示 */
        piUnit: boolean;
        majorWidth: number;
        minorWidth: number;
    };
    'point:changed': { radius: number; visible: boolean };
    'surface:changed': { wireframeVisible: boolean; colorMapEnabled: boolean };
}
