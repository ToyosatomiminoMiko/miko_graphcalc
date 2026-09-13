/**
 * 参数面板控制器单测(UI-P2.1 / UI-P3.1).
 *
 * 锁的是数字输入框的**写回时机**与两个控件的可访问名:
 * - `input` 阶段不覆盖用户正在编辑的文本:空串与 `0.` 这类中途态一律不写回,
 *   否则 `Number('') === 0`,`Number('0.') === 0` 会把输入框改写成 `0`,
 *   用户既清不掉内容也打不出小数点;
 * - 归一化(夹取/回绕)后的文本只在 `change` 时写回;
 * - `<label for>` 指向滑块,数字框有独立的 `aria-label`.
 *
 * 用最小 DOM 桩(见 test/domStub.ts),`input.value` 直接赋值模拟浏览器文本,
 * `dispatch('input'/'change')` 模拟事件.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ParamDeclaration } from '../compiler/ir/types';
import { installDomStub, type DomStub, type StubElement } from '../test/domStub';
import { ParamPanelController } from './ParamPanelController';

const NUMERIC: ParamDeclaration = {
    name: 'a',
    value: 1,
    min: 0,
    max: 5,
    step: 0.1,
    cyclic: false,
};

const CYCLIC: ParamDeclaration = {
    name: 'φ',
    value: 0,
    min: -Math.PI,
    max: Math.PI,
    step: 0.1,
    cyclic: true,
};

interface Harness {
    readonly stub: DomStub;
    readonly controller: ParamPanelController;
    readonly label: StubElement;
    readonly slider: StubElement;
    readonly numberInput: StubElement;
    readonly changes: Array<[string, number]>;
}

function setup(param: ParamDeclaration): Harness {
    const stub = installDomStub();
    const panel = stub.document.createElement('div');
    stub.document.body.append(panel);

    const changes: Array<[string, number]> = [];
    const controller = new ParamPanelController(
        panel as unknown as HTMLElement,
        (name, value) => changes.push([name, value]),
    );
    controller.render([param]);

    const row = panel.children[0] as StubElement;
    const [label, slider, numberInput] = row.children as StubElement[];
    return { stub, controller, label, slider, numberInput, changes };
}

beforeEach(() => {
    installDomStub();
});

describe('数字输入框的写回时机(UI-P2.1)', () => {
    it('清空输入框不写回,不改值,失焦后恢复上一次合法值', () => {
        const { numberInput, slider, changes } = setup(NUMERIC);

        numberInput.value = '';
        numberInput.dispatch('input');

        expect(numberInput.value).toBe('');
        expect(slider.value).toBe('1');
        expect(changes).toEqual([]);

        numberInput.dispatch('change');
        expect(numberInput.value).toBe('1');
    });

    it('"0." 这类中途态不被写回,后续字符能拼成小数', () => {
        const { numberInput, slider, changes } = setup(NUMERIC);

        numberInput.value = '1.';
        numberInput.dispatch('input');
        expect(numberInput.value).toBe('1.');
        expect(slider.value).toBe('1');

        numberInput.value = '1.5';
        numberInput.dispatch('input');
        expect(numberInput.value).toBe('1.5');
        expect(slider.value).toBe('1.5');
        expect(changes[changes.length - 1]).toEqual(['a', 1.5]);

        numberInput.dispatch('change');
        expect(numberInput.value).toBe('1.5');
    });

    it('越界输入在 input 阶段只同步滑块,change 时才把归一化结果写回', () => {
        const { numberInput, slider } = setup(NUMERIC);

        numberInput.value = '9';
        numberInput.dispatch('input');
        expect(numberInput.value).toBe('9');
        expect(slider.value).toBe('5');

        numberInput.dispatch('change');
        expect(numberInput.value).toBe('5');
        expect(slider.value).toBe('5');
    });

    it('循环参数按区间长度回绕,而不是夹到端点', () => {
        const { numberInput, slider } = setup(CYCLIC);

        numberInput.value = '4';
        numberInput.dispatch('change');

        // 4 在 [-π, π] 圆周上回绕到 4 - 2π.
        const wrapped = Number(numberInput.value);
        expect(wrapped).toBeCloseTo(4 - 2 * Math.PI, 12);
        expect(Number(slider.value)).toBeCloseTo(wrapped, 12);
    });

    it('滑块输入直接同步数字框与场景', () => {
        const { slider, numberInput, changes } = setup(NUMERIC);

        slider.value = '2.5';
        slider.dispatch('input');

        expect(numberInput.value).toBe('2.5');
        expect(changes).toEqual([['a', 2.5]]);
    });

    it('getValues 反映最新输入', () => {
        const { numberInput, controller } = setup(NUMERIC);

        numberInput.value = '3';
        numberInput.dispatch('input');

        expect(controller.getValues()).toEqual({ a: 3 });
    });
});

describe('参数行的可访问名(UI-P3.1)', () => {
    it('label 通过 for 关联滑块,数字框有独立 aria-label', () => {
        const { label, slider, numberInput } = setup(NUMERIC);

        expect(slider.id).not.toBe('');
        expect(label.htmlFor).toBe(slider.id);
        expect(label.textContent).toBe('a');
        expect(numberInput.id).not.toBe(slider.id);
        expect(numberInput.getAttribute('aria-label')).toBe('a 数值');
    });

    it('循环参数的可见与可访问文案都带循环提示', () => {
        const { label, numberInput } = setup(CYCLIC);

        expect(label.textContent).toBe('φ ↻');
        expect(numberInput.getAttribute('aria-label')).toBe('φ 数值(循环)');
    });
});
