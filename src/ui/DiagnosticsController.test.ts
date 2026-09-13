/**
 * 诊断提示控制器单测(UI-P3.7).
 *
 * 诊断区在 HTML 里是 `aria-live="polite"`,所以"内容没变"必须意味着
 * **零 DOM 操作**;变了才替换,并尽量复用同键节点.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomStub, type StubElement } from '../test/domStub';
import { DiagnosticsController } from './DiagnosticsController';

function setup(): { controller: DiagnosticsController; container: StubElement } {
    const stub = installDomStub();
    const container = stub.document.createElement('section');
    stub.document.body.append(container);
    return {
        controller: new DiagnosticsController(container as unknown as HTMLElement),
        container,
    };
}

beforeEach(() => {
    installDomStub();
});

describe('render 的增量语义(UI-P3.7)', () => {
    it('内容与顺序一致时不做任何 DOM 操作', () => {
        const { controller, container } = setup();
        const entries = [
            { level: 'warning' as const, message: '降采样' },
            { level: 'error' as const, message: '解析失败' },
        ];
        controller.render(entries);

        const replaceChildren = vi.fn(container.replaceChildren.bind(container));
        container.replaceChildren = replaceChildren;

        controller.render(entries);

        expect(replaceChildren).not.toHaveBeenCalled();
        expect(container.children).toHaveLength(2);
    });

    it('内容变化时替换,并复用同键节点', () => {
        const { controller, container } = setup();
        controller.render([
            { level: 'warning', message: 'a' },
            { level: 'error', message: 'b' },
        ]);
        const [first, second] = container.children as StubElement[];

        controller.render([
            { level: 'error', message: 'b' },
            { level: 'warning', message: 'a' },
        ]);

        expect(container.children).toHaveLength(2);
        expect(container.children[0]).toBe(second);
        expect(container.children[1]).toBe(first);
    });

    it('条目减少时删除多余节点,保留的节点身份不变', () => {
        const { controller, container } = setup();
        controller.render([
            { level: 'warning', message: 'a' },
            { level: 'error', message: 'b' },
        ]);
        const [first] = container.children as StubElement[];

        controller.render([{ level: 'warning', message: 'a' }]);

        expect(container.children).toHaveLength(1);
        expect(container.children[0]).toBe(first);
    });

    it('同键重复条目各自保留一个节点', () => {
        const { controller, container } = setup();
        controller.render([
            { level: 'warning', message: 'a' },
            { level: 'warning', message: 'a' },
        ]);

        expect(container.children).toHaveLength(2);
    });
});

describe('一次性提示路径', () => {
    it('add/clear 仍可用于编译期错误', () => {
        const { controller, container } = setup();

        controller.add('error', '编译失败');
        controller.add('warning', '资源降采样');

        expect(container.children).toHaveLength(2);
        expect((container.children[0] as StubElement).className).toBe(
            'diagnostic diagnostic-error',
        );
        expect((container.children[0] as StubElement).textContent).toBe(
            '[error] 编译失败',
        );

        controller.clear();
        expect(container.children).toHaveLength(0);
    });

    it('clear 之后再 render 不会带出旧条目', () => {
        const { controller, container } = setup();
        controller.add('error', '旧错误');
        controller.clear();

        controller.render([{ level: 'warning', message: '新警告' }]);

        expect(container.children).toHaveLength(1);
        expect((container.children[0] as StubElement).textContent).toBe(
            '[warning] 新警告',
        );
    });
});
