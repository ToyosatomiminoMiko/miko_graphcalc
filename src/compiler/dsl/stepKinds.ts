/**
 * 内核步骤分区字符串 -> IR 字面量联合(未登记退化成中性色 `algebra`).
 *
 * 不定积分与微分方程的内核产物都带 `steps[].kind`,取值集合是共享的
 * `SOLVE_STEP_KINDS`(见 ir/types.ts);分区只影响徽章配色,不该因为内核新增
 * 一个取值就让整条过程渲染不出来.
 *
 * 单独成一个叶子模块:两个 blueprint 构建器(antiderivativeBlueprint.ts 与
 * odeBlueprint.ts)都要用,放在任意一边都会让另一边反向依赖.
 */
import { SOLVE_STEP_KINDS, type SolveStepKind } from '../../ir';

export function toSolveStepKind(raw: string): SolveStepKind {
    return (SOLVE_STEP_KINDS as readonly string[]).includes(raw)
        ? (raw as SolveStepKind)
        : 'algebra';
}
