/**
 * 示例载入菜单控制器.
 *
 * 左侧「源码」标题栏里的「示例」按钮打开一个分组浮层,列出 `example/` 下的
 * 全部示例(清单见 `exampleCatalog.ts`).选中一项即回调装配层去替换编辑器
 * 源码并运行 -- 本控制器不碰编辑器,也不认识窗口:它只做两件事,把
 * `groupedExamples()` 翻成库的菜单数据,再把选中回调转给装配层.
 *
 * 结构 / 分组 / 菜单项 / 当前项 / 开合 / 点外部关闭 / aria 全在库的
 * `createMenu` 里(见 `@miko/ui` 的 `widgets/Menu.ts`):面板节点由窗口标题栏的
 * overlays 槽位提供(见 `windowChrome.ts` 与 `UI_CONFIG.window.adopted`),
 * 触发元素就是标题栏那颗「示例」按钮.
 *
 * **键盘一件都不做**:库不负责菜单键盘(见库 `Menu.ts` 的"键盘:一件都不做"),
 * 这里也不自己接 -- 上下键与 Esc 都没有,浮层靠点按钮开合,点面板外部关闭.
 *
 * 为什么是浮层而不是一个 `<select>`:示例要按主题分组,每项还要显示中文标题;
 * 面板默认宽只有 300px,下拉里标题只能截断,也没有分组.
 */
import { createMenu, type MenuGroup, type MenuHandle } from '@miko/ui';
import { UI_CONFIG } from '@/config/uiConfig';
import { allExamples, groupedExamples, type ExampleEntry } from './exampleCatalog';

/** 菜单依赖的两个节点;由装配层取好传入(取不到时构造即报错). */
export interface ExampleLoaderElements {
    readonly button: HTMLElement;
    readonly menu: HTMLElement;
}

/**
 * 把示例清单按分组翻成库的菜单数据.
 *
 * `groupedExamples()` 已保证顺序,"空组不出现",并把分组键翻成显示名 -- 本函数
 * 不碰"键 -> 中文名"这份映射.每项的载荷是**文件名**(与 `exampleCatalog` 的
 * `file` 同一份值,选中回调与 `setActive` 都用它),注记是去掉 `.miko` 的文件名:
 * 中文标题在左,文件名在右做"这是哪个文件"的对照.
 */
function menuGroups(): readonly MenuGroup<string>[] {
    return groupedExamples().map((section) => ({
        title: section.title,
        entries: section.entries.map((entry) => ({
            value: entry.file,
            text: entry.title,
            hint: entry.file.replace(/\.miko$/, ''),
        })),
    }));
}

export class ExampleLoaderController {
    private readonly menu: MenuHandle<string>;

    constructor(
        elements: ExampleLoaderElements,
        private readonly onSelect: (entry: ExampleEntry) => void,
    ) {
        if (!elements.button || !elements.menu) {
            throw new Error('ExampleLoaderController 缺少示例按钮或浮层节点(见 @miko/ui/src/desktop/windowChrome.ts)');
        }

        this.menu = createMenu({
            groups: menuGroups(),
            // 读屏名沿用触发按钮那份文案,唯一来源在 UI_CONFIG.
            ariaLabel: UI_CONFIG.window.chrome.exampleLabel,
            trigger: elements.button,
            panel: elements.menu,
        });
        // 选中的唯一业务出口:载荷是文件名,这里翻回整条目给装配层(它要用
        // `entry.file` 取源码,标当前项).
        this.menu.onSelect((file) => {
            const entry = allExamples().find((candidate) => candidate.file === file);
            if (entry) this.onSelect(entry);
        });
    }

    get isOpen(): boolean {
        return this.menu.isOpen;
    }

    /** 把"点浮层外部关闭"挂到根节点(键盘不在这里,见文件头). */
    bind(root: HTMLElement): void {
        this.menu.bind(root);
    }

    /**
     * 标记当前已载入的示例(高亮 + `aria-current`);文件名不在清单里时全部取消标记.
     * 只影响展示,不影响载入逻辑.
     */
    setActive(file: string): void {
        this.menu.setActive(file);
    }

    dispose(): void {
        this.menu.dispose();
    }
}
