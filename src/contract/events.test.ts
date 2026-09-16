import { describe, expectTypeOf, it } from 'vitest';
import type { GraphCalcEvents } from './events';

/**
 * GraphCalcEvents 的最小类型映射测试.
 *
 * 新问题/局限:
 * - `expectTypeOf` 是编译期断言,不会检测哪些事件在运行时真正被 emit.
 *   因此删除或新增事件键时,仍必须手工同步这里的期望,并保证键有真实 emit 点.
 */
describe('GraphCalcEvents', () => {
    it('keeps camera/view event payloads strongly typed', () => {
        expectTypeOf<GraphCalcEvents['camera:changed']>().toEqualTypeOf<{
            camMode: 'perspective' | 'orthographic';
        }>();
        expectTypeOf<GraphCalcEvents['camera:view']>().toEqualTypeOf<{
            view: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'isometric';
        }>();
        expectTypeOf<GraphCalcEvents['camera:rotationLock']>().toEqualTypeOf<{
            locked: boolean;
        }>();
        expectTypeOf<GraphCalcEvents['axis:upChanged']>().toEqualTypeOf<{
            axis: 'x' | 'y' | 'z';
        }>();
        expectTypeOf<GraphCalcEvents['surface:changed']>().toEqualTypeOf<{
            wireframeVisible: boolean;
            colorMapEnabled: boolean;
        }>();
        expectTypeOf<GraphCalcEvents['grid:changed']>().toEqualTypeOf<{
            xzVisible: boolean;
            xyVisible: boolean;
            yzVisible: boolean;
            ticksVisible: boolean;
            piUnit: boolean;
            majorWidth: number;
            minorWidth: number;
        }>();
    });
});
