/**
 * DSL 解析结果的唯一 TypeScript schema.
 *
 * Rust `compiler_rs` 解析器直接按这份形状输出 JSON,不再维护镜像类型;
 * 修改 DSL 语句结构时以本文件为基准,并同步更新 `compiler_rs/src/miko.pest`.
 */
/**
 * 语句在源码中的字节区间,由 Rust pest 解析器免费产出并填入 JSON.
 *
 * 生产消费者:`compiler/errors.ts` 用它把语句级编译错误换算成
 * "第几行第几列"(应用层 CompileController 拼进错误文案).语句级编译
 * 循环用 `withStatementSpan` 包裹后,抛出的错误即携带该字段.
 * 测试手工构造 AST 时填 `{ start: 0, end: 0 }` 即可,断言只看错误文案.
 */
export interface SourceSpan {
    start: number;
    end: number;
}

/**
 * DSL 分析算子.
 *
 * `jacobian`/`laplacian` 由 pest 语法接受,编译器目前给出"暂未实现";
 * 修改这里时必须同步 `compiler_rs/src/miko.pest` 的 `analysis_op`.
 */
export type AnalysisOpKind =
    | 'gradient'
    | 'divergence'
    | 'curl'
    | 'jacobian'
    | 'laplacian';

/**
 * `analysis` 语句等号右侧的函数名.
 *
 * 每个算子有唯一规范函数名,AST 中保留它用于编译期校验,防止
 * `gradient g = curl(s1)` 这类写法被静默当成 gradient 处理.
 */
export type AnalysisCallName =
    | 'grad'
    | 'div'
    | 'curl'
    | 'jacobian'
    | 'laplacian';

export interface OptionPair {
    name: string;
    value: string;
}

export interface ParamStatement {
    type: 'param';
    name: string;
    value: string;
    /** 没有 `in [min, max, step]` 时 Rust 解析器会省略该字段. */
    ui?: { min: string; max: string; step: string };
    /**
     * 循环类系数:显式写了 `in cyclic [min, max, step]` 时为 true
     * (不写时 Rust 解析器省略该字段,等价于 false).
     *
     * 语义只影响取值口径:越界值按区间长度取模回绕到 `[min, max)`,而不是
     * 普通参数那样夹到端点.球坐标方位角 φ ∈ (-π, π] 这类量用它表达
     * "±π 是同一个点";是否循环必须在声明处写清楚,编译器不做任何隐式
     * 周期猜测(见 compiler/dsl/params.ts 与 math/CoordinateSystem.ts).
     */
    cyclic?: boolean;
    span: SourceSpan;
}

export type TensorKind = 'scalar' | 'vector' | 'matrix' | 'transform';

export interface TensorStatement {
    type: 'tensor';
    kind: TensorKind;
    name: string;
    expr: string;
    span: SourceSpan;
}

export interface AnimationStatement {
    type: 'animation';
    name: string;
    expr: string;
    options: OptionPair[];
    span: SourceSpan;
}

export type ObjectKind =
    | 'curve'
    | 'surface'
    | 'vector_field'
    | 'point'
    | 'vector'
    | 'sphere'
    | 'box'
    | 'cylinder'
    | 'cone'
    | 'frustum'
    | 'region'
    /**
     * 隐式标量场:`f(x,y)=0` 或 `f(x,y,z)=0`.
     *
     * 维度不在语法里写死,由对象表达式实际出现的坐标变量推断(见
     * `dsl/objects/build.ts` 的 implicit 分支):含 z 即三维 level-set
     * 曲面,只含 x/y 即二维隐式曲线.它没有显式 `y=`/`z=` 左端,故与
     * curve/surface 并列,不塞进它们的 expr.
     */
    | 'implicit';

export interface ObjectStatement {
    type: 'object';
    kind: ObjectKind;
    name: string;
    expr: string;
    options: OptionPair[];
    span: SourceSpan;
}

export interface AnalysisStatement {
    type: 'analysis';
    op: AnalysisOpKind;
    name: string;
    call: AnalysisCallName;
    source: string;
    /** 没有 `at [...]` 时 Rust 解析器会省略该字段. */
    at?: string[];
    /**
     * `at` 的坐标形式,由 Rust 解析器按语法显式给出:
     * - 缺省(笛卡尔):`at [x, y]` / `at [x, y, z]`;
     * - `'spherical'`:`at spherical(r, θ, φ)`,或省略 r 的 `at spherical(θ, φ)`
     *   (r 取源球体半径,源不是 sphere 时编译期报错).
     *
     * θ/φ 约定由 `numericConfig.analysis.sphericalAngleConvention` 全局配置,
     * 不由语法隐式决定(见 math/CoordinateSystem.ts 与 docs).
     */
    atForm?: 'cartesian' | 'spherical';
    options: OptionPair[];
    span: SourceSpan;
}

export interface IntegralStatement {
    type: 'integral';
    name: string;
    source: string;
    options: OptionPair[];
    span: SourceSpan;
}

export interface IntersectionStatement {
    type: 'intersection';
    name: string;
    a: string;
    b: string;
    options: OptionPair[];
    span: SourceSpan;
}

/**
 * `derivative 名称 = derivative(源对象 [, 变量]);` 求导语句.
 *
 * 生成一个新对象(curve -> curve,求 x 导;surface -> surface,需指定
 * x|y),其表达式是源对象表达式的符号导数.常量/系数照旧当常数,
 * 自由变量 x/y 被求导.函数名遵循项目全名习惯,不做 `deriv` 缩写(见
 * miko.pest 的 derivative_stmt 注释).
 */
export interface DerivativeStatement {
    type: 'derivative';
    name: string;
    source: string;
    /** 求导变量;curve 缺省为 'x',surface 必填 'x' 或 'y'. */
    variable?: string;
    options: OptionPair[];
    span: SourceSpan;
}

export type AstStatement =
    | ParamStatement
    | TensorStatement
    | AnimationStatement
    | ObjectStatement
    | AnalysisStatement
    | IntegralStatement
    | IntersectionStatement
    | DerivativeStatement;

export interface AstProgram {
    statements: AstStatement[];
}
