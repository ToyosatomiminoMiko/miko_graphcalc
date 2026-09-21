/**
 * 窗口几何:锚点换算 / 夹取 / 最大化 / 吸附判定的**纯函数**.
 *
 * 本文件不引用任何 DOM(不 import `document`,`getComputedStyle`,也不认识
 * 元素):夹取边界,最大化换算,锚点默认值,吸附候选全部能在单测里穷举.
 * 真正把结果写进页面的是 `WindowManager` + `WindowFrame.writeGeometry`.
 *
 * 三条数值口径(唯一一份,别在别处再发明):
 * - `usableHeight = desktop.h - dockReserve - edgeGap`:桌面减去给 Dock 与底边
 *   间隙留出的高度(数值上就是 `dH - 116`),各窗口 spec 里 `from: 'bottom'`
 *   的 `inset` 必须与这个和一致(单测守着).
 * - 夹取:`w/h ∈ [min, max(min, desktop)]`,`x ∈ [-(w - edgeKeep), dW - edgeKeep]`,
 *   `y ∈ [0, dH - headerMinVisible]`.标题栏是唯一的手动入口,绝不能被拖出桌顶.
 * - 最大化/全屏**不经过** `clampGeometry`:它们本来就允许铺满,过一遍夹取只会
 *   被 `min` 下限干扰.
 */
import type { AxisSpec, WindowGeometrySpec } from '@/config/uiConfig';

/** 桌面尺寸与底部两条余量(见文件头). */
export interface Desktop {
    readonly w: number;
    readonly h: number;
    /** 底部为 Dock 留出的高度:最大化与半屏吸附都铺到 `h - dockReserve`. */
    readonly dockReserve: number;
    /** 窗口与桌面边缘的间隙:默认几何的底边线在这之上再让出一段. */
    readonly edgeGap: number;
}

/** 窗口的普通态几何(px,相对 `#app`). */
export interface Geometry {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

/** 某个窗口的最小尺寸. */
export interface SizeConstraints {
    readonly w: number;
    readonly h: number;
}

/** 夹取所需的全部上下文. */
export interface Limits {
    readonly desktop: Desktop;
    readonly min: SizeConstraints;
    readonly edgeKeep: number;
    readonly headerMinVisible: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** 桌面可用高(减去 Dock 与底边间隙). */
export function usableHeight(desktop: Desktop): number {
    return desktop.h - desktop.dockReserve - desktop.edgeGap;
}

/** 缺了 `after` 依赖时的统一报错:配置顺序错了要在启动期说清楚. */
function unresolvedDependency(id: string): Error {
    return new Error(`窗口默认几何依赖的 after 窗口未解析:${id}(检查 UI_CONFIG.window.windows 的顺序)`);
}

/** 不支持的锚点组合:与其静默算错,不如在启动期抛一条能读懂的错. */
function unsupportedAxis(axis: AxisSpec, position: 'x' | 'y' | 'w' | 'h'): Error {
    return new Error(`UI_CONFIG.window 的 ${position} 用了不支持的锚点:${JSON.stringify(axis)}`);
}

function resolveWidth(axis: AxisSpec, desktop: Desktop): number {
    if (typeof axis === 'string') throw unsupportedAxis(axis, 'w');
    if ('at' in axis) return axis.at;
    if ('clamp' in axis) {
        return clamp(desktop.w - axis.inset, axis.clamp[0], axis.clamp[1]);
    }
    throw unsupportedAxis(axis, 'w');
}

/** 不依赖 y 的高度分支(`at` / `fraction`);`from: 'bottom'` 由调用方后算. */
function resolveHeight(axis: AxisSpec, desktop: Desktop): number {
    if (typeof axis === 'string') throw unsupportedAxis(axis, 'h');
    if ('at' in axis) return axis.at;
    if ('fraction' in axis) return Math.round(axis.fraction * usableHeight(desktop));
    throw unsupportedAxis(axis, 'h');
}

/** 宽度已定之后的 x. */
function resolveX(axis: AxisSpec, desktop: Desktop, w: number): number {
    if (axis === 'center') return clamp(Math.round((desktop.w - w) / 2), 0, desktop.w - w);
    if (typeof axis !== 'string' && 'at' in axis) return axis.at;
    if (typeof axis !== 'string' && 'from' in axis && axis.from === 'right') {
        return desktop.w - axis.inset - w;
    }
    throw unsupportedAxis(axis, 'x');
}

/**
 * 默认几何:锚点/夹取 -> px.
 *
 * 计算顺序固定为"宽 -> (不依赖 y 的高) -> y -> (依赖 y 的高) -> x":
 * `view` / `process` 的 y 来自 `after`,它们的 h 再从这个 y 解出;
 * `objects` 的 h 是固定值,它的 y 反过来由 h 解出.五个窗口的依赖顺序由
 * `UI_CONFIG.window.windows` 的数组顺序保证(`view` 在 `source` 之后,
 * `process` 在 `params` 之后),这里只从 `resolved` 里取已经算好的窗口.
 */
export function resolveDefaultGeometry(
    spec: WindowGeometrySpec,
    desktop: Desktop,
    resolved: ReadonlyMap<string, Geometry>,
): Geometry {
    const w = resolveWidth(spec.w, desktop);

    const hBeforeY = typeof spec.h !== 'string' && 'from' in spec.h
        ? null
        : resolveHeight(spec.h, desktop);

    const y = resolveY(spec, desktop, resolved, hBeforeY);

    const h = hBeforeY ?? resolveBottomHeight(spec.h, desktop, y);

    const x = resolveX(spec.x, desktop, w);
    return { x, y, w, h };
}

function resolveY(
    spec: WindowGeometrySpec,
    desktop: Desktop,
    resolved: ReadonlyMap<string, Geometry>,
    knownH: number | null,
): number {
    if (spec.after) {
        const base = resolved.get(spec.after.id);
        if (!base) throw unresolvedDependency(spec.after.id);
        return base.y + base.h + spec.after.gap;
    }
    const axis = spec.y;
    if (axis === 'center') {
        if (knownH === null) throw unsupportedAxis(axis, 'y');
        return clamp(Math.round((desktop.h - knownH) / 2), 0, desktop.h - knownH);
    }
    if (typeof axis !== 'string' && 'at' in axis) return axis.at;
    if (typeof axis !== 'string' && 'from' in axis && axis.from === 'bottom') {
        if (knownH === null) throw unsupportedAxis(axis, 'y');
        return desktop.h - axis.inset - knownH;
    }
    throw unsupportedAxis(axis, 'y');
}

/** `h: { from: 'bottom' }` 的唯一语义:底边落在距桌面该侧 `inset` 处. */
function resolveBottomHeight(axis: AxisSpec, desktop: Desktop, y: number): number {
    if (typeof axis !== 'string' && 'from' in axis && axis.from === 'bottom') {
        return desktop.h - axis.inset - y;
    }
    throw unsupportedAxis(axis, 'h');
}

/**
 * 夹取(唯一一份公式).
 *
 * `max(min, desktop)` 那个兜底是为了小视口:桌面比最小尺寸还小时,宁可让窗口
 * 超出桌面,也不要算出 `min > max` 的区间(`clamp` 会返回 `min`,窗口比桌面大,
 * 但标题栏仍在桌内,能抓回来).
 */
export function clampGeometry(g: Geometry, limits: Limits): Geometry {
    const maxW = Math.max(limits.min.w, limits.desktop.w);
    const maxH = Math.max(limits.min.h, limits.desktop.h);
    const w = clamp(g.w, limits.min.w, maxW);
    const h = clamp(g.h, limits.min.h, maxH);
    const x = clamp(g.x, -(w - limits.edgeKeep), limits.desktop.w - limits.edgeKeep);
    const y = clamp(g.y, 0, Math.max(0, limits.desktop.h - limits.headerMinVisible));
    return { x, y, w, h };
}

/** 移动:k -> k+1 的唯一入口.delta 是原始像素增量,累加后统一夹一次. */
export function moveGeometry(g: Geometry, dx: number, dy: number, limits: Limits): Geometry {
    return clampGeometry({ x: g.x + dx, y: g.y + dy, w: g.w, h: g.h }, limits);
}

/** 最大化:填满桌面,底部留出 Dock 的高度. */
export function maximizedGeometry(desktop: Desktop, dockReserve: number): Geometry {
    return { x: 0, y: 0, w: desktop.w, h: desktop.h - dockReserve };
}

/** 单窗口全屏:填满整个桌面. */
export function fullscreenGeometry(desktop: Desktop): Geometry {
    return { x: 0, y: 0, w: desktop.w, h: desktop.h };
}

/** 边缘吸附的判据(三者互斥,按此顺序判);`null` = 不吸附. */
/**
 * resize 时把窗口**整体**收进桌内.
 *
 * 与 `clampGeometry` 的分工:拖动的夹取刻意允许窗口挂出桌面边缘(否则"把窗口
 * 推到边上"就做不到了,见上面的 `x` 上下限),而视口变小属于外部变化,应该把
 * 用户摆好的窗口整体收回来(§9 第 11 项的"窗口不越界").窗口比桌面还大时收到
 * 左上角(标题栏仍然抓得到).
 */
export function fitGeometry(g: Geometry, limits: Limits): Geometry {
    const clamped = clampGeometry(g, limits);
    return {
        ...clamped,
        x: clamp(clamped.x, 0, Math.max(0, limits.desktop.w - clamped.w)),
        y: clamp(clamped.y, 0, Math.max(0, limits.desktop.h - clamped.h)),
    };
}

export function resolveEdgeSnap(
    /**
     * 被拖窗口的当前几何.
     *
     * 一期的判据只用到指针与桌面(磁吸另有 `magnetize`),这里保留参数是为了
     * 与 `magnetize` 同一副签名,将来若要"窗口已贴边就不再预览"等规则不必改
     * 调用方;参数名前置下划线表达"当前实现不读它".
     */
    _geometry: Geometry,
    pointer: { readonly x: number; readonly y: number },
    desktop: Desktop,
    snap: { readonly edge: number },
): { readonly target: Geometry; readonly kind: 'left' | 'right' | 'maximize' } | null {
    // 半屏与最大化两者高度一致(都铺到 Dock 上方),这样"怎么放都是同一个观感"
    // (见 §4.2:三者观感统一).
    const height = desktop.h - desktop.dockReserve;
    if (pointer.y <= snap.edge) {
        return { target: { x: 0, y: 0, w: desktop.w, h: height }, kind: 'maximize' };
    }
    if (pointer.x <= snap.edge) {
        const w = Math.round(desktop.w / 2);
        return { target: { x: 0, y: 0, w, h: height }, kind: 'left' };
    }
    if (pointer.x >= desktop.w - snap.edge) {
        const w = Math.round(desktop.w / 2);
        return { target: { x: desktop.w - w, y: 0, w, h: height }, kind: 'right' };
    }
    return null;
}

/**
 * 磁吸:把被拖窗口的左上边贴到其它可见窗口的对应边上,只改一个轴.
 *
 * 距离最近的候选胜出;`magnet` 内没有候选就原样返回.修正量只是"这一次移动"
 * 的临时结果(由调用方按帧算),**不要**写回 `entry.geometry`,否则窗口会被
 * 永久吸住.
 */
export function magnetize(g: Geometry, others: readonly Geometry[], magnet: number): Geometry {
    let x = g.x;
    let y = g.y;
    let bestX = magnet + 1;
    let bestY = magnet + 1;

    for (const other of others) {
        for (const candidate of [other.x, other.x + other.w]) {
            const distance = Math.abs(candidate - g.x);
            if (distance <= magnet && distance < bestX) {
                bestX = distance;
                x = candidate;
            }
        }
        for (const candidate of [other.y, other.y + other.h]) {
            const distance = Math.abs(candidate - g.y);
            if (distance <= magnet && distance < bestY) {
                bestY = distance;
                y = candidate;
            }
        }
    }
    return { x, y, w: g.w, h: g.h };
}

/**
 * 几何的四条行内属性:窗口几何**唯一允许的写入形状**.
 *
 * `WindowManager` 逐条 `style.setProperty` 落地,不拼 `cssText`:`cssText` 赋值
 * 会清空整个行内声明块,把 `focus()` 写的 `z-index` 一起清掉(见
 * docs/windowing-plan.md 的 E8).
 */
export function geometryStyle(g: Geometry): Readonly<Record<'left' | 'top' | 'width' | 'height', string>> {
    return {
        left: `${g.x}px`,
        top: `${g.y}px`,
        width: `${g.w}px`,
        height: `${g.h}px`,
    };
}

/** 四条属性的拼接,只用于单测断言与日志(不要拿它去写 `style.cssText`). */
export function geometryToCss(g: Geometry): string {
    return Object.entries(geometryStyle(g))
        .map(([name, value]) => `${name}: ${value}`)
        .join('; ');
}
