/**
 * 实体列表(item/列表边界)单测(最小 DOM 桩,见 test/domStub.ts).
 *
 * `ObjectListController.test.ts` 覆盖的是整个 footer 的输出;这里锁左栏自己的
 * 不变量,因为实体行结构已经从控制器搬进了 `EntityItem`/`EntityList`:
 * 1. 内容键不变 -> **整行复用**(同一个 DOM 节点:KaTeX 不重排,文本选择不丢);
 * 2. 内容键变了 -> 重建行,同名旧行不残留;
 * 3. 行末显隐按钮把 `toggleEntity(id)` 回调出去;
 * 4. 消失的对象连行一起删除.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneObject } from '../../ir';
import { installDomStub, StubElement } from '../../test/domStub';

vi.mock('katex', () => ({
    default: {
        // 真 KaTeX 会把排版结果写进传入的元素;桩里直接回写 TeX 文本.
        render: (tex: string, element: { textContent: string }) => {
            element.textContent = tex;
        },
    },
}));
vi.mock('katex/dist/katex.min.css', () => ({}));

import { EntityList } from './EntityList';

beforeEach(() => {
    installDomStub();
});

const curve: SceneObject = {
    kind: 'curve',
    id: 1,
    name: 'c1',
    expr: 'sin(x)',
    coefficients: [],
    color: '#ffffff',
    enabled: true,
};

function createList(): {
    container: StubElement;
    calls: number[];
    list: EntityList;
} {
    const container = new StubElement('div');
    const calls: number[] = [];
    const list = new EntityList(container as unknown as HTMLElement, {
        toggleEntity: (id) => calls.push(id),
    });
    return { container, calls, list };
}

describe('实体列表:行缓存 / 顺序 / 显隐回调', () => {
    it('容器显式带列表语义', () => {
        const { container } = createList();
        expect(container.getAttribute('role')).toBe('list');
    });

    it('内容键不变时复用同一个 DOM 行', () => {
        const { container, list } = createList();
        list.render([curve], { 1: 'y=1' });
        const first = container.querySelector<StubElement>('.entity-row')!;

        list.render([curve], { 1: 'y=1' });

        expect(container.querySelector<StubElement>('.entity-row')).toBe(first);
        expect(container.children).toHaveLength(1);
    });

    it('公式变化时重建行,旧行不残留', () => {
        const { container, list } = createList();
        list.render([curve], { 1: 'y=1' });
        const first = container.querySelector<StubElement>('.entity-row')!;

        list.render([curve], { 1: 'y=2' });

        const second = container.querySelector<StubElement>('.entity-row')!;
        expect(second).not.toBe(first);
        // 旧行被摘除:同名条目只留一行.
        expect(container.children).toHaveLength(1);
        expect(second.querySelector<StubElement>('.object-expr')!.textContent)
            .toBe('y=2');
    });

    it('显隐按钮回调带实体 id,消失的对象连行一起删', () => {
        const { container, calls, list } = createList();
        list.render([curve], { 1: 'y=1' });

        container
            .querySelector<StubElement>('.row-visibility-btn')!
            .dispatch('click');
        expect(calls).toEqual([1]);

        list.render([], {});
        expect(container.querySelector<StubElement>('.entity-row')).toBeNull();
        expect(container.children).toHaveLength(0);
    });

    it('内容都在 .row-main 里,显隐按钮是行末的直接子节点', () => {
        const { container, list } = createList();
        list.render([curve], { 1: 'y=1' });

        const row = container.querySelector<StubElement>('.entity-row')!;
        const main = row.querySelector<StubElement>('.row-main')!;
        const head = row.querySelector<StubElement>('.object-head')!;
        const expr = row.querySelector<StubElement>('.object-expr')!;
        const toggle = row.querySelector<StubElement>('.row-visibility-btn')!;

        // 名称行与公式都在主内容包装里;公式独占第二行靠
        // `.entity-row > .row-main > .object-expr { flex-basis: 100% }`
        // (见 panels.css).
        expect(head.parent).toBe(main);
        expect(expr.parent).toBe(main);
        expect(head.querySelector<StubElement>('.object-expr')).toBeNull();

        // 行的直接子节点只有"主内容 + 按钮":按钮在末位,主内容 flex:1 把它
        // 推到右端(见 rowDom.createObjectRow).
        expect(row.children).toHaveLength(2);
        expect(row.children[0]).toBe(main);
        expect(row.children[1]).toBe(toggle);
        expect(toggle.parent).toBe(row);
    });

    it('颜色定义是"色块 + 明文值",紧跟在类型徽章后面(同一行)', () => {
        const { container, list } = createList();
        list.render([{ ...curve, color: '#ff0000' }], { 1: 'y=1' });

        const row = container.querySelector<StubElement>('.entity-row')!;
        const main = row.querySelector<StubElement>('.row-main')!;
        const badge = row.querySelector<StubElement>('.kind-badge')!;
        const color = row.querySelector<StubElement>('.object-color')!;

        // 与徽章同为主内容的直接子节点(不在名称行里),且紧跟徽章之后.
        expect(badge.parent).toBe(main);
        expect(color.parent).toBe(main);
        expect(main.children.indexOf(color)).toBe(main.children.indexOf(badge) + 1);

        // 明文值 + 色块各给一条线索:颜色不是只靠颜色表达.
        expect(color.querySelector<StubElement>('.object-color-code')!.textContent)
            .toBe('#ff0000');
        expect(
            color
                .querySelector<StubElement>('.object-color-swatch')!
                .style.getPropertyValue('--object-color'),
        ).toBe('#ff0000');
        expect(color.getAttribute('aria-label')).toBe('颜色 #ff0000');
    });

    it('颜色变化会重建行(颜色已渲染,必须进内容键)', () => {
        const { container, list } = createList();
        list.render([curve], { 1: 'y=1' });
        const first = container.querySelector<StubElement>('.entity-row')!;

        list.render([{ ...curve, color: '#00ff00' }], { 1: 'y=1' });

        const second = container.querySelector<StubElement>('.entity-row')!;
        expect(second).not.toBe(first);
        expect(second.querySelector<StubElement>('.object-color-code')!.textContent)
            .toBe('#00ff00');
    });
});
