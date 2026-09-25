/**
 * 示例菜单控制器单测.
 *
 * 控制器现在只是库 `createMenu` 的一层适配(清单 -> `MenuGroup[]`,选中 -> 装配
 * 层),所以这里覆盖的是**接线**,菜单本身的实现由库自己的单测覆盖:
 * - 渲染:分组与菜单项来自 `exampleCatalog`,顺序与文件集一致;
 * - 结构:类名 / `role` / `aria-label` 由库写,读屏名来自配置;
 * - 开合:按钮切换,点浮层外部关闭,点按钮的冒泡不会把自己刚打开的浮层关掉;
 * - 选中:点菜单项回调对应条目并关闭浮层;
 * - 当前项:setActive 由库写成 `.is-active` + `aria-current`;
 * - 销毁:dispose 关闭浮层并摘掉监听.
 *
 * 键盘已从上下游一并移除,这里不再有键盘用例.桩不冒泡,所以"点到菜单项内部
 * 子元素"这类依赖真 DOM 冒泡的行为没法在桩里伪造,交给浏览器.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UI_CONFIG } from '@/config/uiConfig';
import { installDomStub, type DomStub, type StubElement } from '@/testing/domStub';
import { ExampleLoaderController } from './ExampleLoaderController';
import { allExamples } from './exampleCatalog';

interface Harness {
    readonly stub: DomStub;
    readonly root: StubElement;
    readonly button: StubElement;
    readonly menu: StubElement;
    readonly onSelect: ReturnType<typeof vi.fn>;
    readonly controller: ExampleLoaderController;
}

function setup(): Harness {
    const stub = installDomStub();
    const root = stub.document.createElement('div');
    root.id = 'app';
    const button = stub.document.createElement('button');
    button.id = 'example-btn';
    const menu = stub.document.createElement('div');
    menu.id = 'example-menu';
    root.append(button, menu);
    stub.document.body.append(root);

    const onSelect = vi.fn();
    const controller = new ExampleLoaderController(
        {
            button: button as unknown as HTMLElement,
            menu: menu as unknown as HTMLElement,
        },
        onSelect,
    );
    controller.bind(root as unknown as HTMLElement);

    return { stub, root, button, menu, onSelect, controller };
}

/** 按文件名找菜单项:注记(`.menu-item-hint`)就是去掉 `.miko` 的文件名. */
function itemOf(menu: StubElement, file: string): StubElement {
    const hint = file.replace(/\.miko$/, '');
    const item = menu
        .querySelectorAll<StubElement>('.menu-item')
        .find((node) => node.querySelector<StubElement>('.menu-item-hint')?.textContent === hint);
    if (!item) throw new Error(`菜单里没有 ${file}`);
    return item;
}

beforeEach(() => {
    installDomStub();
});

describe('菜单渲染', () => {
    it('分组与菜单项都来自示例清单,顺序一致', () => {
        const h = setup();

        const items = h.menu.querySelectorAll<StubElement>('.menu-item');
        // 菜单项 = 中文标题(按钮自己的文本)+ 右侧文件名注记(去掉 .miko)
        expect(items.map((node) => node.textContent)).toEqual(
            allExamples().map((entry) => entry.title + entry.file.replace(/\.miko$/, '')),
        );

        // 分组标题是可读文本,不是菜单项
        const titles = h.menu
            .querySelectorAll<StubElement>('.menu-group-title')
            .map((node) => node.textContent);
        expect(titles).toEqual(['求导 / 偏导', '其他主题']);
    });

    it('菜单的类名 / role / 读屏名由库写(不再由应用侧手写)', () => {
        const h = setup();

        expect(h.menu.getAttribute('role')).toBe('menu');
        expect(h.menu.getAttribute('aria-label')).toBe(UI_CONFIG.window.chrome.exampleLabel);
        expect(h.menu.classList.contains('menu-panel')).toBe(true);
        // 给了 trigger -> 库叠 .menu-popover 并自己建 Popover
        expect(h.menu.classList.contains('menu-popover')).toBe(true);
    });

    it('浮层初始关闭,aria 关系指向菜单', () => {
        const h = setup();

        expect(h.controller.isOpen).toBe(false);
        expect(h.menu.classList.contains('is-open')).toBe(false);
        expect(h.button.getAttribute('aria-expanded')).toBe('false');
        expect(h.button.getAttribute('aria-controls')).toBe('example-menu');
    });
});

describe('开合', () => {
    it('点按钮切换,同步 aria-expanded', () => {
        const h = setup();

        h.button.dispatch('click');
        expect(h.controller.isOpen).toBe(true);
        expect(h.menu.classList.contains('is-open')).toBe(true);
        expect(h.button.getAttribute('aria-expanded')).toBe('true');

        h.button.dispatch('click');
        expect(h.controller.isOpen).toBe(false);
        expect(h.menu.classList.contains('is-open')).toBe(false);
        expect(h.button.getAttribute('aria-expanded')).toBe('false');
    });

    it('按钮的 click 冒泡到根节点时,不会把刚打开的浮层关掉', () => {
        const h = setup();

        // 真 DOM 里按钮的 click 会继续冒泡到 #app 的委托监听;桩不冒泡,
        // 所以按真实顺序手动触发两次.
        h.button.dispatch('click');
        h.root.dispatch('click', { target: h.button });

        expect(h.controller.isOpen).toBe(true);
    });

    it('点浮层外部关闭,点浮层内部不关闭', () => {
        const h = setup();
        const item = itemOf(h.menu, 'derivative_graph.miko');

        h.button.dispatch('click');
        h.root.dispatch('click', { target: item });
        expect(h.controller.isOpen).toBe(true);

        h.root.dispatch('click', { target: h.root });
        expect(h.controller.isOpen).toBe(false);
    });
});

describe('选中示例', () => {
    it('点菜单项回调对应条目并关闭浮层', () => {
        const h = setup();
        h.button.dispatch('click');

        itemOf(h.menu, 'sphere_gradient.miko').dispatch('click');

        expect(h.onSelect).toHaveBeenCalledTimes(1);
        expect(h.onSelect.mock.calls[0][0]).toMatchObject({
            file: 'sphere_gradient.miko',
            title: '球体隐式场梯度',
        });
        expect(h.controller.isOpen).toBe(false);
    });
});

describe('当前项与销毁', () => {
    it('setActive 标记当前示例,切换时旧标记被清掉', () => {
        const h = setup();
        const first = itemOf(h.menu, 'object_addition.miko');
        const second = itemOf(h.menu, 'curl_vector_field.miko');

        h.controller.setActive('object_addition.miko');
        expect(first.classList.contains('is-active')).toBe(true);
        expect(first.getAttribute('aria-current')).toBe('true');

        h.controller.setActive('curl_vector_field.miko');
        expect(first.classList.contains('is-active')).toBe(false);
        expect(first.getAttribute('aria-current')).toBeNull();
        expect(second.classList.contains('is-active')).toBe(true);
    });

    it('清单外的文件名:全部取消标记', () => {
        const h = setup();

        h.controller.setActive('object_addition.miko');
        h.controller.setActive('no_such_example.miko');

        const active = h.menu
            .querySelectorAll<StubElement>('.menu-item')
            .filter((node) => node.classList.contains('is-active'));
        expect(active).toHaveLength(0);
    });

    it('dispose 关闭浮层并摘掉监听', () => {
        const h = setup();
        h.button.dispatch('click');

        h.controller.dispose();

        expect(h.controller.isOpen).toBe(false);
        expect(h.menu.classList.contains('is-open')).toBe(false);
        expect(h.button.getAttribute('aria-expanded')).toBe('false');

        // 摘干净了:dispose 后再点按钮不会再打开
        h.button.dispatch('click');
        expect(h.controller.isOpen).toBe(false);
    });

    it('缺少菜单结构时构造即报错', () => {
        installDomStub();
        const button = document.createElement('button');
        expect(() => new ExampleLoaderController(
            { button: button as unknown as HTMLElement, menu: null as unknown as HTMLElement },
            () => {},
        )).toThrow(/浮层节点/);
    });
});
