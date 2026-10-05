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

    it('实体 / 求值窗口的正文根自己就是滚动容器(滑条不属于窗口内的卡片)', () => {
        const { root, views } = build();

        // 句柄拿到的就是**正文根**:它直接挂在库的 `.window-body` 下,中间没有宿主层.
        const entity = views.objectLists.entity as unknown as StubElement;
        expect(entity.id).toBe('entity-object-list');
        expect(entity.classList.contains('object-panel')).toBe(true);
        expect(entity.classList.contains('ui-scrollbar')).toBe(true);
        expect((entity.parentElement as unknown as StubElement).classList.contains('window-body'))
            .toBe(true);

        // 求值窗口同一形状:正文根 = 六个子列表的容器 + 滚动区.
        const evaluation = root.querySelector('#evaluation-object-list') as unknown as StubElement;
        expect(evaluation.classList.contains('object-panel')).toBe(true);
        expect(evaluation.classList.contains('ui-scrollbar')).toBe(true);
        expect((evaluation.parentElement as unknown as StubElement).classList.contains('window-body'))
            .toBe(true);

        // 窗口内的卡片(库的 `.message-area`)与旧的包裹层都只属于诊断窗口 /
        // 已删除:两个列表窗口再套一层"有描边和底色的框体",滑条就又回到
        // 窗口内的元素里了(见 css/panels.css).
        for (const id of ['entity-object-list', 'evaluation-object-list']) {
            const body = root.querySelector(`#${id}`) as unknown as StubElement;
            expect(body.classList.contains('message-area'), id).toBe(false);
        }
        for (const dead of ['.object-list-body', '.object-list-column', '.object-panel-column']) {
            expect(root.querySelector(dead), dead).toBeNull();
        }
        expect(root.querySelector('#object-panel')).toBeNull();
    });

    it('源码窗口的正文根是 #editor-panel 自己(滚动归它,编辑器外壳不套第二层)', () => {
        const { root, views } = build();
        const body = views.windowContent('source').body?.[0] as unknown as StubElement;

        expect(body.id).toBe('editor-panel');
        expect(body.classList.contains('ui-scrollbar')).toBe(true);
        expect(body.classList.contains('panel')).toBe(false);
        // 编辑器外壳仍是正文根里唯一的孩子,它的结构一行不动.
        expect(body.children[0]).toBe(root.querySelector('.code-editor'));
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

    it('诊断窗口的消息区容器**就是**正文根(无框变体,aria-live 在库侧)', () => {
        const { root, views } = build();
        const area = views.diagnostics.element as unknown as StubElement;

        // 与实体 / 求值 / 源码窗口同形:正文根自己滚,窗口里不再套第二层盒子.
        expect(area.id).toBe('diagnostics-panel');
        expect(area.className).toBe('message-area message-area--unframed ui-scrollbar');
        expect((area.parentElement as unknown as StubElement).classList.contains('window-body'))
            .toBe(true);
        // `aria-live` 是"容器里一有变动就被播报"的那条行为,必须由库件给出:
        // 它漏了,库的"内容一致时零 DOM 操作"就白做(读屏每帧重放).
        expect(area.getAttribute('aria-live')).toBe('polite');
        // 句柄里的节点就是树上那一颗,不是建完没插进去的孤儿.
        expect(root.querySelector('#diagnostics-panel')).toBe(area);
        // 应用自建的诊断容器类与那层宿主 div 都别在这里长回来.
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
