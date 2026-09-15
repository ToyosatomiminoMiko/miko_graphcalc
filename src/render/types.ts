/**
 * 渲染层共享类型.
 *
 * 这里放相机/视图控件的**值域**类型,供 `render/core`,`render/controls` 与
 * 视图面板(`ui/view/ViewPanel`)共同使用:面板用它们给控件定类型,控制器用
 * 它们解释选中值,两边必须是同一个联合类型 -- 否则又会退化成"从 DOM 的
 * `data-*` 字符串里还原类型"的那套运行时校验(`isCamMode` / `isViewHome` /
 * `isPointMode`),那是组件化要消掉的东西.
 *
 * 注意:这里不要反向依赖 `service` 或 `compiler/dsl`.
 */

export type CamMode = 'perspective' | 'orthographic';
export type ViewHome = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'isometric';

/** 点的显示方式(右侧"视图 -> 点"面板的"设定大小 / 按比例缩放"二选一). */
export type PointMode = 'size' | 'scale';

/** 坐标轴名:各轴标签开关的键.与 `UpAxis` 同形,但语义是"某条轴". */
export type AxisName = 'x' | 'y' | 'z';

/** 坐标平面网格名:三个平面各自独立显隐. */
export type GridPlane = 'xz' | 'xy' | 'yz';

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
