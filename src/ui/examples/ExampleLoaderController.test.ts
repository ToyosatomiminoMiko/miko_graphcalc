/**
 * 示例菜单控制器单测.
 *
 * 覆盖四块:
 * - 渲染:分组与菜单项来自 `exampleCatalog`,文件集一致;
 * - 开合:按钮切换,点浮层外部关闭,点按钮的冒泡不会把自己刚打开的浮层关掉;
 * - 选中:点菜单项(含点到项内的子元素)回调对应条目并关闭;
 * - 键盘:Esc 关闭并把焦点交还按钮,上下键从"焦点还在按钮上"进第一项,回绕.
 *
 * 键盘监听按项目约定不绑在控制器里,所以这里直接取 `keyboardBindings()` 的
 * `resolve` 来跑,而不是伪造 document keydown(路由本身由
 * KeyboardController.test.ts 覆盖).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomStub, type DomStub, type StubElement } from '@/testing/domStub';
import type { KeyboardBinding } from '@/ui/shared/KeyboardController';
import { ExampleLoaderController } from './ExampleLoaderController';
import { allExamples } from './exampleCatalog';

interface Harness {
    readonly stub: DomStub;
    readonly root: StubElement;
    readonly button: StubElement;
    readonly menu: StubElement;
    readonly buttonFocus: ReturnType<typeof vi.spyOn>;
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
    const buttonFocus = vi.spyOn(button, 'focus');
    const controller = new ExampleLoaderController(
        {
            button: button as unknown as HTMLElement,
            menu: menu as unknown as HTMLElement,
        },
        onSelect,
    );
    controller.bind(root as unknown as HTMLElement);

    return { stub, root, button, menu, buttonFocus, onSelect, controller };
}

function bindingFor(controller: ExampleLoaderController, key: string): KeyboardBinding {
    const binding = controller.keyboardBindings()
        .find((candidate) => candidate.keys.includes(key));
    if (!binding) throw new Error(`没有 ${key} 的键盘绑定`);
    return binding;
}

function itemOf(menu: StubElement, file: string): StubElement {
    const item = menu.querySelector<StubElement>(`[data-example="${file}"]`);
    if (!item) throw new Error(`菜单里没有 ${file}`);
    return item;
}

beforeEach(() => {
    installDomStub();
});

describe('菜单渲染', () => {
    it('分组与菜单项都来自示例清单', () => {
        const h = setup();

        const files = h.menu
            .querySelectorAll<StubElement>('[data-example]')
            .map((item) => item.dataset.example);
        expect(files).toEqual(allExamples().map((entry) => entry.file));

        // 分组标题是可读文本,不是菜单项
        const titles = h.menu
            .querySelectorAll<StubElement>('.example-menu-group-title')
            .map((node) => node.textContent);
        expect(titles).toEqual(['求导 / 偏导', '其他主题']);
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

        h.menu.dispatch('click', { target: itemOf(h.menu, 'sphere_gradient.miko') });

        expect(h.onSelect).toHaveBeenCalledTimes(1);
        expect(h.onSelect.mock.calls[0][0]).toMatchObject({
            file: 'sphere_gradient.miko',
            title: '球体隐式场梯度',
        });
        expect(h.controller.isOpen).toBe(false);
    });

    it('点到菜单项内部子元素也能命中该项', () => {
        const h = setup();
        h.button.dispatch('click');

        const item = itemOf(h.menu, 'Zemlya.miko');
        const label = item.querySelector<StubElement>('.example-menu-label')!;
        h.menu.dispatch('click', { target: label });

        expect(h.onSelect).toHaveBeenCalledTimes(1);
        expect(h.onSelect.mock.calls[0][0]).toMatchObject({ file: 'Zemlya.miko' });
    });
});

describe('键盘', () => {
    it('浮层关着时 Esc 与上下键都放行', () => {
        const h = setup();

        expect(bindingFor(h.controller, 'Escape').resolve({ key: 'Escape' } as KeyboardEvent))
            .toBeNull();
        expect(bindingFor(h.controller, 'ArrowDown').resolve({ key: 'ArrowDown' } as KeyboardEvent))
            .toBeNull();
    });

    it('Esc 关闭浮层并把焦点交还按钮', () => {
        const h = setup();
        h.button.dispatch('click');

        const run = bindingFor(h.controller, 'Escape').resolve({ key: 'Escape' } as KeyboardEvent);
        expect(run).not.toBeNull();
        run!();

        expect(h.controller.isOpen).toBe(false);
        expect(h.buttonFocus).toHaveBeenCalledTimes(1);
    });

    it('上下键从按钮进第一项,到头回绕', () => {
        const h = setup();
        h.button.dispatch('click');

        const items = h.menu.querySelectorAll<StubElement>('.example-menu-item');
        const focusSpies = items.map((item) => vi.spyOn(item, 'focus'));
        const down = bindingFor(h.controller, 'ArrowDown');
        const up = bindingFor(h.controller, 'ArrowUp');

        down.resolve({ key: 'ArrowDown' } as KeyboardEvent)!();
        expect(focusSpies[0]).toHaveBeenCalledTimes(1);

        down.resolve({ key: 'ArrowDown' } as KeyboardEvent)!();
        expect(focusSpies[1]).toHaveBeenCalledTimes(1);

        up.resolve({ key: 'ArrowUp' } as KeyboardEvent)!();
        expect(focusSpies[0]).toHaveBeenCalledTimes(2);

        // 在第一项上再按向上:回绕到末项,而不是卡住
        up.resolve({ key: 'ArrowUp' } as KeyboardEvent)!();
        expect(focusSpies[focusSpies.length - 1]).toHaveBeenCalledTimes(1);
    });
});

describe('高亮与销毁', () => {
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
