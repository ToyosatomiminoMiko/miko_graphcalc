/**
 * 领域图例写入口的单测.
 *
 * 与 `applyUiConfig.test.ts` 的 `applyUiConfig` 那一条同构:只验"注册表被翻成了
 * 正确的变量名与值,并写到了传入的根元素上".注册表本身与 CSS 的对应关系
 * (两个方向的覆盖,同值只出现一次)在 `src/config/cssPalette.test.ts` 里守.
 */
import { describe, expect, it } from 'vitest';
import { KIND_PALETTE, kindPaletteTokens, kindVariable } from '@/config/kindPalette';
import { applyKindPalette } from './applyKindPalette';

/** 只记 setProperty 的假根元素(不依赖 DOM 环境). */
function fakeRoot(): { root: HTMLElement; written: Map<string, string> } {
    const written = new Map<string, string>();
    const root = {
        style: {
            setProperty: (name: string, value: string): void => {
                written.set(name, value);
            },
        },
    } as unknown as HTMLElement;
    return { root, written };
}

describe('kindPaletteTokens', () => {
    it('每个键都翻成 --kind-<键>,值与注册表逐字一致', () => {
        const tokens = kindPaletteTokens();

        expect(Object.keys(tokens)).toHaveLength(Object.keys(KIND_PALETTE).length);
        for (const [key, value] of Object.entries(KIND_PALETTE)) {
            expect(tokens[kindVariable(key as keyof typeof KIND_PALETTE)]).toBe(value);
        }
    });
});

describe('applyKindPalette', () => {
    it('把整张注册表写到传入的根元素上', () => {
        const { root, written } = fakeRoot();

        applyKindPalette(root);

        expect(written.size).toBe(Object.keys(KIND_PALETTE).length);
        expect(written.get('--kind-curve')).toBe(KIND_PALETTE.curve);
        expect(written.get('--kind-laplacian-bg')).toBe(KIND_PALETTE['laplacian-bg']);
    });
});
