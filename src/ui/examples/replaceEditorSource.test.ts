/**
 * 编辑器程序化写入的单测.
 *
 * 这里锁的是"保留撤销栈"这条路径的调用契约:全选 + `execCommand('insertText')`,
 * 以及命令不可用/被拒绝时的兜底赋值.
 *
 * "按 Ctrl+Z 真的能退回"属于浏览器编辑管线的语义,node 里的 DOM 桩无法覆盖,
 * 已在 Chromium 152 与 Firefox 155 实测:走 execCommand 覆盖后一次 Ctrl+Z
 * 整段退回;直接 `.value =` 覆盖则撤销栈被清空,连按 10 次也回不去--这正是
 * 本模块存在的理由.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomStub, type DomStub, type StubElement } from '@/testing/domStub';
import { replaceTextareaSource, seedTextareaSource } from './replaceEditorSource';

interface Harness {
    readonly stub: DomStub;
    readonly editor: StubElement;
    readonly focusSpy: ReturnType<typeof vi.spyOn>;
    readonly selectSpy: ReturnType<typeof vi.spyOn>;
}

function setup(): Harness {
    const stub = installDomStub();
    const editor = stub.document.createElement('textarea');
    editor.value = 'USER CODE';
    stub.document.body.append(editor);
    return {
        stub,
        editor,
        focusSpy: vi.spyOn(editor, 'focus'),
        selectSpy: vi.spyOn(editor, 'select'),
    };
}

function replace(h: Harness, source: string): boolean {
    return replaceTextareaSource(h.editor as unknown as HTMLTextAreaElement, source);
}

beforeEach(() => {
    installDomStub();
});

describe('replaceTextareaSource', () => {
    it('优先全选 + execCommand(insertText),且不自己赋值', () => {
        const h = setup();
        h.stub.execCommand.result = true;

        expect(replace(h, 'EXAMPLE SOURCE')).toBe(true);

        // 先聚焦再全选:焦点不在编辑器上时 Chrome 会插错地方,Firefox 直接失败.
        expect(h.focusSpy).toHaveBeenCalledTimes(1);
        expect(h.selectSpy).toHaveBeenCalledTimes(1);
        expect(h.stub.execCommand.args).toEqual([
            ['insertText', false, 'EXAMPLE SOURCE'],
        ]);
        // 文本由浏览器编辑命令写入;这里若再赋一次值,撤销栈就被清空了.
        expect(h.editor.value).toBe('USER CODE');
    });

    it('execCommand 返回 false 时回退到直接赋值', () => {
        const h = setup();
        h.stub.execCommand.result = false;

        expect(replace(h, 'EXAMPLE SOURCE')).toBe(false);

        expect(h.editor.value).toBe('EXAMPLE SOURCE');
    });

    it('execCommand 抛异常时回退,不把异常抛给调用方', () => {
        const h = setup();
        (h.stub.document as unknown as Record<string, unknown>).execCommand = () => {
            throw new Error('command rejected');
        };

        expect(() => replace(h, 'EXAMPLE SOURCE')).not.toThrow();
        expect(h.editor.value).toBe('EXAMPLE SOURCE');
    });

    it('环境没有 execCommand 时直接赋值', () => {
        const h = setup();
        delete (h.stub.document as unknown as Record<string, unknown>).execCommand;

        expect(replace(h, 'EXAMPLE SOURCE')).toBe(false);
        expect(h.editor.value).toBe('EXAMPLE SOURCE');
    });
});

describe('seedTextareaSource(首屏种子)', () => {
    it('直接赋值,不抢焦点,也不走编辑命令', () => {
        const h = setup();
        h.stub.execCommand.result = true;

        seedTextareaSource(h.editor as unknown as HTMLTextAreaElement, 'DEFAULT SOURCE');

        expect(h.editor.value).toBe('DEFAULT SOURCE');
        // 启动时抢焦点会盖掉窗口系统刚设好的初始焦点;种子写入也没有历史要保,
        // 不需要走编辑管线(见 seedTextareaSource 的说明).
        expect(h.focusSpy).not.toHaveBeenCalled();
        expect(h.selectSpy).not.toHaveBeenCalled();
        expect(h.stub.execCommand.args).toEqual([]);
    });
});
