/**
 * 表达式模块级缓存有界性回归.
 *
 * 表达式来自用户可编辑源码,每敲一个字符都可能产生新字符串;缓存是模块级,
 * 跟随页面存活,无界就是长会话里的只增不回收泄漏.这里锁:
 * - 归一化 / LaTeX / 符号求导三个缓存超过上限后淘汰最旧条目;
 * - 求导缓存的内层(变量 -> 导数)同样有界;
 * - 未超限时热点表达式仍命中,不重复调 WASM.
 *
 * 上限是模块私有常量,这里按文档值(512 / 8)断言;改常量时同步改本测试.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasm = vi.hoisted(() => ({
    normalize: vi.fn((raw: string) => `norm:${raw}`),
    latex: vi.fn((raw: string) => `tex:${raw}`),
    derivative: vi.fn((expr: string, variable: string) => `d(${expr})/d(${variable})`),
}));

vi.mock('../../generated/math_rs/math_rs', () => ({
    evaluate_scalar: vi.fn(),
    latex_expression: wasm.latex,
    matrix4_from_expr: vi.fn(),
    normalize_expression: wasm.normalize,
    parse_array_strings: vi.fn(),
    symbolic_derivative: wasm.derivative,
    symbolic_variables: vi.fn(),
}));

import {
    cachedDerivativeExpression,
    cachedLatexExpression,
    normalizeExpression,
} from './expression';

const LIMIT = 512;
const VARIABLE_LIMIT = 8;

beforeEach(() => {
    wasm.normalize.mockClear();
    wasm.latex.mockClear();
    wasm.derivative.mockClear();
});

describe('表达式缓存有界', () => {
    it('归一化缓存超过上限后淘汰最旧条目', () => {
        for (let i = 0; i < LIMIT; i += 1) normalizeExpression(`bound-norm-${i}`);
        expect(wasm.normalize).toHaveBeenCalledTimes(LIMIT);

        // 未超限:最旧的仍在缓存里,命中不调 wasm.
        normalizeExpression('bound-norm-0');
        expect(wasm.normalize).toHaveBeenCalledTimes(LIMIT);

        const beforeOverflow = wasm.normalize.mock.calls.length;
        normalizeExpression('bound-norm-overflow');
        // 溢出后最旧的 bound-norm-0 被淘汰,再取需要重算.
        normalizeExpression('bound-norm-0');
        expect(wasm.normalize.mock.calls.length).toBe(beforeOverflow + 2);
    });

    it('LaTeX 缓存超过上限后淘汰最旧条目', () => {
        for (let i = 0; i < LIMIT; i += 1) cachedLatexExpression(`bound-tex-${i}`);
        expect(wasm.latex).toHaveBeenCalledTimes(LIMIT);

        cachedLatexExpression('bound-tex-0');
        expect(wasm.latex).toHaveBeenCalledTimes(LIMIT);

        const beforeOverflow = wasm.latex.mock.calls.length;
        cachedLatexExpression('bound-tex-overflow');
        cachedLatexExpression('bound-tex-0');
        expect(wasm.latex.mock.calls.length).toBe(beforeOverflow + 2);
    });

    it('求导缓存外层按表达式淘汰最旧条目', () => {
        for (let i = 0; i < LIMIT; i += 1) {
            cachedDerivativeExpression(`bound-d-${i}`, 'x');
        }
        expect(wasm.derivative).toHaveBeenCalledTimes(LIMIT);

        cachedDerivativeExpression('bound-d-0', 'x');
        expect(wasm.derivative).toHaveBeenCalledTimes(LIMIT);

        const beforeOverflow = wasm.derivative.mock.calls.length;
        cachedDerivativeExpression('bound-d-overflow', 'x');
        cachedDerivativeExpression('bound-d-0', 'x');
        expect(wasm.derivative.mock.calls.length).toBe(beforeOverflow + 2);
    });

    it('求导缓存内层按变量淘汰最旧条目', () => {
        const expr = 'bound-inner';
        for (let i = 0; i < VARIABLE_LIMIT; i += 1) {
            cachedDerivativeExpression(expr, `var-${i}`);
        }
        expect(wasm.derivative).toHaveBeenCalledTimes(VARIABLE_LIMIT);

        cachedDerivativeExpression(expr, 'var-0');
        expect(wasm.derivative).toHaveBeenCalledTimes(VARIABLE_LIMIT);

        const beforeOverflow = wasm.derivative.mock.calls.length;
        cachedDerivativeExpression(expr, `var-${VARIABLE_LIMIT}`);
        cachedDerivativeExpression(expr, 'var-0');
        expect(wasm.derivative.mock.calls.length).toBe(beforeOverflow + 2);
    });
});
