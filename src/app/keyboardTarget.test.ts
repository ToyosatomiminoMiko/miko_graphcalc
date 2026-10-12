/**
 * `isTypingTarget` 单测:焦点判据是应用唯一一条全局快捷键(Home)要不要让位的开关.
 *
 * 覆盖的是"哪些元素算有自己键盘语义":判错一边就会出事 -- 判宽了 Home 在编辑器里
 * 不再回行首(用户按 Home 视角乱跳),判窄了 Home 在输入框里被吞掉(光标回不去行首).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installDomStub, type DomStub, type StubElement } from 'miko_ui/testing';
import { isTypingTarget } from './keyboardTarget';

let stub: DomStub;

beforeEach(() => {
    stub = installDomStub();
});

/** 按标签名建一个桩元素(桩用 `String(Element)` 认得 `instanceof`). */
function element(tag: string): StubElement {
    const node = stub.document.createElement(tag);
    stub.document.body.append(node);
    return node;
}

describe('isTypingTarget', () => {
    it('INPUT / TEXTAREA / SELECT 都算输入目标', () => {
        expect(isTypingTarget(element('input') as unknown as EventTarget)).toBe(true);
        expect(isTypingTarget(element('textarea') as unknown as EventTarget)).toBe(true);
        expect(isTypingTarget(element('select') as unknown as EventTarget)).toBe(true);
    });

    it('标签名大小写不敏感(HTML 里常写成大写)', () => {
        expect(isTypingTarget(element('INPUT') as unknown as EventTarget)).toBe(true);
    });

    it('contenteditable 元素算输入目标,`contenteditable="false"` 不算', () => {
        const editable = element('div');
        editable.setAttribute('contenteditable', '');
        expect(isTypingTarget(editable as unknown as EventTarget)).toBe(true);

        const plain = element('div');
        plain.setAttribute('contenteditable', 'false');
        expect(isTypingTarget(plain as unknown as EventTarget)).toBe(false);
    });

    it('普通元素不算输入目标', () => {
        expect(isTypingTarget(element('div') as unknown as EventTarget)).toBe(false);
        expect(isTypingTarget(element('button') as unknown as EventTarget)).toBe(false);
    });

    it('目标不是元素(焦点在 document / body 上,或事件没有目标)时不算', () => {
        expect(isTypingTarget(null)).toBe(false);
        expect(isTypingTarget(stub.document as unknown as EventTarget)).toBe(false);
    });
});
