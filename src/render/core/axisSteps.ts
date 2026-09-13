/**
 * 网格/坐标轴刻度的步长解析.
 *
 * 刻度位置一律用"第 k 个小刻度"的整数索引计算(k × minorStep),而不是浮点
 * 累加,大刻度判定也只看索引能否被 majorEvery 整除.这样 π 步长(π/2,π)
 * 不会因为浮点误差漏判大刻度,也保证普通整数步长的排布与旧实现完全一致.
 */

/** 一次构建网格/刻度所需的步长信息. */
export interface GridSteps {
    /** 小刻度间隔(坐标值). */
    minorStep: number;
    /** 每几个小刻度出现一个大刻度. */
    majorEvery: number;
}

/** 步长配置来源:普通整数步长 + π 单位模式步长. */
export interface GridStepSource {
    majorStep: number;
    minorStep: number;
    piMajorStep: number;
    piMinorStep: number;
}

/**
 * 解析当前生效的步长.
 *
 * - 普通模式:配置的整数步长(默认大刻度 5,小刻度 1);
 * - π 单位模式:大刻度 π,小刻度 π/2,刻度正好落在 π/2 的整数倍上.
 */
export function resolveGridSteps(source: GridStepSource, piUnit: boolean): GridSteps {
    const majorStep = piUnit ? source.piMajorStep : source.majorStep;
    const minorStep = piUnit ? source.piMinorStep : source.minorStep;
    return {
        minorStep,
        majorEvery: Math.max(1, Math.round(majorStep / minorStep)),
    };
}

/** limit 内最多能放下几个小刻度(向下取整,带容差避免刚好落在整数上被截断). */
export function stepCount(minorStep: number, limit: number): number {
    return Math.floor(limit / minorStep + 1e-9);
}

/**
 * 正方向上的小刻度位置:minorStep 的 1..count 倍.
 * 刻度线只画在坐标轴正方向(坐标轴本身也只向正方向延伸),标签与之一一对应.
 */
export function positiveStepPositions(minorStep: number, limit: number): number[] {
    const count = stepCount(minorStep, limit);
    const positions: number[] = [];
    for (let k = 1; k <= count; k += 1) {
        positions.push(k * minorStep);
    }
    return positions;
}
