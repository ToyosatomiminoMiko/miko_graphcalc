/**
 * 窗口几何纯函数的边界穷举(阶段 0 的验收).
 *
 * 这里不碰 DOM:夹取,移动,最大化,吸附判定,以及五个窗口在两组目标视口下的
 * 默认几何都能在单测里钉死.真机上"CSS 有没有让窗口填满"是另一回事(见
 * docs/windowing-plan.md §8.1).
 */
import { describe, expect, it } from 'vitest';
import { UI_CONFIG } from '@/config/uiConfig';
import {
    clampGeometry,
    fitGeometry,
    fullscreenGeometry,
    geometryStyle,
    geometryToCss,
    magnetize,
    maximizedGeometry,
    moveGeometry,
    resolveDefaultGeometry,
    resolveEdgeSnap,
    usableHeight,
    type Desktop,
    type Geometry,
    type Limits,
} from './WindowGeometry';

const WINDOW = UI_CONFIG.window;

/** 桌面尺寸与底部两条余量都来自配置(dockReserve + edgeGap 合起来是 116). */
function desktopOf(w: number, h: number): Desktop {
    return { w, h, dockReserve: WINDOW.dockReserve, edgeGap: WINDOW.edgeGap };
}

/** 按配置顺序把五个窗口的默认几何全部解出来(顺序即依赖顺序). */
function resolveAll(desktop: Desktop): Map<string, Geometry> {
    const resolved = new Map<string, Geometry>();
    for (const spec of WINDOW.windows) {
        resolved.set(spec.id, resolveDefaultGeometry(spec.defaultGeometry, desktop, resolved));
    }
    return resolved;
}

function limitsFor(id: string, desktop: Desktop): Limits {
    const spec = WINDOW.windows.find((entry) => entry.id === id);
    if (!spec) throw new Error(`UI_CONFIG 里没有窗口 ${id}`);
    return {
        desktop,
        min: spec.minSize,
        edgeKeep: WINDOW.edgeKeep,
        headerMinVisible: WINDOW.headerMinVisible,
    };
}

const VIEWPORTS = [
    {
        label: '1280x800',
        desktop: desktopOf(1280, 800),
        expected: {
            source: { x: 16, y: 16, w: 420, h: 465 },
            view: { x: 16, y: 493, w: 420, h: 191 },
            params: { x: 844, y: 16, w: 420, h: 376 },
            process: { x: 844, y: 404, w: 420, h: 280 },
            objects: { x: 452, y: 424, w: 376, h: 260 },
        },
    },
    {
        label: '1920x1080',
        desktop: desktopOf(1920, 1080),
        expected: {
            source: { x: 16, y: 16, w: 420, h: 656 },
            view: { x: 16, y: 684, w: 420, h: 280 },
            params: { x: 1484, y: 16, w: 420, h: 530 },
            process: { x: 1484, y: 558, w: 420, h: 406 },
            objects: { x: 600, y: 704, w: 720, h: 260 },
        },
    },
] as const;

describe('resolveDefaultGeometry:五个窗口的默认几何', () => {
    for (const { label, desktop, expected } of VIEWPORTS) {
        it(`${label}:五个窗口逐项与方案里的期望值一致`, () => {
            const resolved = resolveAll(desktop);
            for (const [id, geometry] of Object.entries(expected)) {
                expect(resolved.get(id), id).toEqual(geometry);
            }
            expect(resolved.size).toBe(5);
        });

        it(`${label}:下沿共用底边线 dH-116,其余窗口都留在它之上`, () => {
            const resolved = resolveAll(desktop);
            const bottom = desktop.h - (WINDOW.dockReserve + WINDOW.edgeGap);

            // view / process / objects 三条边就是这条底线(左列下沿,右列下沿,中下).
            for (const id of ['view', 'process', 'objects'] as const) {
                expect(resolved.get(id)!.y + resolved.get(id)!.h, id).toBe(bottom);
            }
            // source / params 用 fraction 取高,底边在这条线之上--但绝不能进 Dock
            // 的 dockReserve 里(否则南边手柄被 Dock 压住,见 §11.1 B4).
            for (const [id, geometry] of resolved) {
                expect(geometry.y + geometry.h, id).toBeLessThanOrEqual(bottom);
            }
        });

        it(`${label}:不越界,且两列与中列不重叠`, () => {
            const resolved = resolveAll(desktop);
            for (const [id, geometry] of resolved) {
                expect(geometry.x, `${id}.x`).toBeGreaterThanOrEqual(0);
                expect(geometry.y, `${id}.y`).toBeGreaterThanOrEqual(0);
                expect(geometry.x + geometry.w, `${id} 右边界`).toBeLessThanOrEqual(desktop.w);
                expect(geometry.y + geometry.h, `${id} 底边`).toBeLessThanOrEqual(desktop.h);
            }

            const objects = resolved.get('objects')!;
            for (const id of ['source', 'view'] as const) {
                const geometry = resolved.get(id)!;
                expect(geometry.x + geometry.w, `左列 ${id}`).toBeLessThanOrEqual(objects.x);
            }
            for (const id of ['params', 'process'] as const) {
                const geometry = resolved.get(id)!;
                expect(geometry.x, `右列 ${id}`).toBeGreaterThanOrEqual(objects.x + objects.w);
            }
        });

        it(`${label}:每一列内部上下留出 gap 且不重叠`, () => {
            const resolved = resolveAll(desktop);
            const source = resolved.get('source')!;
            const view = resolved.get('view')!;
            const params = resolved.get('params')!;
            const process = resolved.get('process')!;

            expect(view.y - (source.y + source.h)).toBe(12);
            expect(process.y - (params.y + params.h)).toBe(12);
        });

        it(`${label}:默认几何都不小于各自的最小尺寸`, () => {
            const resolved = resolveAll(desktop);
            for (const spec of WINDOW.windows) {
                const geometry = resolved.get(spec.id)!;
                expect(geometry.w, `${spec.id}.w`).toBeGreaterThanOrEqual(spec.minSize.w);
                expect(geometry.h, `${spec.id}.h`).toBeGreaterThanOrEqual(spec.minSize.h);
            }
        });
    }

    it('fraction 取的是可用高(dH-116),不是桌面高', () => {
        const desktop = desktopOf(1920, 1080);
        expect(usableHeight(desktop)).toBe(964);

        const resolved = resolveAll(desktop);
        // 0.68 * 964 = 655.52 -> 656;若误用桌面高会得到 734.
        expect(resolved.get('source')!.h).toBe(656);
        expect(resolved.get('params')!.h).toBe(530);
    });

    it('窄视口不再夹取中列宽度(允许重叠),但宽度仍不小于下限', () => {
        const desktop = desktopOf(900, 700);
        const resolved = resolveAll(desktop);
        // dW - 904 = -4 -> 夹到下限 360.
        expect(resolved.get('objects')!.w).toBe(360);
    });

    it('after 引用了未解析的窗口时抛一条能读懂的错', () => {
        const view = WINDOW.windows.find((spec) => spec.id === 'view')!;
        expect(() => resolveDefaultGeometry(view.defaultGeometry, desktopOf(1280, 800), new Map()))
            .toThrow(/after/);
    });
});

describe('clampGeometry', () => {
    const desktop = desktopOf(1000, 700);
    const limits = limitsFor('source', desktop);

    it('尺寸夹到 [min, max(min, desktop)]', () => {
        expect(clampGeometry({ x: 0, y: 0, w: 10, h: 10 }, limits))
            .toMatchObject({ w: 300, h: 220 });
        expect(clampGeometry({ x: 0, y: 0, w: 5000, h: 5000 }, limits))
            .toMatchObject({ w: 1000, h: 700 });
    });

    it('桌面比最小尺寸还小时允许窗口超出桌面(标题栏仍在桌内)', () => {
        const tiny = desktopOf(200, 100);
        const clamped = clampGeometry({ x: 9999, y: 9999, w: 10, h: 10 }, limitsFor('source', tiny));

        expect(clamped.w).toBe(300);
        expect(clamped.h).toBe(220);
        // x 的上界是 dW - edgeKeep;y 的上界是 dH - headerMinVisible.
        expect(clamped.x).toBe(200 - WINDOW.edgeKeep);
        expect(clamped.y).toBe(100 - WINDOW.headerMinVisible);
    });

    it('至少 EDGE_KEEP 宽留在桌内', () => {
        const left = clampGeometry({ x: -10_000, y: 0, w: 420, h: 300 }, limits);
        const right = clampGeometry({ x: 10_000, y: 0, w: 420, h: 300 }, limits);

        expect(left.x).toBe(-(420 - WINDOW.edgeKeep));
        expect(right.x).toBe(desktop.w - WINDOW.edgeKeep);
    });

    it('标题栏绝不被拖出桌顶,也不能被拖出桌底', () => {
        expect(clampGeometry({ x: 0, y: -50, w: 420, h: 300 }, limits).y).toBe(0);
        expect(clampGeometry({ x: 0, y: 10_000, w: 420, h: 300 }, limits).y)
            .toBe(desktop.h - WINDOW.headerMinVisible);
    });
});

describe('moveGeometry', () => {
    const desktop = desktopOf(1000, 700);
    const limits = limitsFor('source', desktop);

    it('增量语义:夹住之后回拖能立刻跟上', () => {
        const start: Geometry = { x: 100, y: 100, w: 420, h: 300 };

        const moved = moveGeometry(start, 40, 30, limits);
        expect(moved).toEqual({ x: 140, y: 130, w: 420, h: 300 });

        // 一路拖到左上角被夹住,再往右上拖 10px 立刻反应(而不是等"总位移"回正).
        const pinned = moveGeometry(start, -10_000, -10_000, limits);
        expect(pinned.x).toBe(-(420 - WINDOW.edgeKeep));
        expect(pinned.y).toBe(0);
        expect(moveGeometry(pinned, 10, 10, limits)).toEqual({
            x: pinned.x + 10,
            y: 10,
            w: 420,
            h: 300,
        });
    });
});

describe('fitGeometry:resize 时把窗口整体收进桌内', () => {
    const desktop = desktopOf(1000, 700);
    const limits = limitsFor('source', desktop);

    it('挂出右边的窗口被整体推回桌内', () => {
        expect(fitGeometry({ x: 900, y: 100, w: 420, h: 300 }, limits))
            .toEqual({ x: 580, y: 100, w: 420, h: 300 });
    });

    it('比桌面还大的窗口收到左上角(标题栏仍抓得到)', () => {
        const tiny = desktopOf(200, 100);
        const fitted = fitGeometry({ x: 500, y: 500, w: 420, h: 300 }, limitsFor('source', tiny));

        expect(fitted.x).toBe(0);
        expect(fitted.y).toBe(0);
    });

    it('已经完整在桌内的窗口不动', () => {
        const inside = { x: 100, y: 100, w: 420, h: 300 };
        expect(fitGeometry(inside, limits)).toEqual(inside);
    });
});

describe('最大化与全屏', () => {
    const desktop = desktopOf(1000, 700);

    it('最大化填满桌面并给 Dock 让出底部', () => {
        expect(maximizedGeometry(desktop, WINDOW.dockReserve))
            .toEqual({ x: 0, y: 0, w: 1000, h: 600 });
    });

    it('全屏填满整个桌面', () => {
        expect(fullscreenGeometry(desktop)).toEqual({ x: 0, y: 0, w: 1000, h: 700 });
    });

    it('两者都不经过夹取:小桌面上也不缩回最小尺寸', () => {
        const tiny = desktopOf(200, 100);
        expect(maximizedGeometry(tiny, WINDOW.dockReserve))
            .toEqual({ x: 0, y: 0, w: 200, h: 0 });
        expect(fullscreenGeometry(tiny)).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    });
});

describe('resolveEdgeSnap', () => {
    const desktop = desktopOf(1280, 800);
    const snap = WINDOW.snap;
    const geometry: Geometry = { x: 400, y: 300, w: 420, h: 260 };

    it('上边缘 -> 最大化(优先于左右)', () => {
        const result = resolveEdgeSnap(geometry, { x: 4, y: 4 }, desktop, snap);
        expect(result?.kind).toBe('maximize');
        expect(result?.target).toEqual({ x: 0, y: 0, w: 1280, h: 700 });
    });

    it('左/右边缘 -> 半屏,高度与最大化一致', () => {
        const left = resolveEdgeSnap(geometry, { x: snap.edge, y: 300 }, desktop, snap);
        const right = resolveEdgeSnap(geometry, { x: 1280 - snap.edge, y: 300 }, desktop, snap);

        // 与最大化同高:铺到 Dock 上方(§4.2:"三者观感统一").
        expect(left).toEqual({ target: { x: 0, y: 0, w: 640, h: 700 }, kind: 'left' });
        expect(right).toEqual({ target: { x: 640, y: 0, w: 640, h: 700 }, kind: 'right' });
    });

    it('阈值开闭:刚好等于阈值吸附,超出一个像素不吸附', () => {
        expect(resolveEdgeSnap(geometry, { x: snap.edge, y: 500 }, desktop, snap)?.kind).toBe('left');
        expect(resolveEdgeSnap(geometry, { x: snap.edge + 1, y: 500 }, desktop, snap)).toBeNull();
        expect(resolveEdgeSnap(geometry, { x: 500, y: snap.edge }, desktop, snap)?.kind).toBe('maximize');
        expect(resolveEdgeSnap(geometry, { x: 500, y: snap.edge + 1 }, desktop, snap)).toBeNull();
    });
});

describe('magnetize', () => {
    const magnet = WINDOW.snap.magnet;
    const other: Geometry = { x: 500, y: 300, w: 400, h: 200 };

    it('x 贴到其它窗口的左/右边,只改一个轴', () => {
        const nearLeft = magnetize({ x: 504, y: 100, w: 200, h: 100 }, [other], magnet);
        expect(nearLeft).toEqual({ x: 500, y: 100, w: 200, h: 100 });

        const nearRight = magnetize({ x: 896, y: 100, w: 200, h: 100 }, [other], magnet);
        expect(nearRight.x).toBe(900);
        expect(nearRight.y).toBe(100);
    });

    it('y 贴着其它窗口的上下边', () => {
        expect(magnetize({ x: 0, y: 296, w: 200, h: 100 }, [other], magnet).y).toBe(300);
        expect(magnetize({ x: 0, y: 496, w: 200, h: 100 }, [other], magnet).y).toBe(500);
    });

    it('最近的一条胜出;超出阈值则原样返回', () => {
        const others: Geometry[] = [
            { x: 500, y: 0, w: 100, h: 100 },
            { x: 506, y: 0, w: 100, h: 100 },
        ];
        expect(magnetize({ x: 503, y: 0, w: 100, h: 100 }, others, magnet).x).toBe(500);
        expect(magnetize({ x: 400, y: 0, w: 100, h: 100 }, others, magnet).x).toBe(400);
    });
});

describe('geometryStyle / geometryToCss', () => {
    const geometry: Geometry = { x: 16, y: 32, w: 420, h: 260 };

    it('四条属性是 px 字符串', () => {
        expect(geometryStyle(geometry)).toEqual({
            left: '16px',
            top: '32px',
            width: '420px',
            height: '260px',
        });
    });

    it('geometryToCss 只是拼接(给断言与日志用)', () => {
        expect(geometryToCss(geometry)).toBe('left: 16px; top: 32px; width: 420px; height: 260px');
    });
});

describe('窗口配置自洽', () => {
    it('五个窗口的 id / 顺序 / 宿主 / 最小尺寸都合法', () => {
        expect(WINDOW.windows.map((spec) => spec.id))
            .toEqual(['source', 'view', 'params', 'process', 'objects']);

        const hostIds = WINDOW.windows.map((spec) => spec.hostId);
        expect(new Set(hostIds).size).toBe(hostIds.length);
        for (const spec of WINDOW.windows) {
            expect(spec.hostId.length, spec.id).toBeGreaterThan(0);
            expect(spec.title.length, spec.id).toBeGreaterThan(0);
            expect(spec.dock.label.length, spec.id).toBeGreaterThan(0);
            expect(spec.minSize.w, spec.id).toBeGreaterThan(0);
            expect(spec.minSize.h, spec.id).toBeGreaterThan(0);
        }
    });

    it('所有 from:bottom 的 inset 都等于 dockReserve + edgeGap', () => {
        const bottomLine = WINDOW.dockReserve + WINDOW.edgeGap;
        let seen = 0;
        for (const spec of WINDOW.windows) {
            for (const axis of [spec.defaultGeometry.y, spec.defaultGeometry.h, spec.defaultGeometry.x]) {
                if (typeof axis !== 'string' && 'from' in axis && axis.from === 'bottom') {
                    expect(axis.inset, spec.id).toBe(bottomLine);
                    seen += 1;
                }
            }
        }
        // objects.y + view.h + process.h 三条,少一条说明配置被改散了.
        expect(seen).toBe(3);
    });

    it('标题栏按钮的 id 与顺序固定,标题栏至少可见高度不超过标题栏高度', () => {
        expect(WINDOW.actions.map((action) => action.id))
            .toEqual(['minimize', 'maximize', 'fullscreen', 'close']);
        for (const action of WINDOW.actions) {
            expect(action.glyph.length, action.id).toBeGreaterThan(0);
            expect(action.label.length, action.id).toBeGreaterThan(0);
        }
        expect(WINDOW.headerMinVisible).toBeLessThanOrEqual(WINDOW.headerHeight);
    });

    it('层级:窗口层在视口之上,窗口层之间递增,Dock 最高', () => {
        expect(WINDOW.z.windowLayer).toBeGreaterThan(0);
        expect(WINDOW.z.first).toBeGreaterThan(WINDOW.z.windowLayer);
        // 吸附预览画在窗口层之下(它是"窗口会落到哪里"的底图,不是前景).
        expect(WINDOW.z.snapPreview).toBeGreaterThan(0);
        expect(WINDOW.z.snapPreview).toBeLessThan(WINDOW.z.windowLayer);
        expect(WINDOW.z.dock).toBeGreaterThan(WINDOW.z.first);
    });
});
