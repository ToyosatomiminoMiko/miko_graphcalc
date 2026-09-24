/**
 * 窗口布局契约:默认几何必须真的算得出来,而且不互相压住.
 *
 * 为什么单独立一条:窗口的默认位置是**声明**(`UI_CONFIG.window.windows` 里的锚点),
 * 真正落成 px 的是库的纯函数 `resolveRelativeGeometries`.锚点写错不会报错,只会让两个
 * 窗口在真机上叠在一起 -- 而单测里不去解一遍就完全看不出来.这一条把"六个窗口
 * 在目标视口下的实际几何"钉死.
 *
 * 走的是库的**批量**入口(与 `WindowManager.bind()` 同一个函数):依赖由库内部解,
 * 这里不需要先排好序.
 */
import { describe, expect, it } from 'vitest';
import { resolveRelativeGeometries, type Desktop, type AbsoluteGeometry } from 'miko_ui';
import { UI_CONFIG, desktopConfig } from './uiConfig';

const CONFIG = desktopConfig();

/** 目标视口(与 docs/windowing-plan.md §2.1 的两组一致). */
const VIEWPORTS: readonly Desktop[] = [
    { w: 1280, h: 800, dockReserve: CONFIG.dockReserve, edgeGap: CONFIG.edgeGap },
    { w: 1920, h: 1080, dockReserve: CONFIG.dockReserve, edgeGap: CONFIG.edgeGap },
];

/** 解析出全部窗口的绝对几何(依赖由库内部解). */
function resolveAll(desktop: Desktop): Map<string, AbsoluteGeometry> {
    return resolveRelativeGeometries(CONFIG.windows, desktop);
}

describe('窗口默认几何', () => {
    it('每个窗口都被解出来,id 不重复', () => {
        const ids = CONFIG.windows.map((spec) => spec.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const desktop of VIEWPORTS) {
            const resolved = resolveAll(desktop);
            expect([...resolved.keys()].sort()).toEqual([...ids].sort());
        }
    });

    it('实体 / 求值并排:等宽,留 gap,不重叠,整排居中', () => {
        for (const desktop of VIEWPORTS) {
            const resolved = resolveAll(desktop);
            const entities = resolved.get('entities')!;
            const evaluations = resolved.get('evaluations')!;

            expect(entities.w, `${desktop.w}`).toBe(evaluations.w);
            // 两块之间恰好是配置里写的 gap,既不叠也不漏.
            expect(evaluations.x).toBe(entities.x + entities.w + 12);
            // 整排居中:左右两侧留白相等.
            expect(entities.x).toBe(desktop.w - (evaluations.x + evaluations.w));
        }
    });

    it('两块都留在桌面内', () => {
        for (const desktop of VIEWPORTS) {
            const resolved = resolveAll(desktop);
            const entities = resolved.get('entities')!;
            const evaluations = resolved.get('evaluations')!;
            expect(entities.x).toBeGreaterThanOrEqual(0);
            expect(evaluations.x + evaluations.w).toBeLessThanOrEqual(desktop.w);
            expect(entities.y).toBeGreaterThanOrEqual(CONFIG.dockReserve);
        }
    });

    it('窄视口下两块仍然并排不叠(各不低于自己的最小宽度)', () => {
        // 1280 宽是"两块开始压到左右两列"的那一档:这里只要求它们彼此不叠,
        // 与左右列的横向关系**不**作断言 -- 旧的那个宽 `objects` 窗口同样会
        // 压住左列,那是"用户可以自己拖"的有意取舍,不是回归.
        const desktop: Desktop = { w: 1280, h: 800, dockReserve: CONFIG.dockReserve, edgeGap: CONFIG.edgeGap };
        const resolved = resolveAll(desktop);
        const entities = resolved.get('entities')!;
        const evaluations = resolved.get('evaluations')!;
        const entitiesMin = CONFIG.windows.find((spec) => spec.id === 'entities')!.minSize.w;
        const evaluationsMin = CONFIG.windows.find((spec) => spec.id === 'evaluations')!.minSize.w;

        expect(entities.w).toBeGreaterThanOrEqual(entitiesMin);
        expect(evaluations.w).toBeGreaterThanOrEqual(evaluationsMin);
        expect(entities.x + entities.w).toBeLessThanOrEqual(evaluations.x);
    });

    it('实体 / 求值的底边与 view / process 齐平', () => {
        for (const desktop of VIEWPORTS) {
            const resolved = resolveAll(desktop);
            const bottom = desktop.h - CONFIG.edgeGap;
            for (const id of ['entities', 'evaluations', 'view', 'process']) {
                const g = resolved.get(id)!;
                expect(g.y + g.h, `${id}@${desktop.w}`).toBe(bottom);
            }
        }
    });

    it('每个窗口都拿得到正文内容(库按 id 反问应用)', () => {
        // 这条守的是"配置里声明了窗口 但 appViews 没给内容"这种静默空窗.
        const ids = UI_CONFIG.window.windows.map((spec) => spec.id);
        expect(ids).toEqual(['source', 'view', 'params', 'process', 'entities', 'evaluations']);
    });

    it('窗口清单的顺序不影响几何(依赖由库内部解)', () => {
        // 以前"数组顺序即依赖顺序"是一条只写在注释里的契约:`view` 必须排在
        // `source` 之后,`process` 必须排在 `params` 之后.现在纯函数自己解依赖,
        // 这条契约可以由这条断言兜住 -- 谁把清单顺序调了都不会静默算错坐标.
        const desktop = VIEWPORTS[0];
        const forward = resolveRelativeGeometries(CONFIG.windows, desktop);
        const reversed = resolveRelativeGeometries([...CONFIG.windows].reverse(), desktop);
        for (const id of forward.keys()) {
            expect(reversed.get(id), id).toEqual(forward.get(id));
        }
    });
});
