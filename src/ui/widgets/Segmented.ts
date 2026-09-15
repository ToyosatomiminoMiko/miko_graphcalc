/**
 * 单选控件(分段按钮组):一组按钮里同时只有一个 `.active`.
 *
 * 覆盖右侧"视图"面板里三处同样的东西:
 * - 点的"设定大小 / 按比例缩放"(2 列);
 * - 坐标轴"向上 X/Y/Z"(3 列,且要在行内撑满);
 * - ViewCube 预置视角(4 列).
 *
 * 三者过去各有一个类名(`.point-mode` / `.axis-up-mode` / `.viewcube`),CSS 里
 * 是三份逐字相同的规则;现在统一产出 `.segmented`,差异只剩两处参数:
 *
 * ```html
 * <div class="segmented" role="group" aria-label="..."
 *      style="--segmented-columns: 2">
 *   <button type="button" aria-pressed="true">设定大小</button>
 *   <button type="button" aria-pressed="false">按比例缩放</button>
 * </div>
 * ```
 *
 * - **列数**走 `--segmented-columns`(与实体行的 `--object-color` 同一手法:
 *   值由 TS 给,CSS 只消费),不在 CSS 里为每个调用点写一条规则;
 * - **行内撑满**这类布局差异走 `modifier`(`segmented--inline`),样式仍归 CSS.
 *
 * 为什么是 `role="group"` + `aria-pressed` 而不是 `role="radiogroup"` +
 * `role="radio"`:后者的键盘约定是"整组一个 Tab 停靠点 + 方向键在组内移动",
 * 需要 roving tabindex;这里沿用原生按钮(每个都能 Tab 到),用"切换按钮"
 * 语义描述选中态才与键盘行为一致.
 *
 * 值域由泛型参数 `T` 保证:调用方传的是 TS 联合类型,不再是 HTML 里的
 * `data-*` 字符串,所以 `isPointMode` / `isViewHome` / `isUpAxis` 那类运行时
 * 校验连同它们的失败分支一起消失.
 */
import { el } from './dom';

export interface SegmentedItem<T extends string> {
    readonly value: T;
    readonly label: string;
}

export interface SegmentedOptions<T extends string> {
    /** 列数:等分列宽,写进 `--segmented-columns`. */
    columns: number;
    /** 附加布局修饰类(如行内撑满的 `segmented--inline`);默认没有. */
    modifier?: string;
    /** 组名:一组按钮必须能被读屏当成一个整体念出来. */
    ariaLabel: string;
    /** 初值;应当出现在 `items` 里,否则开局没有任何按钮是选中的. */
    value: T;
    items: readonly SegmentedItem<T>[];
}

export interface SegmentedHandle<T extends string> {
    /** 根节点,插到行/分组里用这个. */
    readonly element: HTMLDivElement;
    get(): T;
    /** 程序化选中;只改高亮,不触发 `onChange`. */
    set(value: T): void;
    /** 注册选中回调;返回退订函数.命中已选项时不回调. */
    onChange(listener: (value: T) => void): () => void;
    /** 解绑 DOM 监听并清空订阅者. */
    dispose(): void;
}

export function createSegmented<T extends string>(
    options: SegmentedOptions<T>,
): SegmentedHandle<T> {
    const abort = new AbortController();
    const listeners = new Set<(value: T) => void>();
    const buttons: Array<{ value: T; element: HTMLButtonElement }> = [];
    let current = options.value;

    const element = el('div', {
        class: options.modifier === undefined
            ? 'segmented'
            : `segmented ${options.modifier}`,
        attrs: { role: 'group', 'aria-label': options.ariaLabel },
    });
    element.style.setProperty('--segmented-columns', String(options.columns));

    /** 唯一的高亮写入点:由 `current` 推导,别处不再各自 toggle `.active`. */
    const sync = (): void => {
        for (const button of buttons) {
            const active = button.value === current;
            button.element.classList.toggle('active', active);
            button.element.setAttribute('aria-pressed', String(active));
        }
    };

    const select = (value: T): void => {
        const changed = value !== current;
        current = value;
        sync();
        if (!changed) return;
        for (const listener of [...listeners]) listener(value);
    };

    for (const item of options.items) {
        const button = el('button', { text: item.label });
        button.type = 'button';
        button.addEventListener('click', () => select(item.value), { signal: abort.signal });
        buttons.push({ value: item.value, element: button });
        element.append(button);
    }

    sync();

    return {
        element,
        get: () => current,
        set: (value) => {
            current = value;
            sync();
        },
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        dispose() {
            abort.abort();
            listeners.clear();
        },
    };
}
