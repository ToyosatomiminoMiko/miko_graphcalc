/**
 * 应用侧的桌面内容:把 `index.html` 里原来那棵宿主树改成**代码建**(D1).
 *
 * 为什么必须改方向:库如果要求消费者先写二十多个带 id 的宿主再按 id 取,那么
 * "库"和"这个页面"就是同一件事,同页两个实例也直接串味.现在库提供
 * `mountDesktop(root, spec)` 自己建窗口层/Dock/每个窗口的正文容器,应用只负责
 * **内容**:3D 视口,编辑器,参数面板,过程面板,对象列表,以及标题栏上的四个
 * 节点.`index.html` 因此缩到 `<div id="app">`.
 *
 * 节点一律用库的 `el()` 建,类名与 id 与旧 HTML **逐字一致**:CSS 还是那一份
 * (`css/*.css`),这一步不动样式(去 id 化是 P4/D8).
 *
 * 建好的节点不只是"塞进去":`DslApp` 还要拿它们的句柄(编辑器,参数面板...)去
 * 装配各控制器,所以这里返回一张**具名引用表**,而不是只返回根节点.
 */
import {
    createCodeEditor,
    el,
    windowSlotsProvider,
    type Child,
    type WindowContentSpec,
} from '@miko/ui';
import { UI_CONFIG, type WindowId } from '@/config/uiConfig';
import { highlightDsl } from '@/editor/dslHighlight';
import type { ObjectListContainers } from '@/views/objects/ObjectListController';
import { createWindowChrome, type WindowChrome } from './windowChrome';

/** 应用内容节点与逐窗口内容表:装配层与 `mountDesktop()` 的全部输入. */
export interface AppViews {
    /** 应用根节点(`#app`);浮层"点外部关闭"与键盘代理挂在它上面. */
    readonly root: HTMLElement;
    /** 3D 视口(桌面背景,位于所有窗口之下). */
    readonly viewport: HTMLElement;
    /** 标题栏上的四个应用节点. */
    readonly chrome: WindowChrome;
    /** 窗口内容提供者:标题栏槽位 + 正文节点;未知窗口返回空内容. */
    readonly windowContent: (id: string) => WindowContentSpec;
    /** 源码编辑器:`textarea` 本体 + 行号槽 + 高亮层. */
    readonly editor: HTMLTextAreaElement;
    readonly editorGutter: HTMLElement;
    readonly editorLines: HTMLElement;
    readonly editorHighlight: HTMLElement;
    readonly editorHighlightCode: HTMLElement;
    /** 视图窗口的正文(视图控件容器). */
    readonly viewControls: HTMLElement;
    /** 参数窗口里的两块内容. */
    readonly paramsPanel: HTMLElement;
    readonly diagnostics: HTMLElement;
    /** 过程窗口的正文容器. */
    readonly processPanel: HTMLElement;
    /** 对象窗口里的七个子列表容器. */
    readonly objectLists: ObjectListContainers;
}

/**
 * 源码窗口正文:面板包裹层(应用) + 编辑器外壳(库的 `CodeEditor`).
 *
 * 编辑器那套结构(`.code-editor*`)已经随库走(P4):库知道"高亮层必须紧跟
 * textarea"这类结构约束,应用只给两样东西 -- 初值无关的分词器与本应用的
 * 槽宽下限(D6).这里保留的 `#editor-panel` 是**应用的**包裹层(给编辑器留
 * padding 并让它吃掉窗口正文的剩余高度).
 */
function buildSourceWindow(doc: Document): {
    body: HTMLElement;
    editor: HTMLTextAreaElement;
    gutter: HTMLElement;
    lines: HTMLElement;
    highlight: HTMLElement;
    highlightCode: HTMLElement;
} {
    const code = createCodeEditor({
        highlight: highlightDsl,
        gutterMinWidth: UI_CONFIG.editor.gutterMinWidth,
        root: doc,
    });
    const panel = el('section', { attrs: { id: 'editor-panel' }, root: doc }, code.element);
    // 旧 `#left-panel` 只有 `.panel` 这一条样式(id 选择器里没有它,见计划附录 C6).
    const body = el('aside', { class: 'panel', root: doc }, panel);

    return {
        body,
        editor: code.textarea,
        gutter: code.gutter,
        lines: code.lines,
        highlight: code.highlightScroller,
        highlightCode: code.highlightCode,
    };
}

/** 参数窗口正文:参数列表 + 诊断区(诊断不是视图控件,留在同一个窗口). */
function buildParamsWindow(doc: Document): {
    body: HTMLElement;
    paramsPanel: HTMLElement;
    diagnostics: HTMLElement;
} {
    const paramsPanel = el('section', { attrs: { id: 'params-panel' }, root: doc });
    const diagnostics = el('section', {
        attrs: { id: 'diagnostics', 'aria-live': 'polite' },
        root: doc,
    });
    const body = el('div', { class: 'right-page', root: doc }, paramsPanel, diagnostics);
    return { body, paramsPanel, diagnostics };
}

/** 过程窗口正文:通高的递等式视图. */
function buildProcessWindow(doc: Document): { body: HTMLElement; processPanel: HTMLElement } {
    const processPanel = el('section', {
        class: 'process-panel',
        attrs: { id: 'process-panel' },
        root: doc,
    });
    const body = el('div', { class: 'right-page', root: doc }, processPanel);
    return { body, processPanel };
}

/** 对象窗口正文:实体 / 求值两栏,求值栏下再挂六个子列表. */
function buildObjectsWindow(doc: Document): {
    body: HTMLElement;
    objectLists: ObjectListContainers;
} {
    const list = (id: string, className: string): HTMLElement =>
        el('div', { class: className, attrs: { id }, root: doc });

    const objectLists: ObjectListContainers = {
        entity: list('entity-object-list', 'object-list-body'),
        analysis: list('analysis-object-list', 'object-sublist'),
        integral: list('integral-object-list', 'object-sublist'),
        intersection: list('intersection-object-list', 'object-sublist'),
        solve: list('solve-object-list', 'object-sublist'),
        antiderivative: list('antiderivative-object-list', 'object-sublist'),
        ode: list('ode-object-list', 'object-sublist'),
    };
    const evaluation = el('div', {
        class: 'object-list-body',
        attrs: { id: 'evaluation-object-list' },
        root: doc,
    },
    objectLists.analysis,
    objectLists.integral,
    objectLists.intersection,
    objectLists.solve,
    objectLists.antiderivative,
    objectLists.ode);

    const body = el('footer', { class: 'panel', root: doc },
        el('section', { attrs: { id: 'object-panel' }, root: doc },
            el('div', { class: 'object-list-column', root: doc },
                el('header', { class: 'object-list-title', root: doc },
                    el('span', { text: '实体对象', root: doc })),
                objectLists.entity),
            el('div', { class: 'object-list-column', root: doc },
                el('header', { class: 'object-list-title', text: '求值对象', root: doc }),
                evaluation)));
    return { body, objectLists };
}

/** 建好全部应用内容;不碰桌面容器(那是 `mountDesktop()` 的事). */
export function buildAppViews(root: HTMLElement): AppViews {
    const doc = root.ownerDocument;
    const chrome = createWindowChrome();
    const slots = windowSlotsProvider(UI_CONFIG.window.adopted, chrome);

    const viewport = el('div', { attrs: { id: 'viewport' }, root: doc });
    const source = buildSourceWindow(doc);
    const viewControls = el('section', { attrs: { id: 'view-controls' }, root: doc });
    const params = buildParamsWindow(doc);
    const process = buildProcessWindow(doc);
    const objects = buildObjectsWindow(doc);

    const bodies: Readonly<Record<WindowId, readonly Child[]>> = {
        source: [source.body],
        view: [viewControls],
        params: [params.body],
        process: [process.body],
        objects: [objects.body],
    };

    /** 窗口 id 守卫:库传进来的是不透明字符串,未知 id 给空内容而不是 undefined. */
    const isWindowId = (id: string): id is WindowId => id in bodies;

    return {
        root,
        viewport,
        chrome,
        windowContent: (id) => ({ slots: slots(id), body: isWindowId(id) ? bodies[id] : [] }),
        editor: source.editor,
        editorGutter: source.gutter,
        editorLines: source.lines,
        editorHighlight: source.highlight,
        editorHighlightCode: source.highlightCode,
        viewControls,
        paramsPanel: params.paramsPanel,
        diagnostics: params.diagnostics,
        processPanel: process.processPanel,
        objectLists: objects.objectLists,
    };
}
