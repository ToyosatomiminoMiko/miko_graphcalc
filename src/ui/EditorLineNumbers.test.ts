/**
 * 编辑器行号栏单测(UI-P3.10).
 *
 * 锁四条:按 `\n` 重绘行号,按 scrollTop 反向平移,`refresh()` 覆盖程序化改值,
 * 缺结构时构造即报错(依赖不再藏在"父节点里按 id 查"的实现里).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installDomStub, type DomStub, type StubElement } from '../test/domStub';
import { EditorLineNumbers } from './EditorLineNumbers';

interface Harness {
    readonly stub: DomStub;
    readonly editor: StubElement;
    readonly gutter: StubElement;
    readonly numbers: StubElement;
    readonly lineNumbers: EditorLineNumbers;
}

function setup(value = 'a\nb'): Harness {
    const stub = installDomStub();
    const editor = stub.document.createElement('textarea');
    editor.value = value;
    const gutter = stub.document.createElement('div');
    const numbers = stub.document.createElement('pre');
    stub.document.body.append(editor, gutter, numbers);

    const lineNumbers = new EditorLineNumbers(
        editor as unknown as HTMLTextAreaElement,
        {
            gutter: gutter as unknown as HTMLElement,
            numbers: numbers as unknown as HTMLElement,
        },
    );
    return { stub, editor, gutter, numbers, lineNumbers };
}

beforeEach(() => {
    installDomStub();
});

describe('行号重绘与滚动同步', () => {
    it('构造时按 \\n 计数渲染行号', () => {
        const { numbers } = setup('a\nb\nc');
        expect(numbers.textContent).toBe('1\n2\n3');
    });

    it('input 事件重算行数', () => {
        const { editor, numbers } = setup('a');

        editor.value = 'a\nb\nc\nd';
        editor.dispatch('input');

        expect(numbers.textContent).toBe('1\n2\n3\n4');
    });

    it('scroll 事件按 scrollTop 反向平移', () => {
        const { editor, numbers } = setup();

        editor.scrollTop = 40;
        editor.dispatch('scroll');

        expect(numbers.style.transform).toBe('translateY(-40px)');
    });

    it('ResizeObserver 触发时重新校准平移', () => {
        const { stub, editor, numbers } = setup();

        editor.scrollTop = 25;
        expect(stub.resizeObservers).toHaveLength(1);
        stub.resizeObservers[0].trigger();

        expect(numbers.style.transform).toBe('translateY(-25px)');
    });

    it('按字体度量写入 gutter 槽宽', () => {
        const { gutter } = setup();
        // 桩的 measureText 按字符数给宽:2 位数 -> 16px + 15px chrome = 31 -> 下限 32px.
        expect(gutter.style.getPropertyValue('--code-gutter-width')).toBe('32px');
    });
});

describe('程序化改值的刷新入口(UI-P3.10)', () => {
    it('不派发 input 时行号不自动更新,refresh() 后跟上', () => {
        const { editor, numbers, lineNumbers } = setup('a');

        editor.value = 'a\nb\nc';
        expect(numbers.textContent).toBe('1');

        lineNumbers.refresh();

        expect(numbers.textContent).toBe('1\n2\n3');
    });

    it('dispose 后 refresh 与事件都不再改行号', () => {
        const { editor, numbers, lineNumbers } = setup('a');

        lineNumbers.dispose();
        editor.value = 'a\nb';
        editor.dispatch('input');
        lineNumbers.refresh();

        expect(numbers.textContent).toBe('1');
    });
});

describe('结构缺失', () => {
    it('gutter/行号节点缺失时构造直接报错', () => {
        const stub = installDomStub();
        const editor = stub.document.createElement('textarea');

        expect(() => new EditorLineNumbers(
            editor as unknown as HTMLTextAreaElement,
            { gutter: null, numbers: null },
        )).toThrow(/dsl-editor-gutter/);
    });
});
