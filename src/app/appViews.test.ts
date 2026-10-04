/**
 * 应用内容装配的结构契约(D1).
 *
 * `index.html` 缩到一个 `#app` 之后,"哪个节点在这里"的真相源从 HTML 变成
 * `buildAppViews()`.这条接缝过去由 `appHosts.test.ts` 守着(HTML 里的 id 够不够
 * 取齐宿主),现在改成两条更直接的断言:
 * 1. `index.html` 里**只剩** `#app`(D1 的验收线,防止宿主 id 又长回来);
 * 2. 建出来的桩树里,CSS 依赖的结构 id 一个不少,七个窗口都拿得到内容.
 *
 * 用桩而不是真浏览器:这里只验结构,桩不做布局(见 docs/windowing-plan.md §8.1).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mountDesktop } from 'miko_ui';
import { UI_CONFIG, desktopConfig } from '@/config/uiConfig';
import { installDomStub, type StubElement } from 'miko_ui/testing';
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
    'diagnostics-panel',
    'process-panel',
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

    it('三个列表窗口的框体是库的同一份,正文里不再有应用自建的盒子', () => {
        const { root, views } = build();

        // 句柄拿到的就是框体本身:它直接挂在宿主 `.object-panel` 下,中间没有包裹层.
        expect(views.objectLists.entity.classList.contains('message-area')).toBe(true);
        expect((views.objectLists.entity.parentElement as unknown as StubElement).className)
            .toBe('panel object-panel');
        // 诊断窗口的框体是同一份类:三张表同形,差别只在里面装什么.
        expect(views.diagnostics.element.classList.contains('message-area')).toBe(true);
        // 两个框体都还挂着应用决定的滚动条规定(滚动条外观在库的 scrollbar.css).
        for (const id of ['entity-object-list', 'evaluation-object-list']) {
            const box = root.querySelector(`#${id}`) as unknown as StubElement;
            expect(box.classList.contains('message-area'), id).toBe(true);
            expect(box.classList.contains('ui-scrollbar'), id).toBe(true);
        }
        // 应用自建的框体与那两层包裹 div 不许长回来:框体只有库那一份,
        // 宿主只有一层(见 css/panels.css).
        for (const dead of ['.object-list-body', '.object-list-column', '.object-panel-column']) {
            expect(root.querySelector(dead), dead).toBeNull();
        }
        expect(root.querySelector('#object-panel')).toBeNull();
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

    it('七个窗口都拿到正文,未知窗口给空内容', () => {
        const { views } = build();

        for (const spec of UI_CONFIG.window.windows) {
            expect(views.windowContent(spec.id).body?.length, spec.id).toBeGreaterThan(0);
        }
        expect(views.windowContent('nope')).toEqual({ slots: {}, body: [] });
    });

    it('七个窗口的正文都是 div(窗口平等,不分 header/footer/aside/section)', () => {
        const { views } = build();

        for (const spec of UI_CONFIG.window.windows) {
            const [body] = views.windowContent(spec.id).body ?? [];
            // 正文根一律 `div`:有一个窗口是 `footer`/`aside`/`section`,DOM 就先
            // 替窗口排了座次 -- 语义由库的 `.window`(`role="region"`)给一次.
            // 桩的 `tagName` 是小写(与 ViewPanel.test.ts 同一口径).
            expect((body as unknown as StubElement | undefined)?.tagName, spec.id).toBe('div');
        }
    });

    it('诊断窗口的容器由库的 MessageArea 建(aria-live 在库侧,应用不再有容器类)', () => {
        const { root, views } = build();
        const area = views.diagnostics.element as unknown as StubElement;

        expect(area.className).toBe('message-area ui-scrollbar');
        // `aria-live` 是"容器里一有变动就被播报"的那条行为,必须由库件给出:
        // 它漏了,库的"内容一致时零 DOM 操作"就白做(读屏每帧重放).
        expect(area.getAttribute('aria-live')).toBe('polite');
        // 句柄里的节点就是树上那一颗,不是建完没插进去的孤儿.三个列表窗口现在都挂
        // `.message-area`,`querySelector` 只会命中第一个,所以按宿主认这一颗.
        expect(area.closest('#diagnostics-panel')).not.toBeNull();
        // 应用自建的诊断列表容器类随库走了,别在这里长回来.
        expect(root.querySelector('.diagnostic-list')).toBeNull();
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
