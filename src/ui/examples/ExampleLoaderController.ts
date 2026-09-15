/**
 * 示例载入菜单控制器.
 *
 * 左侧「源码」标题栏里的「示例」按钮打开一个分组浮层,列出 `example/` 下的
 * 全部示例(清单见 `exampleCatalog.ts`).选中一项即回调装配层去替换编辑器
 * 源码并运行--本控制器不碰编辑器,只管"渲染 / 开合 / 选中 / 键盘"四件事.
 *
 * 其中"开合"整体交给 `ui/widgets/Popover.ts`:开合态与 `.is-open`/aria 的同步,
 * 点外部关闭,Esc 后把焦点交还按钮,都是任何浮层都要有,写第二遍必错的部分.
 * 本文件只剩这一块自己的内容:**菜单项怎么渲染**(来自 `exampleCatalog`),
 * **选中后干什么**(回调装配层),以及**键盘导航**(上下键在菜单项间移动).
 *
 * 为什么是浮层而不是一个 `<select>`:13 个示例要分「求导·偏导」「其他主题」
 * 两组,每项还要显示中文标题;面板默认宽只有 300px,下拉里标题只能截断,
 * 也没有分组.
 *
 * 键盘不在这里绑监听:全应用只有 `KeyboardController` 对 document 绑一次
 * keydown,本控制器用 `keyboardBindings()` 把 Esc / 上下键两条规则注册进去,
 * 与 FormulaCopyController 的做法一致.两条规则在菜单关着时都返回 null,
 * 把按键原样放行给页面.
 *
 * 菜单项点击用**事件委托**绑在菜单节点上(项是动态渲染的),它与浮层的开合
 * 监听分别由本控制器与 Popover 持有,各自的 `dispose()` 负责解绑.
 */
import type { KeyboardBinding } from '../../service/KeyboardController';
import { el } from '../widgets/dom';
import { createPopover, type PopoverHandle } from '../widgets/Popover';
import { EXAMPLE_CATALOG, groupedExamples, type ExampleEntry } from './exampleCatalog';

/** 菜单依赖的两个节点;由装配层取好传入(取不到时构造即报错). */
export interface ExampleLoaderElements {
    readonly button: HTMLElement;
    readonly menu: HTMLElement;
}

export class ExampleLoaderController {
    /** 菜单项按渲染顺序保存,上下键导航只在这里面走. */
    private readonly items: HTMLElement[] = [];
    private readonly popover: PopoverHandle;
    /** 菜单项委托点击的监听,与浮层自己的监听分开管理. */
    private readonly abortController = new AbortController();
    /** 当前拥有焦点的菜单项下标;-1 表示焦点还在按钮上(刚打开). */
    private activeIndex = -1;

    constructor(
        private readonly elements: ExampleLoaderElements,
        private readonly onSelect: (entry: ExampleEntry) => void,
    ) {
        if (!elements.button || !elements.menu) {
            throw new Error('ExampleLoaderController 缺少 #example-btn / #example-menu 结构');
        }

        this.popover = createPopover({ trigger: elements.button, panel: elements.menu });
        // 每次开合都把方向键的起点复位:打开时焦点还在按钮上,第一次按下箭头
        // 才落到第一项(见 _moveFocus).
        this.popover.onOpenChange(() => {
            this.activeIndex = -1;
        });

        this._render();
        this.elements.menu.addEventListener('click', this._onMenuClick, {
            signal: this.abortController.signal,
        });
    }

    get isOpen(): boolean {
        return this.popover.isOpen;
    }

    /** 把"点浮层外部关闭"挂到根节点(键盘那条路走 KeyboardController). */
    bind(root: HTMLElement): void {
        this.popover.bind(root);
    }

    /** Esc / 上下键经 KeyboardController 统一路由. */
    keyboardBindings(): KeyboardBinding[] {
        return [
            {
                keys: ['Escape'],
                resolve: () => (this.popover.isOpen
                    ? () => this.close({ focusButton: true })
                    : null),
            },
            {
                // 菜单关着时放行:上下键在别处(如 select,列表滚动)还有自己的语义.
                keys: ['ArrowDown', 'ArrowUp'],
                resolve: (event) => (this.popover.isOpen
                    ? () => this._moveFocus(event.key === 'ArrowDown' ? 1 : -1)
                    : null),
            },
        ];
    }

    /**
     * 标记当前已载入的示例(高亮 + `aria-current`).
     * 只影响展示,不影响载入逻辑;文件名不在清单里时全部取消高亮.
     */
    setActive(file: string): void {
        for (const item of this.items) {
            const active = item.dataset.example === file;
            item.classList.toggle('is-active', active);
            if (active) {
                item.setAttribute('aria-current', 'true');
            } else {
                item.removeAttribute('aria-current');
            }
        }
    }

    /**
     * 关闭菜单.
     *
     * `focusButton` 只给 Esc 用:键盘用户关掉浮层后焦点必须回到触发它的
     * 按钮上,否则焦点会掉进浮层里已隐藏的节点(或 body),键盘续不上.
     */
    close(options: { focusButton?: boolean } = {}): void {
        this.popover.close({ focusTrigger: options.focusButton });
    }

    dispose(): void {
        // 先复位 DOM 再摘监听:dispose 后浮层不能留在屏幕上.
        this.popover.dispose();
        this.abortController.abort();
    }

    /** 按分组渲染菜单项;`groupedExamples()` 已保证顺序与"空组不出现". */
    private _render(): void {
        const sections = groupedExamples().map((section) => {
            const group = el('div', {
                class: 'example-menu-group',
                attrs: { role: 'group', 'aria-label': section.group },
            });
            group.append(el('div', {
                class: 'example-menu-group-title',
                text: section.group,
            }));

            for (const entry of section.entries) {
                const item = this._renderItem(entry);
                group.append(item);
                this.items.push(item);
            }
            return group;
        });

        this.elements.menu.replaceChildren(...sections);
    }

    private _renderItem(entry: ExampleEntry): HTMLElement {
        const item = el('button', {
            class: 'example-menu-item',
            attrs: { role: 'menuitem' },
        });
        item.type = 'button';
        item.dataset.example = entry.file;
        // 中文标题在前(读的是它),文件名在后做"这是哪个文件"的对照.
        item.title = `example/${entry.file}`;
        item.append(
            el('span', { class: 'example-menu-label', text: entry.title }),
            el('span', {
                class: 'example-menu-file',
                text: entry.file.replace(/\.scad$/, ''),
            }),
        );
        return item;
    }

    private readonly _onMenuClick = (event: MouseEvent): void => {
        const file = this._fileFrom(event.target);
        if (file === null) return;

        const entry = EXAMPLE_CATALOG.find((candidate) => candidate.file === file);
        if (!entry) return;

        // 先关再回调:载入若抛错,浮层也不会僵在屏幕上.
        this.close();
        this.onSelect(entry);
    };

    private _fileFrom(target: EventTarget | null): string | null {
        if (!(target instanceof Element)) return null;
        return target.closest<HTMLElement>('[data-example]')?.dataset.example ?? null;
    }

    /**
     * 上下键导航.焦点还在按钮上(activeIndex = -1)时,向下进第一项,向上进
     * 最后一项--这是菜单按钮的通行行为,少了这一步第一次按向下会跳过第一项.
     * 到头回绕.
     */
    private _moveFocus(delta: number): void {
        const count = this.items.length;
        if (count === 0) return;

        this.activeIndex = this.activeIndex < 0
            ? (delta > 0 ? 0 : count - 1)
            : (this.activeIndex + delta + count) % count;
        this.items[this.activeIndex].focus();
    }
}
