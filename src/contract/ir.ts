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

/**
 * 原函数来源:只有 `antiderivative` 语句下发的 curve/surface 才携带.
 *
 * 与 {@link DerivativeOrigin} 同样的存在意义:产物在数值/渲染上与手写对象
 * 完全同构,但公式展示要保留积分号.与求导不同的是,对象自身的 `expr` 是
 * **原函数**(已含积分常数取值,因为对象必须可求值),所以公式层要在括号里放
 * **被积函数**(数学上是 ∫f,不是"对原函数再积一次分"),再由公式层把对象
 * 自身的 expr 接在等号右侧.
 *
 * 渲染/求值路径不读这个字段,它只服务于 `sceneObjectLatex` 的公式拼装.
 */
export interface AntiderivativeOrigin {
    /** 被积函数(未积分的归一化结果). */
    integrandExpr: string;
    /** 积分变量:curve 恒为 x,surface 为 x 或 y. */
    variable: 'x' | 'y';
    /** 积分常数取值(对象 expr 已经把常数的数值并入). */
    constant: number;
}

/**
 * 微分方程来源:只有 `ode` 语句下发的 surface/curve 才携带(设计文档
 * `docs/plan3.md` 的 P1/P2:斜率场复用 `surface z = f(x,y)`,解族按常数取值
 * 各下发一条 `curve`).
 *
 * 与 `DerivativeOrigin`/`AntiderivativeOrigin` 同样的存在意义:产物在数值/
 * 渲染上与手写对象完全同构,但公式展示要说清"这条曲线是哪个方程的解".
 * 渲染/求值路径不读这个字段,它只服务于 `sceneObjectLatex` 的公式拼装.
 */
export interface OdeOrigin {
    /** 该实体在微分方程里的角色. */
    role: 'slope' | 'particular' | 'family';
    /**
     * `ode` 语句名.
     *
     * 实体名是 `<语句名>`(斜率场)/`<语句名>_p`(特解)/`<语句名>_c1...`(解族),
     * 隐藏整条语句时要按这个名字过滤**它的全部实体**,靠名字前缀猜是脆的
     * (别的对象也可能长成那个样子),所以原点里显式带上来源语句名.
     */
    statement: string;
    /** 方程原文(展示用,如 `y' = x*y`). */
    equation: string;
    /** 积分常数取值;斜率场为 null,解曲线为定出/指定的数值. */
    constant: number | null;
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
    /** 该 curve 由 `antiderivative` 下发时给出被积函数与积分常数. */
    antiderivativeOrigin?: AntiderivativeOrigin;
    /** 该 curve 由 `ode` 下发时给出方程与常数取值. */
    odeOrigin?: OdeOrigin;
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
    /** 该 surface 由 `antiderivative` 下发时给出被积函数与积分常数. */
    antiderivativeOrigin?: AntiderivativeOrigin;
    /** 该 surface 由 `ode` 下发时是方程的斜率场 `z = f(x,y)`. */
    odeOrigin?: OdeOrigin;
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
 * 这里只保留已实现算子;AST 侧的 `AnalysisOpKind` 还会带 `jacobian`,
 * 用于在编译期给出"暂未实现"诊断.
 *
 * `laplacian` 是标量算子(标量场进,标量出):`∇²f = f_xx + f_yy + f_zz`,
 * 结果落在 `AnalysisResult.scalar`,`vector` 恒为零向量.向量场的逐分量
 * 拉普拉斯 `∇²F`(结果仍是向量)当前不提供,见 docs/derivatives-guide.md.
 */
export type AnalysisOp = 'gradient' | 'divergence' | 'curl' | 'laplacian';
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
     * 标量场源(curve/surface/implicit/球体)的 gradient 给值;laplacian 写作
     * `∇²f = (f_xx + f_yy + f_zz)`(同样是标量场的符号展开);divergence/curl
     * 的定义需要向量场分量,IR 里没有逐分量符号表达式,故为 undefined,
     * 列表此时只给数值.渲染/数值路径不读这个字段.
     */
    symbolic?: string;
    /**
     * 分析点相对世界原点的球坐标 `[r, θ, φ]`,供结果列表展示.
     *
     * 只对隐式场/球体的 gradient / laplacian 给值(它们的 `at` 可以用球坐标
     * 显式声明,结果也就用同一套坐标回显);θ/φ 约定见
     * `math/CoordinateSystem.ts` 与 `numericConfig.analysis.
     * sphericalAngleConvention`.其余分析为 undefined.
     */
    pointSpherical?: [number, number, number];
    /**
     * 算子的向量结果.
     *
     * - gradient:法向(scalar 场给值;curve 为 (-f', 1, 0) 归一化);
     * - curl:旋度向量;
     * - divergence / laplacian:标量算子,恒为 `[0, 0, 0]`(渲染层据此
     *   不会画出箭矢,即使 `show` 里显式写了 `normal`).
     */
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
 * 求解方法(**求解 / 求交 / 后续联立共用的统一词汇**).
 *
 * 与 Rust `math_rs::solve_core::SolveMethod` 同域:
 * - `exact`:符号精确内核(`math_rs::symbolic::solve`),产出教学步骤;
 * - `numeric`:采样数值内核(`math_rs::intersection_core`),产出点集与轨迹(交线);
 * - `auto`:由内核按问题形状选择(方程 -> 精确,几何对象对 -> 数值).
 *
 * 这一步是"为联立做准备"的落点:三种语句服务的是同一件事--解一组约束,
 * 只是方程数/未知量数/方法不同;统一词汇之后,新增 `System` 不必再新开一条
 * 完整链路(见 `docs/` 的求解设计口径).
 */
export type SolveMethod = 'exact' | 'numeric' | 'auto';

/**
 * 约束任务公共基座:求解 / 求交(以及后续联立)共享的"命名 + 显隐 + 未知量 + 方法".
 *
 * 只统一**词汇**,不统一容器与调度:`SceneIR.solves` 与 `SceneIR.intersections`
 * 仍是两个数组(遵守本文件"只新增字段"的既有约定),求解在编译期同步算完,
 * 求交在 Worker 里异步算,这一层不做任何改变.
 */
export interface ConstraintTaskBase {
    name: string;
    /**
     * 内核实际用的后端.
     *
     * - 求解:`method` 选项可指定 `auto` / `exact` / `numeric`,缺省 `auto`;
     *   这里记的是**内核回报的实际方法**(请求 `auto` 时按问题形状落定);
     * - 隐藏项没有调用内核,记的是**请求**的方法(见 `compiler/dsl/solves.ts`
     *   的 `disabledTask`);
     * - 求交:恒为 `numeric`(几何求交没有精确符号后端).
     */
    method: SolveMethod;
    /** 任务是否参与计算.为 false 时仅保留列表项,不执行计算. */
    enabled: boolean;
    /**
     * 未知量名.
     *
     * - 求解:求解变量(推断失败或隐藏时为空数组);
     * - 求交:世界坐标轴 `['x', 'y', 'z']`(数值路径在世界坐标里求解);
     * - 联立(后续):被求解的变量列表.
     */
    unknowns: string[];
}

/**
 * 求交任务(编译产物).
 *
 * 编译器只负责描述"要算哪两个对象,用什么分辨率",真正的数值计算由
 * Worker + Rust `intersection_core` 异步完成;结果缓存与渲染由
 * IntersectionRenderer 按任务名管理.
 */
export interface IntersectionTask extends ConstraintTaskBase {
    aName: string;
    bName: string;
    aId: number;
    bId: number;
    segments: number;
    color: string;
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

/**
 * 过程步骤的依据分区(**全部内核共用**).
 *
 * 与 `src/adapters/processSteps.ts` 的 `ProcessStepKind` 同域:内核产物直接带
 * 分区,UI 只负责配色与文案.
 *
 * 前四种与求解内核的既有取值一致--法则 / 代数 / 定义 / 数值;后三种由
 * 不定积分与微分方程内核引入(见 docs/calculus-suite-plan.md):
 * - `table`:基本积分公式表 / 特征方程这类"查表"依据;
 * - `substitute`:换元与分部积分这类"变量代换"依据;
 * - `check`:结果回代验证(对原函数求导 / 把解代回原方程),与推导步骤分开,
 *   避免学生把"验证"当成推导的一环.
 *
 * 常量名保持 `SOLVE_STEP_KINDS` 不改:它是既有导出,改名会同时动
 * `src/adapters/processSteps.ts` 的别名与三处导入;语义已经写在这里.
 */
export const SOLVE_STEP_KINDS = [
    'rule',
    'algebra',
    'definition',
    'numeric',
    'table',
    'substitute',
    'check',
] as const;

/** `SOLVE_STEP_KINDS` 对应的字面量联合(由数组派生,不要单独维护). */
export type SolveStepKind = (typeof SOLVE_STEP_KINDS)[number];

/**
 * 求解过程的一步:**内核产物独立类型**(路线图 §7.1).
 *
 * 只带渲染需要的字符串,不含 `Expr`--符号引擎内部表示不越过内核边界
 * (见 `math_rs::symbolic::solve`).
 */
export interface SolveStep {
    /** 一行 LaTeX(不换行,排不下由该行横向滚动). */
    latex: string;
    /** 依据文案,如"因式分解"/"零积律"/"求根公式". */
    reason: string;
    kind: SolveStepKind;
}

/**
 * 方程求解任务(求值对象列表里的第 4 类).
 *
 * 求解在**编译期**完成(与 analysis 同一档,不像 integral/intersection 走异步
 * 数值回调):步骤链本身就是最终结果.
 *
 * 能力边界错误(多未知量 / 三次以上 / 非多项式)落在 `error`,列表照常保留
 * 占位并给出理由,**题目 LaTeX 仍然有效**(方程已解析成功);隐藏项
 * (`enabled === false`)按既有约定"先完整校验,后禁用,仅跳过计算":内核不再
 * 调用,`equationLatex` 为空串,行内回退显示方程原文.
 *
 * 统一词汇:`method` 是内核实际用的方法(单方程恒为 `exact`;联立线性为
 * `exact`,非线性落到 `numeric`,能力边界是"实际尝试过的那条路"),`unknowns`
 * 是全部未知量(推断失败或隐藏时为空数组).展示用的 `, ` / `; ` 连接文案由
 * UI 从 `unknowns` / `equations` 派生,IR 里不再各存一份派生字符串.
 */
export interface SolveTask extends ConstraintTaskBase {
    /**
     * 全部方程原文(单方程时长度为 1;联立时按书写顺序).
     *
     * 纯文本回退(`equationLatex` 为空时)由 `equations.join('; ')` 得到--
     * 单方程与联立的差别只在这里,不再需要第二个"equation 原文"字段
     * (AST 里那个 `equation` 是**首条**,同名不同义,容易读错).
     */
    equations: string[];
    /** 题目 LaTeX(单方程是原方程;联立是 `cases` 方程组);隐藏项为空串. */
    equationLatex: string;
    /** 解集 LaTeX;无实数解时为 null;联立数值路径是 `\approx` 近似解. */
    solutionLatex: string | null;
    /**
     * 实数解个数.
     *
     * 单方程是根的个数;联立是解的个数(精确唯一解为 1,数值路径是找出的解点
     * 个数).结果展示走 `solutionLatex`/`identity`,这个计数留给测试对拍.
     */
    realRootCount: number;
    /**
     * 恒等式(任意实数都是解):与"无解"必须区分.
     *
     * 单方程专用;联立恒为 false(方程组的"恒等"没有统一展示口径).
     */
    identity: boolean;
    /** 求解步骤;`error !== null` 或隐藏时为空. */
    steps: SolveStep[];
    /** 能力边界/声明错误;null 表示求解成功. */
    error: string | null;
}

/**
 * 原函数任务(求值对象列表里的"原函数"子列表条目).
 *
 * 与求解同一条"声明级编译"口径:内核在编译期一次算完,步骤链与结果都是
 * 最终产物,没有异步数值回调(见 docs/calculus-suite-plan.md 第 3 节).
 *
 * 两路同源:
 * - 展示侧(`ui/evaluation/AntiderivativeItem`)读本类型排摘要 / 细节 / 过程页;
 * - 实体侧(`SceneIR.objects` 里同名对象)读 `antiderivativeText`,把原函数当
 *   作普通 curve/surface 下发,于是 `derivative` / `gradient` / `integral`
 *   全部既有能力对它可用.
 */
export interface AntiderivativeTask {
    name: string;
    /** 源对象 id;源被删除时展示层回退到纯文本. */
    objectId: number;
    /** 源对象种类;决定下发对象是 curve 还是 surface. */
    sourceKind: 'curve' | 'surface';
    /** 积分变量(`x`,曲面可为 `y`). */
    variable: string;
    /** 被积表达式(归一化后字符串,即源对象自己的表达式). */
    integrand: string;
    /** 题目 LaTeX(积分式,含 `dx`). */
    integrandLatex: string;
    /**
     * 原函数表达式(归一化后字符串,**不含积分常数**).
     *
     * 不含常数是刻意的:它要直接喂 `evaluate_scalar` 与对象物化管线,多一个
     * 自由符号 `C` 会让每个消费方各自处理一次;常数只活在展示层(`+C`)与
     * 下发对象的取值里.
     */
    antiderivativeText: string;
    /** 原函数 LaTeX(不含 `+C`,由展示层拼常数). */
    antiderivativeLatex: string;
    /** 积分常数取值(选项 `constant`,缺省 0);下发对象与细节行都用它. */
    constant: number;
    /** 积分常数符号(内核给出,如 `C`). */
    constantSymbol: string;
    /** 回代验证是否通过(对原函数求导与被积函数对拍). */
    verified: boolean;
    /** 推导步骤;`error !== null` 或隐藏时为空. */
    steps: AntiderivativeStep[];
    /** 能力边界理由(非初等 / 超出预算);null 表示成功. */
    error: string | null;
    /** 是否参与计算.为 false 时仅保留列表项,不调用内核,也不下发对象. */
    enabled: boolean;
}

/** 原函数推导的一步:与 `SolveStep` 同形(独立类型,不含 `Expr`). */
export interface AntiderivativeStep {
    latex: string;
    reason: string;
    kind: SolveStepKind;
}

/**
 * 微分方程任务(求值对象列表里的"微分方程"子列表条目).
 *
 * 同为声明级编译;`error` 是能力边界(不在可解类型清单内),不是调用失败.
 */
export interface OdeTask {
    name: string;
    /** 方程原文(DSL 里写的 `y' = f(x, y)`). */
    equation: string;
    /** 自变量(`x`/`t`);推断失败或隐藏时为空串. */
    independent: string;
    /** 因变量(`y`). */
    dependent: string;
    /** 方程阶数;`error !== null` 时为 0. */
    order: number;
    /** 题目 LaTeX(原方程,保留用户写法). */
    equationLatex: string;
    /** 通解 LaTeX;`error !== null` 时为 null. */
    generalLatex: string | null;
    /** 特解 LaTeX(写了初值时);无初值或无法定出时为 null. */
    particularLatex: string | null;
    /** 初值条件原文(回显用),无初值时为空数组. */
    initialConditions: string[];
    /**
     * 通解是不是隐式形式(`Φ(x,y) = C`).
     *
     * 隐式解必须在细节里明确标注"隐式解":右边那一坨不是 `y = ...`,不说清
     * 学生会读错(设计文档 P3-A).
     */
    implicit: boolean;
    /** 斜率场 `f(x,y)` 的 LaTeX;没有斜率场(二阶/能力边界)时为 null. */
    slopeLatex: string | null;
    /** 斜率场实体对象 id;0 表示没有下发斜率场. */
    slopeObjectId: number;
    /** 解曲线实体对象名(特解与解族);没有时为 空数组. */
    curveNames: string[];
    /** 内核如实说明的补充信息(隐式解未显式化 / 未定出常数 / 缺省自变量). */
    notes: string[];
    /** 任意常数个数(= 阶数,特解时为 0). */
    arbitraryConstantCount: number;
    /** 解是否回代验证通过. */
    verified: boolean;
    /** 推导步骤;`error !== null` 或隐藏时为空. */
    steps: SolveStep[];
    /** 能力边界理由;null 表示求解成功. */
    error: string | null;
    /** 是否参与计算.为 false 时仅保留列表项,不调用内核. */
    enabled: boolean;
}

/** 一个动画片段:单个变换矩阵 + 持续时间. */
export interface AnimationClip {
    name: string;
    duration: number;
    /** 行主序 4x4 矩阵,布局见 `math/matrix/rowMajorMatrix.ts`. */
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
     * 求值对象列表(ui/objects/ObjectListController)现在直接调用
     * `dsl/evaluationLatex.ts` 的 `integralLatexSummary` 生成同样的公式
     * (两处同源于 `latex.ts` 的 `integralBodyLatex`),不再依赖本字段.
     */
    integralFormulas: Record<string, string | null>;
    /**
     * 对象 id -> 行主序 4x4 矩阵,布局见 `math/matrix/rowMajorMatrix.ts`.
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
    /**
     * 方程求解任务(设计文档 `docs/equation-solving-process.md` 的三期内核).
     *
     * 只新增字段:既有 `analyses`/`integrals`/`intersections` 的字段语义不变.
     */
    solves: SolveTask[];
    /**
     * 原函数任务(设计文档 `docs/calculus-suite-plan.md` 第 3 节).
     *
     * 只新增字段:既有 `analyses`/`integrals`/`intersections`/`solves` 的字段
     * 语义不变.与 `solves` 同一档--声明级编译,没有异步数值回调.
     */
    antiderivatives: AntiderivativeTask[];
    /** 微分方程任务(设计文档 `docs/calculus-suite-plan.md` 第 4 节). */
    odes: OdeTask[];
}

// ================================================================
// 数值积分辅助类型
//
// 这些类型原本混在 `math/objects/types.ts`,现迁移到 IR 层,
// 因为它们描述的是编译后的积分计算输入/输出形状.
// ================================================================

export type Range1D = [number, number];
