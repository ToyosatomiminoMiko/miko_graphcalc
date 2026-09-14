/**
 * 示例载入菜单控制器.
 *
 * 左侧「源码」标题栏里的「示例」按钮打开一个分组浮层,列出 `example/` 下的
 * 全部示例(清单见 `exampleCatalog.ts`).选中一项即回调装配层去替换编辑器
 * 源码并运行--本控制器不碰编辑器,只管"开合 / 选中 / 键盘"三件事.
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
 * 「点外部关闭」只能自己绑 click(键盘出口的约定不覆盖鼠标):监听落在
 * `bind(root)` 传入的根节点上,由它判断这次点击是否落在菜单与按钮之外.
 * 按钮自己的 click 会先冒泡到菜单再冒到根,所以根处理里必须显式排除按钮,
 * 否则"点按钮打开"会被紧随其后的根处理立刻关掉.
 */
import type { KeyboardBinding } from '../../service/KeyboardController';
import { EXAMPLE_CATALOG, groupedExamples, type ExampleEntry } from './exampleCatalog';

/** 菜单依赖的两个节点;由装配层取好传入(取不到时构造即报错). */
export interface ExampleLoaderElements {
    readonly button: HTMLElement;
    readonly menu: HTMLElement;
}

export class ExampleLoaderController {
    /** 菜单项按渲染顺序保存,上下键导航只在这里面走. */
    private readonly items: HTMLElement[] = [];
    private abortController: AbortController | null = null;
    private opened = false;
    /** 当前拥有焦点的菜单项下标;-1 表示焦点还在按钮上(刚打开). */
    private activeIndex = -1;

    constructor(
        private readonly elements: ExampleLoaderElements,
        private readonly onSelect: (entry: ExampleEntry) => void,
    ) {
        if (!elements.button || !elements.menu) {
            throw new Error('ExampleLoaderController 缺少 #example-btn / #example-menu 结构');
        }
        this._render();
        // 初始态也由本控制器写入,不依赖 HTML 里的占位属性:
        // "开着吗"只有一个状态源(opened)与一个写入点(_applyOpen).
        this._applyOpen(false);
        // aria-controls 取菜单节点的真实 id:HTML 里那份只是首帧占位,
        // 真值以这里为准,id 改了也不会留下指向空气的 aria 关系.
        if (this.elements.menu.id) {
            this.elements.button.setAttribute('aria-controls', this.elements.menu.id);
        }
    }

    get isOpen(): boolean {
        return this.opened;
    }

    bind(root: HTMLElement): void {
        this.abortController?.abort();
        this.abortController = new AbortController();
        const options = { signal: this.abortController.signal };

        this.elements.button.addEventListener('click', this._onButtonClick, options);
        this.elements.menu.addEventListener('click', this._onMenuClick, options);
        root.addEventListener('click', this._onRootClick, options);
    }

    /** Esc / 上下键经 KeyboardController 统一路由. */
    keyboardBindings(): KeyboardBinding[] {
        return [
            {
                keys: ['Escape'],
                resolve: () => (this.opened ? () => this.close({ focusButton: true }) : null),
            },
            {
                // 菜单关着时放行:上下键在别处(如 select,列表滚动)还有自己的语义.
                keys: ['ArrowDown', 'ArrowUp'],
                resolve: (event) => (this.opened
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
        if (!this.opened) return;
        this._applyOpen(false);
        if (options.focusButton) this.elements.button.focus();
    }

    dispose(): void {
        // 先复位 DOM 再摘监听:dispose 后浮层不能留在屏幕上.
        this.close();
        this.abortController?.abort();
        this.abortController = null;
    }

    /** 按分组渲染菜单项;`groupedExamples()` 已保证顺序与"空组不出现". */
    private _render(): void {
        const sections = groupedExamples().map((section) => {
            const group = document.createElement('div');
            group.className = 'example-menu-group';
            group.setAttribute('role', 'group');
            group.setAttribute('aria-label', section.group);

            const title = document.createElement('div');
            title.className = 'example-menu-group-title';
            title.textContent = section.group;
            group.append(title);

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
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'example-menu-item';
        item.dataset.example = entry.file;
        item.setAttribute('role', 'menuitem');
        // 中文标题在前(读的是它),文件名在后做"这是哪个文件"的对照.
        item.title = `example/${entry.file}`;

        const label = document.createElement('span');
        label.className = 'example-menu-label';
        label.textContent = entry.title;

        const file = document.createElement('span');
        file.className = 'example-menu-file';
        file.textContent = entry.file.replace(/\.scad$/, '');

        item.append(label, file);
        return item;
    }

    private readonly _onButtonClick = (): void => {
        this._applyOpen(!this.opened);
    };

    /**
     * 开合态的唯一写入点:状态,浮层类名,按钮 aria 一起刷新,
     * 构造 / 点击 / 选中 / Esc / dispose 都走这一条路径.
     *
     * 打开时把 activeIndex 复位成 -1:此时焦点还在按钮上,第一次按下箭头
     * 才落到第一项(见 _moveFocus).
     */
    private _applyOpen(opened: boolean): void {
        this.opened = opened;
        this.activeIndex = -1;
        this.elements.menu.classList.toggle('is-open', opened);
        this.elements.button.setAttribute('aria-expanded', String(opened));
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

    private readonly _onRootClick = (event: MouseEvent): void => {
        if (!this.opened) return;
        const target = event.target;
        if (
            target instanceof Element
            && (this.elements.button.contains(target) || this.elements.menu.contains(target))
        ) {
            return;
        }
        this.close();
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
