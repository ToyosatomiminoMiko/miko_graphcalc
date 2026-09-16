/**
 * 步骤游标的状态机(**纯状态转移**,与 DOM 无关).
 *
 * 状态只有一份:`{ stepCount, index }`--当前走到第几步.三条转移都夹取到
 * `[0, stepCount-1]`:
 * - 走到尽头继续按"下一步"是 **no-op**,不是回绕:板书节奏由讲者控制,
 *   翻到最后再按一下不该跳回开头(那会让人以为点错了);
 * - `goto` 夹取越界下标,点击任意行与键盘翻步共用同一条写入路径.
 *
 * 空过程(`stepCount === 0`)用 `index = EMPTY_PROCESS_INDEX` 表示"没有当前步",
 * 三条转移都保持不动;视图据此显示空状态文案而不是"第 1 / 0 步".
 */

/** 空过程没有当前步:下标是哨兵值,不是合法步骤下标. */
export const EMPTY_PROCESS_INDEX = -1;

export interface ProcessState {
    /** 步骤总数;0 表示空过程. */
    readonly stepCount: number;
    /** 当前步下标;空过程为 {@link EMPTY_PROCESS_INDEX}. */
    readonly index: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/**
 * 把任意下标夹进合法范围.
 *
 * 空过程返回 `EMPTY_PROCESS_INDEX`(范围 `[0, -1]` 本身不成立,必须显式处理);
 * `NaN` 无法比较,按"停在开头"处理,不让它流进状态;`±Infinity` 交给夹取,
 * 自然落到首/末步.
 */
export function clampProcessIndex(index: number, stepCount: number): number {
    if (stepCount <= 0) return EMPTY_PROCESS_INDEX;
    if (Number.isNaN(index)) return 0;
    return clamp(Math.trunc(index), 0, stepCount - 1);
}

/** 建一个状态;`index` 越界会被夹取,空过程落到哨兵值. */
export function createProcessState(stepCount: number, index = 0): ProcessState {
    const count = Math.max(0, Math.trunc(stepCount));
    return { stepCount: count, index: clampProcessIndex(index, count) };
}

/** 下一步;已在最后一步(或空过程)时原样返回. */
export function processNext(state: ProcessState): ProcessState {
    if (state.stepCount <= 0) return state;
    const index = clampProcessIndex(state.index + 1, state.stepCount);
    return index === state.index ? state : { stepCount: state.stepCount, index };
}

/** 上一步;已在第一步(或空过程)时原样返回. */
export function processPrev(state: ProcessState): ProcessState {
    if (state.stepCount <= 0) return state;
    const index = clampProcessIndex(state.index - 1, state.stepCount);
    return index === state.index ? state : { stepCount: state.stepCount, index };
}

/** 跳到指定步;越界夹取,与当前相同则原样返回(不产生无意义的重渲染). */
export function processGoto(state: ProcessState, index: number): ProcessState {
    if (state.stepCount <= 0) return state;
    const next = clampProcessIndex(index, state.stepCount);
    return next === state.index ? state : { stepCount: state.stepCount, index: next };
}

/** 两个状态是否指向同一步:高亮只在这个判据说"变了"时才刷新. */
export function processIndexChanged(before: ProcessState, after: ProcessState): boolean {
    return before.stepCount !== after.stepCount || before.index !== after.index;
}
