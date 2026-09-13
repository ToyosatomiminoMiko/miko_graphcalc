/**
 * SceneStore 显隐状态单测.
 *
 * 行首显隐按钮(实体 + 分析/积分/求交)只负责发起切换,真正的状态在这里:
 * 隐藏 = 不渲染 + 不参与计算,而"隐藏了哪些"必须跨参数拖动,跨同一份源码
 * 重跑存活.这里锁住两条不变量:
 * 1. 同一份源码重跑(Ctrl+Enter)不清空隐藏集合;
 * 2. 只有源码内容真的变了才清空.
 */
import { describe, expect, it } from 'vitest';
import type { AstProgram } from '../compiler/ast/types';
import type { MatrixOps } from '../math/tensor/SceneTransform';
import { SceneStore } from './SceneStore';

// commitSource 只保存引用,不解释 AST/矩阵后端,桩对象足够.
const ast = { statements: [] } as unknown as AstProgram;
const matrixOps = {} as unknown as MatrixOps;

describe('SceneStore 显隐状态', () => {
    it('实体与三类求值对象的隐藏集合各自独立切换', () => {
        const store = new SceneStore();

        store.setEntityHidden(7, true);
        store.toggleAnalysisHidden('g');
        store.toggleIntegralHidden('I');
        store.toggleIntersectionHidden('X');

        expect(store.isEntityHidden(7)).toBe(true);
        expect(store.hiddenAnalysisNames.has('g')).toBe(true);
        expect(store.hiddenIntegralNames.has('I')).toBe(true);
        expect(store.hiddenIntersectionNames.has('X')).toBe(true);

        // 再切一次回到可见.
        store.setEntityHidden(7, false);
        store.toggleAnalysisHidden('g');
        expect(store.isEntityHidden(7)).toBe(false);
        expect(store.hiddenAnalysisNames.has('g')).toBe(false);
    });

    it('同一份源码重跑保留隐藏选择', () => {
        const store = new SceneStore();
        store.commitSource('curve c = sin(x);', ast, matrixOps);
        store.toggleIntegralHidden('I');

        store.commitSource('curve c = sin(x);', ast, matrixOps);

        expect(store.hiddenIntegralNames.has('I')).toBe(true);
    });

    it('只有源码内容变化才清空隐藏集合', () => {
        const store = new SceneStore();
        store.commitSource('curve c = sin(x);', ast, matrixOps);
        store.toggleIntegralHidden('I');
        store.setEntityHidden(1, true);

        store.commitSource('curve c = sin(x);\nsurface s = z;', ast, matrixOps);

        expect(store.hiddenIntegralNames.size).toBe(0);
        expect(store.hiddenEntityIds.size).toBe(0);
    });
});
