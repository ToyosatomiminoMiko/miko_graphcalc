/**
 * 翻步状态机单测:三条转移都夹取到 `[0, stepCount-1]`,越界是 no-op 而不是
 * 回绕;空过程用哨兵下标表示"没有当前步".
 */
import { describe, expect, it } from 'vitest';
import {
    EMPTY_PROCESS_INDEX,
    clampProcessIndex,
    createProcessState,
    processGoto,
    processIndexChanged,
    processNext,
    processPrev,
} from './processState';

describe('clampProcessIndex', () => {
    it('夹进合法范围', () => {
        expect(clampProcessIndex(-1, 3)).toBe(0);
        expect(clampProcessIndex(1, 3)).toBe(1);
        expect(clampProcessIndex(99, 3)).toBe(2);
    });

    it('空过程返回哨兵下标', () => {
        expect(clampProcessIndex(0, 0)).toBe(EMPTY_PROCESS_INDEX);
    });

    it('非有限数停在开头,不让 NaN 流进状态', () => {
        expect(clampProcessIndex(Number.NaN, 3)).toBe(0);
        expect(clampProcessIndex(Number.POSITIVE_INFINITY, 3)).toBe(2);
    });
});

describe('createProcessState', () => {
    it('下标越界会被夹取', () => {
        expect(createProcessState(3, 5).index).toBe(2);
        expect(createProcessState(3, -2).index).toBe(0);
    });

    it('空过程落到哨兵下标', () => {
        expect(createProcessState(0).index).toBe(EMPTY_PROCESS_INDEX);
    });
});

describe('转移', () => {
    it('next / prev 在范围内移动', () => {
        const state = createProcessState(3, 0);

        expect(processNext(state).index).toBe(1);
        expect(processNext(processNext(state)).index).toBe(2);
        expect(processPrev(processNext(state)).index).toBe(0);
    });

    it('走到尽头继续翻是 no-op(原样返回,不回绕)', () => {
        const last = createProcessState(3, 2);
        const first = createProcessState(3, 0);

        expect(processNext(last)).toBe(last);
        expect(processPrev(first)).toBe(first);
    });

    it('goto 夹取越界下标,与当前相同则原样返回', () => {
        const state = createProcessState(3, 1);

        expect(processGoto(state, 99).index).toBe(2);
        expect(processGoto(state, -99).index).toBe(0);
        expect(processGoto(state, 1)).toBe(state);
    });

    it('空过程的三条转移都保持不动', () => {
        const empty = createProcessState(0);

        expect(processNext(empty)).toBe(empty);
        expect(processPrev(empty)).toBe(empty);
        expect(processGoto(empty, 3)).toBe(empty);
        expect(empty.index).toBe(EMPTY_PROCESS_INDEX);
    });
});

describe('processIndexChanged', () => {
    it('下标或总步数变了才算变', () => {
        const before = createProcessState(3, 1);

        expect(processIndexChanged(before, createProcessState(3, 1))).toBe(false);
        expect(processIndexChanged(before, createProcessState(3, 2))).toBe(true);
        expect(processIndexChanged(before, createProcessState(4, 1))).toBe(true);
    });
});
