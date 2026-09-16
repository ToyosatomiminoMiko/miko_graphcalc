/**
 * 旧编辑命令收口的单测.
 *
 * 这个模块存在的理由是"把已弃用的 `document.execCommand` 关进一个自己声明
 * 签名的地方",所以测试锁三件事:
 * - 成功/被拒绝/抛错/命令不存在 四种结果的归一化(调用方只看 true/false);
 * - 参数形态:`showUI` 恒为 false,值原样透传;
 * - 命令必须**调用时**从 `document` 上取--DOM 桩是在模块加载之后才替换
 *   `document.execCommand` 的,若实现缓存了加载期的引用,下面每条断言都会失败.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installDomStub, type DomStub } from '../../testing/domStub';
import { runLegacyEditorCommand } from './legacyEditorCommand';

let stub: DomStub;

beforeEach(() => {
    stub = installDomStub();
});

describe('runLegacyEditorCommand', () => {
    it('命令被接受时返回 true,并把值原样透传(showUI 恒为 false)', () => {
        stub.execCommand.result = true;

        expect(runLegacyEditorCommand('insertText', 'SOURCE')).toBe(true);
        expect(stub.execCommand.args).toEqual([['insertText', false, 'SOURCE']]);
    });

    it('不带值时也能调用(剪贴板回退的 copy)', () => {
        stub.execCommand.result = true;

        expect(runLegacyEditorCommand('copy')).toBe(true);
        expect(stub.execCommand.calls).toEqual(['copy']);
    });

    it('命令被拒绝(返回 false)时归一化成 false', () => {
        stub.execCommand.result = false;

        expect(runLegacyEditorCommand('insertText', 'SOURCE')).toBe(false);
    });

    it('命令抛错时归一化成 false,不把异常抛给调用方', () => {
        (stub.document as unknown as Record<string, unknown>).execCommand = () => {
            throw new Error('command rejected');
        };

        expect(() => runLegacyEditorCommand('insertText', 'SOURCE')).not.toThrow();
        expect(runLegacyEditorCommand('insertText', 'SOURCE')).toBe(false);
    });

    it('环境没有该命令时返回 false', () => {
        delete (stub.document as unknown as Record<string, unknown>).execCommand;

        expect(runLegacyEditorCommand('insertText', 'SOURCE')).toBe(false);
    });

    it('调用时取命令:加载后再替换 document.execCommand 立即生效', () => {
        // 模块在文件顶部就已加载,这里的桩是加载之后才装上的.
        stub.execCommand.result = true;

        expect(runLegacyEditorCommand('insertText', 'FIRST')).toBe(true);
        expect(stub.execCommand.args).toEqual([['insertText', false, 'FIRST']]);

        // 换一个拒绝所有命令的实现,同一次运行里立刻反映出来.
        (stub.document as unknown as Record<string, unknown>).execCommand = () => false;
        expect(runLegacyEditorCommand('insertText', 'SECOND')).toBe(false);
    });
});
