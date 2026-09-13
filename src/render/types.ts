/**
 * 渲染层共享类型.
 *
 * 当前只放相机相关类型,供 `render/core` 与 `render/controls` 共同使用.
 * 注意:这里不要反向依赖 `service` 或 `compiler/dsl`.
 */

export type CamMode = 'perspective' | 'orthographic';
export type ViewHome = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'isometric';

/**
 * 曲面全局显示样式(右侧"视图"面板的"曲面"小节统一控制所有曲面).
 *
 * 与点样式(point)/坐标轴/网格一致,这是一份**全局**样式,由
 * `RenderController` 订阅 `surface:changed` 后应用到场景里每一个
 * `SurfaceRenderer`;单个曲面对象自身的 `color` 选项作为关闭颜色映射时的
 * 基色,见 `SurfaceMesh`.
 */
export type SurfaceStyle = {
    /** 是否显示曲面线框网格(采样网格叠加在曲面上的线框) */
    wireframeVisible: boolean;
    /** 是否启用 z->HSL 伪彩色映射;关闭时曲面显示自身基色(对象 color) */
    colorMapEnabled: boolean;
};
