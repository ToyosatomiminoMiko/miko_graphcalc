/**
 * 项目对外的类型汇总.
 *
 * 场景对象/分析/积分与数值积分辅助类型统一来自 `compiler/ir/types`;
 * 视图类型来自 `render/types`,事件类型来自 `service/events`.
 *
 * 预留说明:当前内部代码直接按目录导入领域类型,这个汇总出口主要为未来
 * 外部模块/文档/测试提供单一入口;若确认没有消费者,应删除这些重导出.
 */
export type {
    Coefficient,
    CurveObject,
    SurfaceObject,
    PointObject,
    VectorObject,
    VectorFieldObject,
    SceneObject,
    AnalysisResult,
    IntegralTask,
    SceneIR,
    Range1D,
} from './compiler/ir/types';

export type {
    CamMode,
    ViewHome,
} from './render/types';

export type { GraphCalcEvents } from './service/events';
