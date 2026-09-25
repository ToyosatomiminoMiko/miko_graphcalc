/**
 * 应用侧的桌面内容:把 `index.html` 里原来那棵宿主树改成**代码建**(D1).
 *
 * 为什么必须改方向:库如果要求消费者先写二十多个带 id 的宿主再按 id 取,那么
 * "库"和"这个页面"就是同一件事,同页两个实例也直接串味.现在库提供
 * `mountDesktop(root, spec)` 自己建窗口层/Dock/每个窗口的正文容器,应用只负责
 * **内容**:3D 视口,编辑器,参数面板,过程面板,对象列表,以及标题栏上的四个
 * 节点.`index.html` 因此缩到 `<div id="app">`.
 *
 * 节点一律用库的 `create_element()` 建,类名与 id 与旧 HTML **逐字一致**:CSS 还是那一份
 * (`css/*.css`),这一步不动样式(去 id 化是 P4/D8).
 *
 * 建好的节点不只是"塞进去":`DslApp` 还要拿它们的句柄(编辑器,参数面板...)去
 * 装配各控制器,所以这里返回一张**具名引用表**,而不是只返回根节点.
 */
import {
    createCodeEditor,
    create_element,
    windowSlotsProvider,
    type Child,
    type WindowContentSpec,
} from 'miko_ui';
import { UI_CONFIG, type WindowId } from '@/config/uiConfig';
import { highlightDsl } from '@/editor/dslHighlight';
import type { ObjectListContainers } from '@/ui/objects/ObjectListController';
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
    /** 两个对象窗口里的列表容器:`entity` 在实体窗口,其余六个在求值窗口. */
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
    // 源码区也会滚动:textarea 挂库的滚动条类,与其余滚动容器同一种外观.
    // 编辑器外壳本身不认这条规定(结构与滚动条分开),所以由消费者在这里挂.
    code.textarea.classList.add('ui-scrollbar');
    const panel = create_element('section', { id: 'editor-panel', root: doc }, code.element);
    // 旧 `#left-panel` 只有 `.panel` 这一条样式(id 选择器里没有它,见计划附录 C6).
    const body = create_element('aside', { class: 'panel', root: doc }, panel);

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
    const paramsPanel = create_element('section', {
        class: 'ui-scrollbar',
        id: 'params-panel',
        root: doc,
    });
    // 容器的排版用应用自己的类名 `.diagnostic-list`:库的 `MessageList` 只管
    // **条目**的外观(`.diagnostic*`,随库的 `styles/feedback.css` 走),列表摆在哪,
    // 占多高,能不能滚是消费者的容器.写成应用自有的类,应用规则才符合
    // "不给库的类定样式"那条契约(见 src/config/styleLayers.test.ts).
    const diagnostics = create_element('section', {
        class: 'diagnostic-list ui-scrollbar',
        id: 'diagnostics',
        'aria-live': 'polite',
        root: doc,
    });
    const body = create_element('div', { class: 'right-page', root: doc }, paramsPanel, diagnostics);
    return { body, paramsPanel, diagnostics };
}

/** 过程窗口正文:通高的递等式视图. */
function buildProcessWindow(doc: Document): { body: HTMLElement; processPanel: HTMLElement } {
    const processPanel = create_element('section', {
        class: 'process-panel',
        id: 'process-panel',
        root: doc,
    });
    const body = create_element('div', { class: 'right-page', root: doc }, processPanel);
    return { body, processPanel };
}

/** 实体窗口正文:实体对象一栏(原来与求值两栏同处"对象"窗口).
 *
 * 栏标题(`.object-list-title`)删掉了:窗口标题已经是"实体对象",窗口里再来
 * 一行同名的小标题只是把同一句话说两遍 -- 拆成两个窗口之后,标题栏就是新的
 * 分组标识,不需要第二套. */
function buildEntitiesWindow(doc: Document): {
    body: HTMLElement;
    entity: HTMLElement;
} {
    const entity = create_element('div', {
        class: 'object-list-body ui-scrollbar',
        id: 'entity-object-list',
        root: doc,
    });
    const body = create_element('footer', { class: 'panel object-panel-column', root: doc },
        create_element('section', { id: 'object-panel', root: doc },
            create_element('div', { class: 'object-list-column', root: doc }, entity)));
    return { body, entity };
}

/** 求值窗口正文:六个求值子列表(分析 / 积分 / 求交 / 求解 / 原函数 / 微分方程). */
function buildEvaluationsWindow(doc: Document): {
    body: HTMLElement;
    objectLists: Omit<ObjectListContainers, 'entity'>;
} {
    const list = (id: string, className: string): HTMLElement =>
        create_element('div', { class: className, id, root: doc });

    const sublists = {
        analysis: list('analysis-object-list', 'object-sublist'),
        integral: list('integral-object-list', 'object-sublist'),
        intersection: list('intersection-object-list', 'object-sublist'),
        solve: list('solve-object-list', 'object-sublist'),
        antiderivative: list('antiderivative-object-list', 'object-sublist'),
        ode: list('ode-object-list', 'object-sublist'),
    };

    const body = create_element('footer', { class: 'panel object-panel-column', root: doc },
        create_element('section', { id: 'object-panel', root: doc },
            create_element('div', { class: 'object-list-column', root: doc },
                create_element('div', {
                    class: 'object-list-body ui-scrollbar',
                    id: 'evaluation-object-list',
                    root: doc,
                },
                sublists.analysis,
                sublists.integral,
                sublists.intersection,
                sublists.solve,
                sublists.antiderivative,
                sublists.ode))));

    return { body, objectLists: sublists };
}

/** 建好全部应用内容;不碰桌面容器(那是 `mountDesktop()` 的事). */
export function buildAppViews(root: HTMLElement): AppViews {
    const doc = root.ownerDocument;
    const chrome = createWindowChrome();
    const slots = windowSlotsProvider(UI_CONFIG.window.adopted, chrome);

    const viewport = create_element('div', { id: 'viewport', root: doc });
    const source = buildSourceWindow(doc);
    // 视图窗口正文:`ui-scrollbar` 是库的滚动条类(见 css/panels.css 的说明).
    const viewControls = create_element('section', {
        class: 'ui-scrollbar',
        id: 'view-controls',
        root: doc,
    });
    const params = buildParamsWindow(doc);
    const process = buildProcessWindow(doc);
    const entities = buildEntitiesWindow(doc);
    const evaluations = buildEvaluationsWindow(doc);

    const bodies: Readonly<Record<WindowId, readonly Child[]>> = {
        source: [source.body],
        view: [viewControls],
        params: [params.body],
        process: [process.body],
        entities: [entities.body],
        evaluations: [evaluations.body],
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
        objectLists: { entity: entities.entity, ...evaluations.objectLists },
    };
}
