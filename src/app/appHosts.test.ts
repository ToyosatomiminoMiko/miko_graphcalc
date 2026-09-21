/**
 * `readAppHosts()` 与 `index.html` 的**不漂移**守卫(不需要浏览器).
 *
 * 这是"字符串 -> 节点"那条接缝的两半之一:`ui/desktop/desktopHosts.test.ts` 守
 * "配置里的 hostId 在 HTML 里",这里守"`readAppHosts()` 需要的每个 id 都在 HTML
 * 里,而且缺一个就报出那个 id".两边合起来,HTML 改名/删节点/新增必需宿主都会在
 * 测试里失败,而不是留到运行期变成 `Cannot read properties of null`.
 *
 * 反向(HTML 里有,`readAppHosts()` 不读的 id)不在这里拦:那是结构分层的容器
 * (`#dsl-editor-input`,`#object-panel` 这类),由各自的样式与结构测试管.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UI_CONFIG } from '@/config/uiConfig';
import { installDomStub } from '@/testing/domStub';
import { readAppHosts } from './appHosts';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

/** HTML 里出现的全部 id(注释里提到的 id 不算). */
function idsInHtml(): string[] {
    const markup = html.replace(/<!--[\s\S]*?-->/g, '');
    return [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
}

/**
 * 照 HTML 的 id 列表装一棵等价的桩树,返回 `readAppHosts()` 要的 document.
 *
 * `readAppHosts()` 只按 id 取节点,不看标签与层级,所以这棵桩足以验证"HTML 提供
 * 的 id 集合够不够";真实标签(button/section/textarea)由 `index.html` 自己保证.
 * 每次调用都装一份新的桩,`omit` 才不会被上一次的树补回来.
 */
function stubFromHtml(omit?: string): Document {
    const stub = installDomStub();
    const root = stub.document.createElement('div');
    stub.document.body.append(root);
    for (const id of idsInHtml()) {
        if (id === omit) continue;
        const node = stub.document.createElement('div');
        node.id = id;
        root.append(node);
    }
    return stub.document as unknown as Document;
}

describe('readAppHosts 与 index.html', () => {
    it('HTML 提供的 id 足以取齐全部宿主', () => {
        expect(() => readAppHosts(stubFromHtml())).not.toThrow();
    });

    it('五个正文宿主按 UI_CONFIG 的 hostId 取,视图面板用 view 窗口的宿主', () => {
        const hosts = readAppHosts(stubFromHtml());

        expect([...hosts.windowBodies.keys()]).toEqual(
            UI_CONFIG.window.windows.map((spec) => spec.id),
        );
        expect(hosts.viewControls).toBe(hosts.windowBodies.get('view'));
    });

    it('缺一个宿主就报出它的 id,而不是把 null 传给下游', () => {
        expect(() => readAppHosts(stubFromHtml('diagnostics'))).toThrow(/#diagnostics/);
        // 窗口正文宿主缺失走同一条错误路径.
        expect(() => readAppHosts(stubFromHtml('left-panel'))).toThrow(/#left-panel/);
    });

    it('index.html 里不出现标题栏应用节点(它们由 windowChrome 建)', () => {
        const ids = idsInHtml();
        for (const id of ['example-btn', 'run-btn', 'example-menu', 'formula-copy-hint']) {
            expect(ids, `#${id} 不该再出现在 index.html`).not.toContain(id);
        }
    });
});
