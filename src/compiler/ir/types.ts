/**
 * 场景 IR -- 语言层与渲染层之间的唯一稳定数据边界.
 *
 * 这里只允许出现"纯数据":
 * - 不引用外部数学库的 AST 类型
 * - 不引用 three.js 的任何类型
 * - 不引用 DOM
 *
 * DslCompiler 负责把 AST 编译成这份 IR;Web/桌面渲染器只消费这份 IR.
 * 表达式统一用字符串保存,渲染器需要求值时再由各自的执行后端处理.
 */

/** `param` 声明生成的参数面板项. */
export interface ParamDeclaration {
    name: string;
    value: number;
    min: number;
    max: number;
    step: number;
    /**
     * 循环类系数:DSL 写 `param φ = 0 in cyclic [min, max, step]` 时为 true.
     *
     * 循环量的取值域是**圆周**而不是线段:min 与 max 是同一点(球坐标方位角
     * φ 的 `[-π, π]`,经度 `[-180, 180]` 都是这个形状),所以越界值按区间
     * 长度取模回绕到 `[min, max)`,而不是普通参数那样夹到端点.归一化只在
     * `compiler/dsl/params.ts` 一处发生(声明校验/覆盖/scope 共用),
     * 下游(物化,分析,积分,渲染)读到的永远已经是回绕后的值.
     *
     * 是否循环必须由 DSL **显式声明**,不从范围/名字推断:普通参数哪怕区间
     * 恰好是 `[-π, π]` 也照旧夹取,避免静默改变既有场景语义.
     */
    cyclic: boolean;
}

/**
 * 对象上出现的自由参数.
 *
 * 与 `ParamDeclaration` 形状一致,物化时从声明/隐式默认值复制而来;
 * 用同一形状避免两侧默认值口径漂移.
 */
export type Coefficient = ParamDeclaration;

/**
 * 求导来源:只有 `derivative` 语句生成的 curve/surface 才携带.
 *
 * 存在意义:产物在数值/渲染上与手写对象完全同构,但公式展示要保留微分算子,
 * 括号里放**源函数**(数学上是 d/dx(f),不是"对导函数再求一次导"),再由公式层
 * 把对象自身的 expr(真正求出的导函数)接在等号右侧.
 * 渲染/求值路径不读这个字段,它只服务于 sceneObjectLatex 的公式拼装.
 */
export interface DerivativeOrigin {
    /** 被求导的源表达式(未求导的归一化结果). */
    sourceExpr: string;
    /** 求导变量:curve 恒为 x,surface 为 x 或 y. */
    variable: 'x' | 'y';
}

/** 曲线对象:y = f(x),渲染在 z=0 平面. */
export interface CurveObject {
    kind: 'curve';
    id: number;
    name: string;
    /** 纯字符串表达式,例如 `sin(x * a)`. */
    expr: string;
    coefficients: Coefficient[];
    color: string;
    enabled: boolean;
    range?: [number, number];
    segments?: number;
    /** 该 curve 由 `derivative` 生成时给出源函数与求导变量. */
    derivativeOrigin?: DerivativeOrigin;
}

/** 曲面对象:z = f(x, y). */
export interface SurfaceObject {
    kind: 'surface';
    id: number;
    name: string;
    /** 纯字符串表达式,例如 `sin(x) * cos(y)`. */
    expr: string;
    coefficients: Coefficient[];
    color: string;
    enabled: boolean;
    range: [number, number, number, number];
    segments?: number;
    /** 该 surface 由 `derivative` 生成时给出源函数与求导变量. */
    derivativeOrigin?: DerivativeOrigin;
}

/** 向量场对象:F(x, y, z) = [P, Q, R]. */
export interface VectorFieldObject {
    kind: 'vector_field';
    id: number;
    name: string;
    /** 三个分量的字符串表达式. */
    components: [string, string, string];
    coefficients: Coefficient[];
    color: string;
    enabled: boolean;
    range: {
        x: [number, number];
        y: [number, number];
        z: [number, number];
    };
    gridSize: [number, number, number];
    glyphScale: number;
    /**
     * 该向量场由 `derivative` 对隐式场/球体求梯度得到时给出源函数.
     *
     * 存在意义与 `DerivativeOrigin` 相同:产物在数值/渲染上与手写
     * vector_field 完全同构,但公式展示要保留梯度算子 ∇,括号里放源标量场
     * (数学上是 ∇f,不是"对向量场再求导"),再由公式层把三分量接在等号右侧.
     * 渲染/求值路径不读这个字段,它只服务于 sceneObjectLatex 的公式拼装.
     */
    gradientOrigin?: { sourceExpr: string };
}

/**
 * 隐式标量场对象:`f(x,y) = level`(二维隐式曲线)或 `f(x,y,z) = level`
 * (三维 level-set 曲面).
 *
 * 语义边界(V1):
 * - 它只声明"哪个水平集",**不携带自己的网格几何**;本体的 marching
 *   squares/cubes 采网渲染留到后续(见 prompt/roadmap),当前作为
 *   `gradient` / `derivative` 的分析源参与编译;
 * - `dim` 由表达式里出现的坐标变量推断(含 z 为 3,否则为 2),不在语法里
 *   写死;`level` 是把方程写成 `f = level` 的右端(缺省 0);
 * - 与 `curve`/`surface` 一样,表达式先经 Rust 符号引擎归一化,符号偏导
 *   与数值求值全部走既有 WASM 管线,不新增数值内核.
 */
export interface ImplicitObject {
    kind: 'implicit';
    id: number;
    name: string;
    /** 归一化后的标量场表达式 f(x,y[,z]). */
    expr: string;
    /** 2 = f(x,y)=level 隐式曲线;3 = f(x,y,z)=level 等值面. */
    dim: 2 | 3;
    /** 等值面/等值线的水平值 level(缺省 0). */
    level: number;
    /** 表达式里引用的自由参数,供参数面板与增量刷新使用. */
    coefficients: Coefficient[];
    color: string;
    enabled: boolean;
}

/** 空间点(暂未接入 DSL,但保留为可渲染对象). */
export interface PointObject {
    kind: 'point';
    id: number;
    name?: string;
    /** 原始坐标表达式,例如 `[a, b, 3]`. */
    expr: string;
    x: number;
    y: number;
    z: number;
    color: string;
    enabled: boolean;
}

/** 空间向量(暂未接入 DSL,但保留为可渲染对象). */
export interface VectorObject {
    kind: 'vector';
    id: number;
    name?: string;
    /** 原始向量表达式,例如 `[[0, j, 0], [1, k, 0]]`. */
    expr: string;
    origin: { x: number; y: number; z: number };
    direction: { x: number; y: number; z: number };
    color: string;
    enabled: boolean;
}

/** 三维位置或尺寸分量,保持 IR 不依赖 three.js. */
export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

/** 球体体积对象:中心点 + 半径. */
export interface SphereObject {
    kind: 'sphere';
    id: number;
    name: string;
    /** 原始 DSL 表达式,例如 `[x, y, z]`. */
    expr: string;
    position: Vec3;
    radius: number;
    /** 半径/位置中出现的自由参数,供参数面板与增量刷新使用. */
    coefficients: Coefficient[];
    color: string;
    opacity: number;
    /** 径向分段数,只影响可视化质量,不改变数学半径. */
    segments: number;
    enabled: boolean;
}

/** 轴对齐方块体积对象:中心点 + 三轴尺寸. */
export interface BoxObject {
    kind: 'box';
    id: number;
    name: string;
    /** 原始 DSL 表达式,例如 `[x, y, z]`. */
    expr: string;
    position: Vec3;
    size: [number, number, number];
    /** size/位置中出现的自由参数. */
    coefficients: Coefficient[];
    color: string;
    opacity: number;
    enabled: boolean;
}

/**
 * 圆柱 / 圆锥 / 圆台的统一体积对象.
 *
 * 三种形体只用上下底半径和高描述:
 * - 圆柱:topRadius === baseRadius
 * - 圆锥:topRadius === 0
 * - 圆台:0 < topRadius < baseRadius
 *
 * `sideAngle` 是母线相对轴的夹角,单位为弧度,由上下底半径和高推出;
 * 同时保留它方便诊断和后续可视化控制.
 */
export interface ConicSolidObject {
    kind: 'conic';
    id: number;
    name: string;
    /** 原始 DSL 表达式,例如 `[x, y, z]`. */
    expr: string;
    position: Vec3;
    baseRadius: number;
    topRadius: number;
    height: number;
    sideAngle: number;
    /** 几何参数/位置中出现的自由参数. */
    coefficients: Coefficient[];
    color: string;
    opacity: number;
    /** 圆周分段数. */
    segments: number;
    enabled: boolean;
}

/**
 * 面积图形(区域实体,仅 V1 "x 型带状").
 *
 * V1 语义:D = { a ≤ x ≤ b, min(c1,c2)(x) ≤ y ≤ max(c1,c2)(x) },绘制在
 * z=0 平面;`range` 是 x 区间(缺省取两边界曲线 x-range 交集).
 * 区域不持有曲线几何拷贝,只按名/引用边界曲线,滑块变化时随既有 dirty 链路
 * 一并重画.
 *
 * 后续规划(roadmap,实现时保持本注释同步):
 * - y 型区域(左右边界为曲线);
 * - 极坐标 r-θ 区域;
 * - 三条以上曲线边界围成区域;
 * - 区域参与求交(与 curve/surface/solid 的交);
 * - region 作为曲面底域(曲顶柱体,直接由本区域上二重积分的可视化近似).
 */
export interface RegionObject {
    kind: 'region';
    id: number;
    name: string;
    /** 边界曲线对象名(必须引用已声明的 `curve`). */
    curveAName: string;
    curveBName: string;
    /** x 区间 [a, b];编译期解析为两曲线 x-range 交集或显式 range. */
    range: [number, number];
    /** 两边界曲线系数并集(+range 内参数);滑块变化时区域与其积分自动重算. */
    coefficients: Coefficient[];
    color: string;
    opacity: number;
    /** 边界/填充采样,受预算上限约束. */
    segments: number;
    enabled: boolean;
}

/**
 * 场景中所有数学对象的联合类型.
 *
 * 注意:`point` / `vector` 是保留对象类型,后续会补 DSL 语法;
 * 当前先恢复渲染能力,不继续按 legacy 删除.
 */
export type SceneObject =
    | CurveObject
    | SurfaceObject
    | VectorFieldObject
    | PointObject
    | VectorObject
    | SphereObject
    | BoxObject
    | ConicSolidObject
    | RegionObject
    | ImplicitObject;

/**
 * 微分分析结果(纯数值结果).
 *
 * 这里只保留已实现算子;AST 侧的 `AnalysisOpKind` 还会带
 * `jacobian`/`laplacian`,用于在编译期给出"暂未实现"诊断.
 */
export type AnalysisOp = 'gradient' | 'divergence' | 'curl';
/**
 * 分析可视化中的可画元素:
 * - `point`/`normal`:通用,点 + 法向(曲线求导时为切线的法向)箭矢;
 * - `tangent_plane`:曲面 gradient(偏导)的切平面;
 * - `tangent`:一元 curve 的 gradient(求导)在分析点处的切线.
 */
export type AnalysisShow = 'point' | 'normal' | 'tangent' | 'tangent_plane';

export interface AnalysisResult {
    name: string;
    op: AnalysisOp;
    point: [number, number, number];
    /**
     * 算子的**符号定义**在分析点处的展开(LaTeX),供结果列表做"中间步骤".
     *
     * 与求导对象(见 `DerivativeOrigin`)同一套展示契约:先把算子作用在源函数
     * 上写成公式,再给数值结果,读者才看得出数值是怎么来的.梯度写作
     * `∇f = (f_x, f_y, f_z)`(curve 的 f_y 记 0),系数保持符号(如 `a`),
     * 由 `cachedDerivativeExpression` 在声明级做一次符号求导得到.
     *
     * 标量场源(curve/surface/implicit/球体)的 gradient 给值;divergence/curl
     * 的定义需要向量场分量,IR 里没有逐分量符号表达式,故为 undefined,
     * 列表此时只给数值.渲染/数值路径不读这个字段.
     */
    symbolic?: string;
    /**
     * 分析点相对世界原点的球坐标 `[r, θ, φ]`,供结果列表展示.
     *
     * 只对隐式场/球体的 gradient 给值(它们的 `at` 可以用球坐标显式声明,
     * 结果也就用同一套坐标回显);θ/φ 约定见
     * `math/CoordinateSystem.ts` 与 `numericConfig.analysis.
     * sphericalAngleConvention`.其余分析为 undefined.
     */
    pointSpherical?: [number, number, number];
    vector: [number, number, number];
    /**
     * 切线方向(未归一化,(1, f', 0),位于 z=0 曲线平面).
     *
     * 仅 curve 源的 gradient 分析给值:方向 = (1, f'(px), 0),即"Δx 走 1,
     * Δy 走 f'",与法向 `vector` = (-f', 1, 0) 归一化后在平面内正交;
     * 曲面/向量场分析为 null.渲染层画 `show` 里的 `tangent`(切线)时
     * 以分析点为中心,按该方向(x 分量为 1,长度即 x 向半长)取端点.
     */
    tangent: [number, number, number] | null;
    scalar: number | null;
    show: AnalysisShow[];
    /** 求值对象是否参与计算.为 false 时仅保留列表项,不执行数值计算. */
    enabled: boolean;
}

/** 数值积分任务. */
export type RiemannSide = 'left' | 'right' | 'mid';

/**
 * DSL 中的 method 作为整串进入 IR:
 * - 黎曼区分端点:`riemann:left` / `riemann:right` / `riemann:mid`;
 * - DSL 里写裸 `riemann` 时编译期归一化为 `riemann:left`(兼容旧写法).
 *
 * 方法 × 域矩阵(见 prompt/feature.md §方法矩阵)放宽后,right/mid 对所有
 * 域(1D 曲线 / 2D 矩形 / 2D 区域 / 3D 实体)统一取"格点采样端 = 方法端",
 * 数值与可视化同源.
 *
 * **名字清单的唯一来源**:方法语义名同时存在于 Rust 侧
 * `src/math/math_rs/src/integral_method.rs`
 * (`IntegralMethod::parse`/`semantic_name`).两边以本数组 + 那份 parse 表
 * 为准,加新方法时必须两处同步;中间层(IntegralCompute/Worker)只透传字符串,
 * 不再各自维护第二份名单.
 */
export const INTEGRAL_METHOD_NAMES = [
    'trapezoid',
    'simpson',
    'riemann:left',
    'riemann:right',
    'riemann:mid',
    'lebesgue',
] as const;

export type IntegralMethod = (typeof INTEGRAL_METHOD_NAMES)[number];

/**
 * 积分域的显式维度与种类.
 *
 * 早期实现用 `range` 长度(2/4)推断一维/二维,region/solid 域会失配,
 * 因此 IR 改为显式 `dim` + `domainKind`,不再从 range 长度反推:
 * - interval(1D):曲线域,积分区间 [a, b];
 * - rectangle(2D):曲面矩形域,[xa, xb, ya, yb];
 * - region(2D):面积图形带域,仅 x 区间 [a, b](y 上下界由边界曲线给出);
 * - solid(3D):体积实体域(sphere/box/conic),无 range 字段.
 */
export type IntegralDomainKind = 'interval' | 'rectangle' | 'region' | 'solid';

export interface IntegralTask {
    name: string;
    objectId: number;
    /** 被积分源对象种类;与 `dim`/`domainKind` 一起构成显式语义. */
    sourceKind: 'curve' | 'surface' | 'region' | 'sphere' | 'box' | 'conic';
    /** 显式维度,不再由 range 长度推断. */
    dim: 1 | 2 | 3;
    /** 显式域种类. */
    domainKind: IntegralDomainKind;
    method: IntegralMethod;
    /**
     * 被积函数表达式(归一化后字符串).
     *
     * - curve/surface 源 = 对象自带表达式(与旧行为一致);
     * - region/solid 源 = 选项 `integrand`,缺省 `"1"`(即求区域面积/体积);
     * - 变量一律为世界坐标(x,y,z 与场景坐标轴一致).
     */
    integrand: string;
    /**
     * 被积表达式里引用的自由参数(缺省 integrand=1 时为空数组).
     *
     * 它们与域对象自身的 coefficients 一起决定参数刷新的 dirty 判定:
     * 拖动滑块时只要命中其中任一参数,积分任务就重算.
     */
    integrandCoefficients: Coefficient[];
    /**
     * segments/layers 等计数选项里引用的自由参数.
     *
     * 计数允许写参数(如 `segments = k`),因此 k 变化时积分任务也必须重算;
     * 它们只参与参数刷新的 dirty 判定,不参与数值计算(segments/layers 已在
     * 编译期求成具体数字).
     */
    countCoefficients: Coefficient[];
    /**
     * 积分区间:
     * - interval: [a, b];
     * - rectangle: [xa, xb, ya, yb];
     * - region: [a, b](x 区间,缺省取区域自身的 x 区间);
     * - solid: 缺省缺省(域 = 渲染出的世界实体,外接盒由 Rust 核推导).
     */
    range?: [number, number] | [number, number, number, number];
    segments: number;
    layers: number;
    show: boolean;
    /** 求值对象是否参与计算.为 false 时仅保留列表项,不执行数值计算. */
    enabled: boolean;
}

/**
 * 求交任务(编译产物).
 *
 * 编译器只负责描述"要算哪两个对象,用什么分辨率",真正的数值计算由
 * Worker + Rust `intersection_core` 异步完成;结果缓存与渲染由
 * IntersectionRenderer 按任务名管理.
 */
export interface IntersectionTask {
    name: string;
    aName: string;
    bName: string;
    aId: number;
    bId: number;
    segments: number;
    color: string;
    /** 求交任务是否参与计算.为 false 时仅保留列表项,不执行数值计算. */
    enabled: boolean;
}

/**
 * 求交数值输出.
 *
 * 两个对象相交时可能是离散交点,也可能是空间交线:
 * - 曲线参与的求交(曲线∩曲线/曲面/体积)产生 `points`;
 * - 曲面/体积参与的求交(曲面∩曲面/体积,体积∩体积)产生 `curves`.
 * 坐标一律是世界坐标(已计入对象静态 transform).
 */
export interface IntersectionOutput {
    points: Vec3[];
    curves: Vec3[][];
}

/** 一个动画片段:单个变换矩阵 + 持续时间. */
export interface AnimationClip {
    name: string;
    duration: number;
    /** 行主序 4x4 矩阵,布局见 `math/tensor/rowMajorMatrix.ts`. */
    matrix: number[][];
}

/** 完整场景 IR. */
export interface SceneIR {
    params: ParamDeclaration[];
    objects: SceneObject[];
    /**
     * 对象列表展示公式:object id -> LaTeX 字符串.
     *
     * 体积对象等无法从数值化几何参数给出可靠方程时值为 null,UI 回退到
     * 纯文本摘要.该字段由编译阶段统一生成,避免每次渲染重复调用 LaTeX 引擎.
     */
    objectFormulas: Record<number, string | null>;
    /**
     * 积分任务展示公式:任务名 -> LaTeX 字符串(积分式本体,不含方法名).
     *
     * 找不到被积对象时值为 null.它是 IR 的展示元数据,供任意消费者读取;
     * 求值对象列表(ui/ObjectListController)现在直接调用
     * `dsl/evaluationLatex.ts` 的 `integralLatexSummary` 生成同样的公式
     * (两处同源于 `latex.ts` 的 `integralBodyLatex`),不再依赖本字段.
     */
    integralFormulas: Record<string, string | null>;
    /**
     * 对象 id -> 行主序 4x4 矩阵,布局见 `math/tensor/rowMajorMatrix.ts`.
     *
     * 使用 Record 而不是 Map,是为了让 IR 保持可序列化,
     * 便于未来跨线程 / 跨进程 / 桌面端消费.
     */
    objectTransforms: Record<number, number[][]>;
    /**
     * 场景中所有 animation 声明.
     * 名称唯一,对象通过 objectAnimations 引用.
     */
    animations: AnimationClip[];
    /**
     * 对象 id -> 按顺序播放的动画名列表.
     * 空列表或缺失表示该对象没有动画.
     */
    objectAnimations: Record<number, string[]>;
    analyses: AnalysisResult[];
    integrals: IntegralTask[];
    intersections: IntersectionTask[];
}

// ================================================================
// 数值积分辅助类型
//
// 这些类型原本混在 `math/objects/types.ts`,现迁移到 IR 层,
// 因为它们描述的是编译后的积分计算输入/输出形状.
// ================================================================

export type Range1D = [number, number];
