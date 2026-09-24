/**
 * 应用内容装配的结构契约(D1).
 *
 * `index.html` 缩到一个 `#app` 之后,"哪个节点在这里"的真相源从 HTML 变成
 * `buildAppViews()`.这条接缝过去由 `appHosts.test.ts` 守着(HTML 里的 id 够不够
 * 取齐宿主),现在改成两条更直接的断言:
 * 1. `index.html` 里**只剩** `#app`(D1 的验收线,防止宿主 id 又长回来);
 * 2. 建出来的桩树里,CSS 依赖的结构 id 一个不少,六个窗口都拿得到内容.
 *
 * 用桩而不是真浏览器:这里只验结构,桩不做布局(见 docs/windowing-plan.md §8.1).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mountDesktop } from 'miko_ui';
import { UI_CONFIG, desktopConfig } from '@/config/uiConfig';
import { installDomStub, type StubElement } from '@/testing/domStub';
import { buildAppViews, type AppViews } from './appViews';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

/**
 * 按 `DslApp` 的顺序装一次:先建内容,再 `mountDesktop` 把内容搬进窗口.
 *
 * 只建内容不 mount 的话,窗口正文里的节点都还是游离的 -- 结构断言必须对着
 * "装完之后"的树做.
 */
function build(): { root: StubElement; views: AppViews } {
    const stub = installDomStub();
    const root = stub.document.createElement('div');
    root.id = 'app';
    root.offsetWidth = 1280;
    root.offsetHeight = 800;
    stub.document.body.append(root);

    const views = buildAppViews(root as unknown as HTMLElement);
    mountDesktop(root as unknown as HTMLElement, {
        ...desktopConfig(),
        background: [views.viewport],
        content: views.windowContent,
    });
    return { root, views };
}

/** CSS 里有 `#id` 选择器,或者装配层要拿句柄的结构 id(`css/*.css` 是真相源). */
const REQUIRED_IDS = [
    'editor-panel',
    'view-controls',
    'params-panel',
    'diagnostics',
    'process-panel',
    'object-panel',
    'entity-object-list',
    'evaluation-object-list',
    'analysis-object-list',
    'integral-object-list',
    'intersection-object-list',
    'solve-object-list',
    'antiderivative-object-list',
    'ode-object-list',
] as const;

describe('index.html', () => {
    it('只留 #app 一个手写宿主(D1 的验收线)', () => {
        const markup = html.replace(/<!--[\s\S]*?-->/g, '');

        expect([...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]))
            .toEqual(['app']);
    });
});

describe('buildAppViews', () => {
    it('CSS 与装配层依赖的结构 id 全部建出来', () => {
        const { root } = build();

        for (const id of REQUIRED_IDS) {
            expect(root.querySelector(`#${id}`), `缺少 #${id}`).not.toBeNull();
        }
    });

    it('编辑器外壳由库的 CodeEditor 建(类名结构,应用只包一层面板)', () => {
        const { root, views } = build();

        for (const className of [
            'code-editor',
            'code-editor-gutter',
            'code-editor-lines',
            'code-editor-input',
            'code-editor-textarea',
            'code-editor-highlight',
            'code-editor-highlight-code',
        ]) {
            expect(root.querySelector(`.${className}`), `缺少 .${className}`).not.toBeNull();
        }
        // 应用侧只剩包裹层与它自己拿到的句柄.
        expect(views.editor.classList.contains('code-editor-textarea')).toBe(true);
        expect(views.editor.parentElement).toBe(views.editorHighlight.parentElement);
    });

    it('编辑器三件套挂成 .code-editor-input 下的相邻兄弟', () => {
        const { views } = build();
        const input = views.editor.parentElement as unknown as StubElement;

        expect(input.children[0]).toBe(views.editor as unknown as StubElement);
        expect(input.children[1]).toBe(views.editorHighlight as unknown as StubElement);
    });

    it('六个窗口都拿到正文,未知窗口给空内容', () => {
        const { views } = build();

        for (const spec of UI_CONFIG.window.windows) {
            expect(views.windowContent(spec.id).body?.length, spec.id).toBeGreaterThan(0);
        }
        expect(views.windowContent('nope')).toEqual({ slots: {}, body: [] });
    });

    it('标题栏五个节点按 adopted 表落进各自的窗口', () => {
        const { views } = build();

        expect(Object.keys(views.chrome).sort()).toEqual(
            UI_CONFIG.window.adopted.map((entry) => entry.node).sort(),
        );
        expect(views.windowContent('source').slots?.actions).toEqual([
            views.chrome.exampleButton,
            views.chrome.runButton,
        ]);
        // 两处复制提示:两个对象窗口的正文里都有可复制的公式,所以两处标题栏
        // 各挂一句(两个**不同**的节点,同一个控制器驱动).
        expect(views.windowContent('entities').slots?.title).toEqual([
            views.chrome.formulaCopyHint,
        ]);
        expect(views.windowContent('evaluations').slots?.title).toEqual([
            views.chrome.formulaCopyHintEvaluations,
        ]);
        expect(views.chrome.formulaCopyHint).not.toBe(views.chrome.formulaCopyHintEvaluations);
    });
});
