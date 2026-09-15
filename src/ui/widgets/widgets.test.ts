/**
 * 控件词表的单测(最小 DOM 桩,见 `test/domStub.ts`,不引入 jsdom).
 *
 * 锁三件事:
 * 1. **DOM 与手写 HTML 同构** -- 类名/结构是 CSS 的公开契约,控件一旦改了
 *    类名,`css/controls.css` 的样式就静默失效;
 * 2. **状态只有一处** -- `get()` 读的就是控件自己的 DOM 状态,`set()` 不触发
 *    回调(那是"用户操作"的语义);
 * 3. **dispose 真解绑** -- 桩复刻了 `{ signal }` 语义,控件漏掉 signal 接线
 *    会让"dispose 后仍响应事件"的回归暴露出来.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomStub, StubElement } from '../../test/domStub';
import { createButton } from './Button';
import { el } from './dom';
import { createNumberField } from './NumberField';
import { createPopover } from './Popover';
import {
    createControlGroup,
    createInlineToggle,
    createNumberRow,
    createSwitchRow,
} from './Row';
import { createSegmented } from './Segmented';
import { createSlider } from './Slider';
import { createSwitch } from './Switch';

beforeEach(() => {
    installDomStub();
});

type Mode = 'size' | 'scale';

/** 桩元素才有 dispatch/listeners;句柄对外的类型是真 DOM,这里按需下钻. */
function stub(element: unknown): StubElement {
    return element as StubElement;
}

describe('createSwitch', () => {
    it('产出 .switch/.slider 结构,初值与 get/set 一致', () => {
        const handle = createSwitch({ value: true, ariaLabel: '锁定旋转' });

        expect(handle.element.className).toBe('switch');
        expect(handle.element.querySelector('.slider')).not.toBeNull();
        expect(handle.input.type).toBe('checkbox');
        expect(handle.input.getAttribute('aria-label')).toBe('锁定旋转');
        expect(handle.get()).toBe(true);

        handle.set(false);
        expect(handle.get()).toBe(false);
    });

    it('用户切换触发 onChange,程序化 set 不触发', () => {
        const seen: boolean[] = [];
        const handle = createSwitch({ value: false });
        handle.onChange((value) => seen.push(value));

        handle.input.checked = true;
        stub(handle.input).dispatch('change');
        expect(seen).toEqual([true]);

        handle.set(false);
        expect(seen).toEqual([true]);
    });

    it('dispose 后不再响应事件', () => {
        const seen: boolean[] = [];
        const handle = createSwitch({ value: false });
        handle.onChange((value) => seen.push(value));

        handle.dispose();
        handle.input.checked = true;
        stub(handle.input).dispatch('change');
        expect(seen).toEqual([]);
    });

    it('省略 ariaLabel 时不写 aria-label(可见 <label for> 才是名字来源)', () => {
        const handle = createSwitch({ value: false });
        expect(handle.input.getAttribute('aria-label')).toBeNull();
    });
});

describe('createSegmented', () => {
    const items = [
        { value: 'size' as Mode, label: '设定大小' },
        { value: 'scale' as Mode, label: '按比例缩放' },
    ];

    it('产出统一的 .segmented 容器,列数写进 --segmented-columns', () => {
        const handle = createSegmented<Mode>({
            columns: 2,
            ariaLabel: '点的显示方式',
            value: 'size',
            items,
        });

        expect(handle.element.className).toBe('segmented');
        // 列数由控件给,CSS 消费:三个调用点过去各有一条 CSS 规则,现在只剩这一份
        expect(handle.element.style.getPropertyValue('--segmented-columns')).toBe('2');
        expect(handle.element.getAttribute('aria-label')).toBe('点的显示方式');
        const buttons = stub(handle.element).children as StubElement[];
        expect(buttons).toHaveLength(2);
        expect(buttons[0].textContent).toBe('设定大小');
        expect(buttons[0].classList.contains('active')).toBe(true);
        expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
        expect(buttons[1].classList.contains('active')).toBe(false);
    });

    it('modifier 追加布局修饰类(行内撑满),不影响基础类名', () => {
        const handle = createSegmented<Mode>({
            columns: 3,
            modifier: 'segmented--inline',
            ariaLabel: '向上轴',
            value: 'size',
            items,
        });

        expect(handle.element.className).toBe('segmented segmented--inline');
        expect(handle.element.style.getPropertyValue('--segmented-columns')).toBe('3');
    });

    it('点击切换高亮并只回调一次;重复点已选项不回调', () => {
        const seen: Mode[] = [];
        const handle = createSegmented<Mode>({
            columns: 2,
            ariaLabel: '点的显示方式',
            value: 'size',
            items,
        });
        handle.onChange((value) => seen.push(value));
        const buttons = stub(handle.element).children as StubElement[];

        buttons[1].dispatch('click');
        expect(seen).toEqual(['scale']);
        expect(handle.get()).toBe('scale');
        expect(buttons[0].classList.contains('active')).toBe(false);
        expect(buttons[1].classList.contains('active')).toBe(true);

        buttons[1].dispatch('click');
        expect(seen).toEqual(['scale']);
    });

    it('set() 只改高亮,不回调;dispose 后不再响应点击', () => {
        const seen: Mode[] = [];
        const handle = createSegmented<Mode>({
            columns: 2,
            ariaLabel: '点的显示方式',
            value: 'size',
            items,
        });
        handle.onChange((value) => seen.push(value));
        const buttons = stub(handle.element).children as StubElement[];

        handle.set('scale');
        expect(handle.get()).toBe('scale');
        expect(buttons[1].classList.contains('active')).toBe(true);
        expect(seen).toEqual([]);

        handle.dispose();
        buttons[0].dispatch('click');
        expect(seen).toEqual([]);
    });
});

describe('createNumberField', () => {
    it('写进 min/max/step/id,并按 format 落地初值', () => {
        const handle = createNumberField({
            value: 0.2,
            min: 0,
            step: 0.05,
            format: (value) => String(Number(value.toFixed(4))),
        });

        expect(handle.element).toBe(handle.input);
        expect(handle.input.type).toBe('number');
        expect(handle.input.min).toBe('0');
        expect(handle.input.step).toBe('0.05');
        expect(handle.input.id).not.toBe('');
        expect(handle.readText()).toBe('0.2');
        expect(handle.read()).toBe(0.2);
    });

    it('空串与中途态解析为 null;合法文本解析为数', () => {
        const handle = createNumberField({ value: 1, ariaLabel: '线宽' });
        expect(handle.input.getAttribute('aria-label')).toBe('线宽');

        handle.writeText('');
        expect(handle.read()).toBeNull();
        handle.writeText('  ');
        expect(handle.read()).toBeNull();
        handle.writeText('-');
        expect(handle.read()).toBeNull();
        handle.writeText('1e');
        expect(handle.read()).toBeNull();
        handle.writeText('Infinity');
        expect(handle.read()).toBeNull();
        handle.writeText('2.5');
        expect(handle.read()).toBe(2.5);
    });

    it('input 与 change 各自回调,且都不改写用户文本', () => {
        const inputs: Array<number | null> = [];
        const commits: Array<number | null> = [];
        const handle = createNumberField({ value: 3 });
        handle.onInput((value) => inputs.push(value));
        handle.onCommit((value) => commits.push(value));

        handle.writeText('4.5');
        stub(handle.input).dispatch('input');
        expect(inputs).toEqual([4.5]);
        expect(handle.readText()).toBe('4.5');

        handle.writeText('abc');
        stub(handle.input).dispatch('input');
        expect(inputs).toEqual([4.5, null]);
        // 控件不替调用方决定非法文本怎么办,所以文本原样保留
        expect(handle.readText()).toBe('abc');

        handle.writeText('6');
        stub(handle.input).dispatch('change');
        expect(commits).toEqual([6]);
    });

    it('write() 走 format,dispose 后不再回调', () => {
        const inputs: Array<number | null> = [];
        const handle = createNumberField({
            value: 0,
            format: (value) => value.toFixed(2),
        });
        handle.onInput((value) => inputs.push(value));

        handle.write(1.239);
        expect(handle.readText()).toBe('1.24');

        handle.dispose();
        stub(handle.input).dispatch('input');
        expect(inputs).toEqual([]);
    });
});

describe('createSlider', () => {
    it('写进 min/max/step/id,初值即 value', () => {
        const handle = createSlider({ value: 1, min: 0, max: 5, step: 0.1 });

        expect(handle.element).toBe(handle.input);
        expect(handle.input.type).toBe('range');
        expect(handle.input.min).toBe('0');
        expect(handle.input.max).toBe('5');
        expect(handle.input.step).toBe('0.1');
        expect(handle.input.id).not.toBe('');
        expect(handle.get()).toBe(1);
    });

    it('拖动回调收到数值;程序化 set 不回调;dispose 后不再回调', () => {
        const seen: number[] = [];
        const handle = createSlider({ value: 1, min: 0, max: 5, step: 0.1 });
        handle.onInput((value) => seen.push(value));

        handle.input.value = '2.5';
        stub(handle.input).dispatch('input');
        expect(seen).toEqual([2.5]);

        handle.set(4);
        expect(handle.get()).toBe(4);
        expect(seen).toEqual([2.5]);

        handle.dispose();
        stub(handle.input).dispatch('input');
        expect(seen).toEqual([2.5]);
    });
});

describe('createButton', () => {
    it('永远是 type=button,类名/文案/可访问名/标题/禁用态按选项落地', () => {
        const handle = createButton({
            class: 'param-reset-btn',
            text: '↺',
            ariaLabel: '重置 a 为 1',
            title: '重置为 1',
            disabled: true,
        });

        expect(handle.element.tagName).toBe('button');
        expect(handle.element.type).toBe('button');
        expect(handle.element.className).toBe('param-reset-btn');
        expect(handle.element.textContent).toBe('↺');
        expect(handle.element.getAttribute('aria-label')).toBe('重置 a 为 1');
        expect(handle.element.title).toBe('重置为 1');
        expect(handle.element.disabled).toBe(true);
    });

    it('点击触发回调;setText/setDisabled 就地更新;dispose 后不再响应', () => {
        let clicks = 0;
        const handle = createButton({ text: '隐藏' });
        handle.onClick(() => {
            clicks += 1;
        });

        stub(handle.element).dispatch('click');
        expect(clicks).toBe(1);

        handle.setText('显示');
        handle.setDisabled(true);
        expect(handle.element.textContent).toBe('显示');
        expect(handle.element.disabled).toBe(true);

        handle.dispose();
        stub(handle.element).dispatch('click');
        expect(clicks).toBe(1);
    });
});

describe('createPopover', () => {
    function setup(): {
        trigger: HTMLButtonElement;
        panel: HTMLDivElement;
        root: HTMLDivElement;
        handle: ReturnType<typeof createPopover>;
    } {
        const root = el('div');
        const trigger = el('button', { text: '示例' });
        const panel = el('div', { class: 'example-menu' });
        panel.id = 'example-menu';
        root.append(trigger, panel);
        document.body.append(root);

        const handle = createPopover({ trigger, panel });
        handle.bind(root);
        return { trigger, panel, root, handle };
    }

    it('初始关闭,aria 关系指向浮层', () => {
        const { trigger, panel, handle } = setup();

        expect(handle.isOpen).toBe(false);
        expect(panel.classList.contains('is-open')).toBe(false);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(trigger.getAttribute('aria-controls')).toBe('example-menu');
    });

    it('点触发按钮开合,并通知订阅者', () => {
        const { trigger, panel, handle } = setup();
        const seen: boolean[] = [];
        handle.onOpenChange((open) => seen.push(open));

        stub(trigger).dispatch('click');
        expect(handle.isOpen).toBe(true);
        expect(panel.classList.contains('is-open')).toBe(true);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');

        stub(trigger).dispatch('click');
        expect(handle.isOpen).toBe(false);
        expect(seen).toEqual([true, false]);
    });

    it('点浮层外关闭;点浮层内与触发按钮都不关闭', () => {
        const { trigger, panel, root, handle } = setup();
        stub(trigger).dispatch('click');

        const inside = el('span', { text: '项' });
        panel.append(inside);
        stub(root).dispatch('click', { target: inside });
        expect(handle.isOpen).toBe(true);

        // 按钮的 click 会冒泡到根节点:不排除它就会"刚打开又被关掉"
        stub(root).dispatch('click', { target: trigger });
        expect(handle.isOpen).toBe(true);

        stub(root).dispatch('click', { target: root });
        expect(handle.isOpen).toBe(false);
    });

    it('close({ focusTrigger }) 交还焦点;open/close 幂等', () => {
        const { trigger, handle } = setup();
        const focus = vi.spyOn(trigger, 'focus');

        handle.open();
        handle.open();
        expect(handle.isOpen).toBe(true);

        handle.close({ focusTrigger: true });
        expect(focus).toHaveBeenCalledTimes(1);
        // 已经关着时不再重复聚焦(鼠标点外部关闭不该抢焦点)
        handle.close({ focusTrigger: true });
        expect(focus).toHaveBeenCalledTimes(1);
    });

    it('dispose 关闭浮层并摘掉监听', () => {
        const { trigger, panel, handle } = setup();
        stub(trigger).dispatch('click');

        handle.dispose();

        expect(handle.isOpen).toBe(false);
        expect(panel.classList.contains('is-open')).toBe(false);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');

        stub(trigger).dispatch('click');
        expect(handle.isOpen).toBe(false);
    });
});

describe('小节,行与行内小件', () => {
    it('createControlGroup 用标题给小节命名(aria-labelledby)', () => {
        const toggle = createSwitch({ value: true });
        const group = createControlGroup('点', createSwitchRow('全局可见', toggle));

        expect(group.className).toBe('control-group');
        expect(group.tagName).toBe('section');
        const header = stub(group).children[0] as StubElement;
        expect(header.tagName).toBe('header');
        expect(header.className).toBe('control-title');
        expect(header.textContent).toBe('点');
        // 标题 id 与 aria-labelledby 指向同一个节点,小节才成为有名字的 region
        expect(group.getAttribute('aria-labelledby')).toBe(header.id);
        expect(header.id).not.toBe('');
    });

    it('createSwitchRow 让可见文字成为 <label for> 的名字来源', () => {
        const toggle = createSwitch({ value: true });
        const row = createSwitchRow('全局可见', toggle);

        expect(row.className).toBe('control-row');
        const label = stub(row).children[0] as StubElement;
        expect(label.tagName).toBe('label');
        expect(label.textContent).toBe('全局可见');
        expect(label.htmlFor).toBe(toggle.input.id);
        expect(stub(row).children[1]).toBe(stub(toggle.element));
    });

    it('createInlineToggle 产出 .control-toggle-group', () => {
        const toggle = createSwitch({ value: true });
        const group = createInlineToggle('X', toggle);

        expect(group.className).toBe('control-toggle-group');
        expect((stub(group).children[0] as StubElement).htmlFor)
            .toBe(toggle.input.id);
    });

    it('createNumberRow 把标签与数字框关联,并返回标签节点', () => {
        const field = createNumberField({ value: 3, min: 1, step: 0.5 });
        const { row, label } = createNumberRow('线宽', field);

        expect(row.className).toBe('control-row');
        expect(label.htmlFor).toBe(field.input.id);
        expect(stub(row).children[1]).toBe(stub(field.input));
    });
});
