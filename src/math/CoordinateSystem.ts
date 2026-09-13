/**
 * 坐标系:把一组数值按某种坐标表示解释,并在不同表示之间换算.
 *
 * 为什么把它做成类而不是几个散落的换算函数:
 * - **表示(kind),维度(dim),角度约定(convention)是同一份状态**, 一起传递,
 *   一起校验;调用方拿到的就是一个"坐标系",而不是 `(值, 约定)` 这样的裸参数对.
 * - **换算统一走"本坐标系 -> 笛卡尔(世界坐标) -> 目标坐标系"两跳**:
 *   新增一种坐标系(柱坐标,极坐标的其它写法...)只要实现 `toCartesian` /
 *   `fromCartesian` 两个方向,不必和已有坐标系两两实现转换.
 * - **二维球坐标自动退化成极坐标**:球面在二维就是圆,`spherical(2)` 就是
 *   `[r, θ]` 的极坐标(θ 是 xy 平面内的方位角),不需要单独一个 "polar" 类.
 *
 * 坐标值统一用三元组 {@link CoordinateTriple},与 IR 的
 * `[number, number, number]` 对齐:`dim = 2` 时第三个分量被忽略(输出恒为 0).
 *
 * 角度一律用弧度(与项目其余部分一致,普通角度写 `deg(...)` 展开).
 * 原点处 r = 0,角度没有定义:`fromCartesian` 返回 `[0, 0, 0]`,不返回 NaN.
 *
 * 与 DSL 的关系:DSL 的 `at spherical(r, θ, φ)` 在分析编译期创建一个
 * `CoordinateSystem.spherical(3, 约定)`,把球坐标换成笛卡尔点后交给既有
 * 梯度/投影管线;结果列表再用 `fromCartesian` 把分析点回显成 `[r, θ, φ]`.
 * 约定由 `numericConfig.analysis.sphericalAngleConvention` 全局配置.
 */

/** 坐标值三元组;`dim = 2` 时只读前两位,第三位恒为 0. */
export type CoordinateTriple = [number, number, number];

/** 坐标表示的种类. */
export type CoordinateKind = 'cartesian' | 'spherical';

/**
 * 球坐标角度约定;两个约定都已实现,由全局配置选择默认.
 *
 * - `physics`(物理/ISO,默认):θ 是从 +Z 轴量起的极角 ∈ [0, π],
 *   φ 是 xy 平面内从 +X 轴逆时针量起的方位角 ∈ (-π, π];
 * - `math`(部分教材):θ 是方位角,φ 是极角,即与上一种的 θ/φ 互换.
 *
 * 二维极坐标只有一个角度(方位角),与这个约定无关.
 */
export type SphericalAngleConvention = 'physics' | 'math';

/** 约定清单(与类型定义同源,供配置校验/遍历使用). */
export const SPHERICAL_ANGLE_CONVENTIONS: readonly SphericalAngleConvention[] = [
    'physics',
    'math',
];

function clampUnit(value: number): number {
    if (value > 1) return 1;
    if (value < -1) return -1;
    return value;
}

/**
 * 一个坐标系实例 = 坐标表示 + 维度 + 球坐标角度约定.
 *
 * 构造走静态工厂 {@link CoordinateSystem.cartesian} /
 * {@link CoordinateSystem.spherical}:维度与约定都有默认值,而 `kind` 决定
 * 后续换算走哪条分支,不做无意义的组合.
 */
export class CoordinateSystem {
    private constructor(
        readonly kind: CoordinateKind,
        readonly dim: 2 | 3,
        readonly convention: SphericalAngleConvention,
    ) {}

    /** 笛卡尔坐标系;`dim = 2` 时只在 xy 平面内(第三分量恒为 0). */
    static cartesian(dim: 2 | 3 = 3): CoordinateSystem {
        return new CoordinateSystem('cartesian', dim, 'physics');
    }

    /**
     * 球坐标系;`dim = 2` 即极坐标 `[r, θ]`,θ 是 xy 平面方位角.
     *
     * `convention` 只在 `dim = 3` 时有意义(二维只有一个角度).
     */
    static spherical(
        dim: 2 | 3 = 3,
        convention: SphericalAngleConvention = 'physics',
    ): CoordinateSystem {
        return new CoordinateSystem('spherical', dim, convention);
    }

    /** 二维球坐标就是极坐标. */
    get isPolar(): boolean {
        return this.kind === 'spherical' && this.dim === 2;
    }

    /**
     * 本坐标系的坐标值 -> 世界笛卡尔 `[x, y, z]`.
     *
     * 值不足三位时缺省按 0 补(与 DSL `at` 的补全口径一致);多余分量忽略.
     */
    toCartesian(values: readonly number[]): CoordinateTriple {
        const first = values[0] ?? 0;
        const second = values[1] ?? 0;
        const third = values[2] ?? 0;

        if (this.kind === 'cartesian') {
            return this.dim === 2 ? [first, second, 0] : [first, second, third];
        }

        if (this.dim === 2) {
            // 极坐标:第一位是半径 r,第二位是方位角 θ(不是 3D 的极角).
            return [
                first * Math.cos(second),
                first * Math.sin(second),
                0,
            ];
        }

        // 先把 (θ, φ) 归一成 (极角, 方位角),两种约定共用一组公式.
        const [polar, azimuth] = this.convention === 'physics'
            ? [second, third]
            : [third, second];
        const sinPolar = Math.sin(polar);
        return [
            first * sinPolar * Math.cos(azimuth),
            first * sinPolar * Math.sin(azimuth),
            first * Math.cos(polar),
        ];
    }

    /**
     * 世界笛卡尔 `[x, y, z]` -> 本坐标系的坐标值.
     *
     * 极角用 `acos(z / r)`,方位角用 `atan2(y, x)`(`atan` 会丢象限,不能用);
     * `z / r` 先夹到 [-1, 1],避免浮点误差让 `acos` 返回 NaN.
     */
    fromCartesian(point: readonly [number, number, number]): CoordinateTriple {
        const [x, y, z] = point;

        if (this.kind === 'cartesian') {
            return this.dim === 2 ? [x, y, 0] : [x, y, z];
        }

        if (this.dim === 2) {
            const radius = Math.hypot(x, y);
            return radius === 0
                ? [0, 0, 0]
                : [radius, Math.atan2(y, x), 0];
        }

        const radius = Math.hypot(x, y, z);
        if (radius === 0) return [0, 0, 0];
        const polar = Math.acos(clampUnit(z / radius));
        const azimuth = Math.atan2(y, x);
        return this.convention === 'physics'
            ? [radius, polar, azimuth]
            : [radius, azimuth, polar];
    }

    /**
     * 本坐标系 -> `target` 坐标系.
     *
     * 经世界笛卡尔中转:`target.fromCartesian(this.toCartesian(values))`.
     * 新增坐标系只要接入两个方向,转换就不会退化成 N² 个两两实现.
     */
    convertTo(
        target: CoordinateSystem,
        values: readonly number[],
    ): CoordinateTriple {
        return target.fromCartesian(this.toCartesian(values));
    }
}
