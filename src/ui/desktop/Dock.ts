/**
 * Dock(任务栏):每个窗口一枚按钮 + 一个桌面动作区.
 *
 * 按钮**由窗口清单生成**(`UI_CONFIG.window.windows`),不在 HTML 里手写;点击
 * 语义(提升/最小化/还原/复位)由 `WindowManager` 按状态分派,本模块只负责:
 * - 装配按钮(标题),顺序与清单一致;
 * - 上报点击(`handlers.onSelect`);
 * - 写入激活态(`.is-active` 与 `aria-pressed`)与隐藏态(`data-state`,CSS 按它淡化).
 *
 * 为什么按钮不放在 `index.html`:加一个窗口要改两处(标记与清单)就会漂移,
 * 而"清单是唯一真相源"是本方案的硬约束(见 docs/windowing-plan.md §5.3).
 */
import { UI_CONFIG, type WindowId } from '@/config/uiConfig';
import { el } from '@/ui/widgets/dom';
import type { WindowState } from './WindowManager';

/** 桌面动作区的两个全局入口:退出全屏与一键复位. */
export interface DockHandlers {
    /** 点击某个窗口的 Dock 按钮;按状态分派由 `WindowManager` 做. */
    onSelect(id: WindowId): void;
    /** 单窗口全屏的出口(Dock 上的按钮;`Esc` 是另一条路径). */
    onExitFullscreen(): void;
    /** 把五个窗口复位到默认几何. */
    onRestoreAll(): void;
}

export interface DockButtonHandle {
    setActive(active: boolean): void;
    /**
     * 写 `data-state`:CSS 只按它淡化"最小化/关闭"的按钮(`opacity`).
     * 状态只由按钮自身表达:
     * 隐藏态看本方法的 `data-state`, 聚焦态看 `setActive`.
     */
    setState(state: WindowState): void;
}

export interface DockHandle {
    readonly buttons: ReadonlyMap<WindowId, DockButtonHandle>;
    /** 只让当前焦点窗口的按钮亮起;`null` = 一个都不亮. */
    setActive(id: WindowId | null): void;
    /** 全屏时 Dock 自动隐藏(退出全屏的那个按钮也随之消失,`Esc` 仍可用). */
    setFullscreen(visible: boolean): void;
    dispose(): void;
}

/**
 * 建 Dock(内容整体替换 `container` 的现有子节点).
 *
 * `container` 就是 `#dock`:它自身铺满底部一条但 `pointer-events: none`,真正
 * 可点的盒子是里面那个 `.dock-inner`,只占内容宽度--两侧必须留出能点到的桌面,
 * 否则窗口南边的缩放手柄会被一条通栏的实心条压住(见 §11.1 B4).
 */
export function createDock(container: HTMLElement, handlers: DockHandlers): DockHandle {
    const buttons = new Map<WindowId, DockButtonHandle>();

    const group = el('div', { class: 'dock-group' });
    for (const spec of UI_CONFIG.window.windows) {
        const label = el('span', { class: 'dock-btn-label', text: spec.dock.label });
        const button = el('button', {
            class: 'dock-btn',
            attrs: {
                type: 'button',
                'data-window': spec.id,
                'aria-pressed': 'false',
                title: spec.title,
            },
        });
        button.append(label);

        button.addEventListener('click', () => handlers.onSelect(spec.id));

        buttons.set(spec.id, {
            setActive: (active: boolean) => {
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-pressed', String(active));
            },
            setState: (state: WindowState) => {
                button.setAttribute('data-state', state);
            },
        });
        group.append(button);
    }

    const exitFullscreen = el('button', {
        class: 'dock-action',
        text: '退出全屏',
        attrs: { type: 'button', 'data-dock-action': 'exit-fullscreen' },
    });
    exitFullscreen.addEventListener('click', () => handlers.onExitFullscreen());

    const restoreAll = el('button', {
        class: 'dock-action',
        text: '全部还原',
        attrs: { type: 'button', 'data-dock-action': 'restore-all' },
    });
    restoreAll.addEventListener('click', () => handlers.onRestoreAll());

    const actions = el('div', { class: 'dock-actions' }, exitFullscreen, restoreAll);
    const inner = el('div', { class: 'dock-inner' }, group, actions);
    container.replaceChildren(inner);

    // 初始状态走与运行期同一条路径(`setState`),不在这里另写一份 `data-state`:
    // 两处初始化就是"改一处漏一处"的起点.
    for (const spec of UI_CONFIG.window.windows) {
        buttons.get(spec.id)!.setState('normal');
    }

    return {
        buttons,
        setActive(id: WindowId | null) {
            for (const [buttonId, button] of buttons) button.setActive(buttonId === id);
        },
        setFullscreen(visible: boolean) {
            container.classList.toggle('is-fullscreen', visible);
        },
        dispose() {
            // 按钮上的 click 监听随元素一起丢弃(节点由 replaceChildren 移除);
            // 这里只清状态,避免 dispose 之后再被外部引用到.
            buttons.clear();
            container.replaceChildren();
            container.classList.remove('is-fullscreen');
        },
    };
}
