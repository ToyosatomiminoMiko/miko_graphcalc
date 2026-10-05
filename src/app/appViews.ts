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
 * **窗口正文一律 `div`**:七个窗口是彼此的**平等**存在,谁也不是谁的
 * `header` / `footer` / `aside` / `section`.正文容器若按语义标签分档,DOM 就先替
 * 窗口排了座次("底栏""次要栏"),结构查询与读屏也会把这层不存在的关系读进去.
 * 窗口的语义只由库的 `.window` 给一次(`role="region"` + `aria-labelledby`),
 * 正文只是几何宿主,所以 `aside` / `section` / `footer` 全部收成 `div`;
 * `id` / `class` 逐字不动,CSS 与测试的选择器都不受影响.
 *
 * 建好的节点不只是"塞进去":`DslApp` 还要拿它们的句柄(编辑器,参数面板...)去
 * 装配各控制器,所以这里返回一张**具名引用表**,而不是只返回根节点.
 */
import {
    createCodeEditor,
    createMessageArea,
    create_element,
    windowSlotsProvider,
    type Child,
    type MessageAreaHandle,
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
    /** 源码窗口的正文根:编辑器所在的那一层,**滚动归它**(`#editor-panel`). */
    readonly sourcePanel: HTMLElement;
    /** 源码编辑器:`textarea` 本体 + 行号槽 + 高亮层. */
    readonly editor: HTMLTextAreaElement;
    readonly editorGutter: HTMLElement;
    readonly editorLines: HTMLElement;
    readonly editorHighlight: HTMLElement;
    readonly editorHighlightCode: HTMLElement;
    /** 视图窗口的正文(视图控件容器). */
    readonly viewControls: HTMLElement;
    /** 参数窗口的正文(参数列表容器). */
    readonly paramsPanel: HTMLElement;
    /** 诊断窗口的正文:库建的消息区容器 + 它的条目接口(`MessageList`). */
    readonly diagnostics: MessageAreaHandle;
    /** 过程窗口的正文容器. */
    readonly processPanel: HTMLElement;
    /** 两个对象窗口里的列表容器:`entity` 在实体窗口,其余六个在求值窗口. */
    readonly objectLists: ObjectListContainers;
}

/**
 * 源码窗口正文:正文根就是滚动容器(应用) + 编辑器外壳(库的 `CodeEditor`).
 *
 * 编辑器那套结构(`.code-editor*`)已经随库走(P4):库知道"高亮层必须与 textarea
 * 同格"这类结构约束,应用只给两样东西 -- 初值无关的分词器与本应用的槽宽下限(D6).
 *
 * **滚动归窗口正文根**:`#editor-panel` 自己 `overflow: auto` 并挂库的
 * `.ui-scrollbar`,库的 `.code-editor` 随内容长高长宽(见库 `styles/editor.css`
 * 的"滚动归属"),所以滑条只有窗口这一条 -- 与参数 / 视图 / 实体 / 求值窗口同形.
 * 应用侧因此不再有"给编辑器留 padding 并让它吃掉剩余高度"的包裹层:只剩这一层.
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
    // 源码区由窗口正文根滚:滚动条类挂在它上面,与其余滚动容器同一种外观.
    // 编辑器外壳本身不认这条规定(结构与滚动条分开),所以由消费者在这里挂.
    const body = create_element({ tag: 'div', root: doc }, {
        class: 'ui-scrollbar',
        id: 'editor-panel'
    }, code.element);

    return {
        body,
        editor: code.textarea,
        gutter: code.gutter,
        lines: code.lines,
        highlight: code.highlightScroller,
        highlightCode: code.highlightCode,
    };
}

/** 参数窗口正文:只有参数列表(诊断已经独立成窗,见 `buildDiagnosticsWindow`). */
function buildParamsWindow(doc: Document): {
    body: HTMLElement;
    paramsPanel: HTMLElement;
} {
    const paramsPanel = create_element({ tag: 'div', root: doc }, {
        class: 'ui-scrollbar',
        id: 'params-panel'
    });
    const body = create_element({ tag: 'div', root: doc }, { class: 'right-page' }, paramsPanel);
    return { body, paramsPanel };
}

/**
 * 诊断窗口正文:库的消息区容器**就是**窗口正文根(没有第二层宿主).
 *
 * 容器(列表节奏 / 滚动 / `aria-live`)由库的 `createMessageArea()` 建:过去容器
 * 归应用,条目归库,同一个提示区有两处维护,而容器上那条 `aria-live` 漏了就直接
 * 废掉库的"内容一致时零 DOM 操作"(读屏每帧重放).
 *
 * 这里只剩三件**应用**的事:
 * - `#diagnostics-panel` 就是那颗容器(应用给它 id,不另建宿主):与实体 / 求值 /
 *   源码窗口同形 -- **滑条属于窗口正文根**,窗口外壳那圈描边就是它的框;
 * - `modifier: 'message-area--unframed'` 让库不给框体(理由见上面那条):再套一层
 *   "有描边的卡片"就是两层边框 + 一圈白给的内边距,和实体 / 求值窗口当初删掉的
 *   是同一个东西.写的是**变体类名**,与 `ViewPanel` 的
 *   `modifier: 'segmented--inline'` 同一条约定(见库 `widgets/Segmented.ts`);
 * - `ui-scrollbar` 由消费者挂:滚动条是库的一条**独立规定**,组件与它互不认识
 *   (见库的 `styles/scrollbar.css`),要不要用由这里决定.
 *
 * 滚动仍由库的 `.message-area` 给(`overflow-y` 那一条):容器是正文根,所以那条
 * 滑条落在窗口边上,正是"窗口自己的滑条".
 *
 * 字体与字号不给库的类写规则:`#diagnostics-panel` 上的排版由容器里的文本继承
 * (--code-font-family 与字号都写在 `css/panels.css` 的应用规则里).
 */
function buildDiagnosticsWindow(doc: Document): {
    body: HTMLElement;
    diagnostics: MessageAreaHandle;
} {
    const messageArea = createMessageArea({
        root: doc,
        modifier: 'message-area--unframed',
        class: 'ui-scrollbar',
    });
    messageArea.element.id = 'diagnostics-panel';
    return { body: messageArea.element, diagnostics: messageArea };
}

/** 过程窗口正文:通高的递等式视图. */
function buildProcessWindow(doc: Document): { body: HTMLElement; processPanel: HTMLElement } {
    const processPanel = create_element({ tag: 'div', root: doc }, {
        class: 'process-panel',
        id: 'process-panel'
    });
    const body = create_element({ tag: 'div', root: doc }, { class: 'right-page' }, processPanel);
    return { body, processPanel };
}

/** 实体窗口正文:实体对象一栏.窗口正文根**就是**那个滚动容器(原来与求值两栏同处
 * "对象"窗口).
 *
 * 栏标题(`.object-list-title`)删掉了:窗口标题已经是"实体对象",窗口里再来
 * 一行同名的小标题只是把同一句话说两遍 -- 拆成两个窗口之后,标题栏就是新的
 * 分组标识,不需要第二套.
 *
 * 正文只有一层:`.object-panel` 既是宿主也是滚动区(`display:flex` + `overflow-y`,
 * 见 `css/panels.css`),与 `#params-panel` / `#view-controls` 同形 -- 滑条贴窗口边,
 * 不再缩在一个卡片里.行引擎归库的 `RowList`(构造时给容器挂 `role="list"`). */
function buildEntitiesWindow(doc: Document): {
    body: HTMLElement;
    entity: HTMLElement;
} {
    const entity = create_element({ tag: 'div', root: doc }, {
        class: 'object-panel ui-scrollbar',
        id: 'entity-object-list'
    });
    return { body: entity, entity };
}

/** 求值窗口正文:六个求值子列表(分析 / 积分 / 求交 / 求解 / 原函数 / 微分方程).
 *
 * 与实体窗口同形:正文根就是滚动容器,六个 kind 各占一个 `.object-sublist`
 * (应用类,空的时候由 CSS 收起),它们是各自的 `RowList` 容器. */
function buildEvaluationsWindow(doc: Document): {
    body: HTMLElement;
    objectLists: Omit<ObjectListContainers, 'entity'>;
} {
    const list = (id: string, className: string): HTMLElement =>
        create_element({ tag: 'div', root: doc }, { class: className, id });

    const sublists = {
        analysis: list('analysis-object-list', 'object-sublist'),
        integral: list('integral-object-list', 'object-sublist'),
        intersection: list('intersection-object-list', 'object-sublist'),
        solve: list('solve-object-list', 'object-sublist'),
        antiderivative: list('antiderivative-object-list', 'object-sublist'),
        ode: list('ode-object-list', 'object-sublist'),
    };

    const body = create_element({ tag: 'div', root: doc }, {
        class: 'object-panel ui-scrollbar',
        id: 'evaluation-object-list'
    },
        sublists.analysis,
        sublists.integral,
        sublists.intersection,
        sublists.solve,
        sublists.antiderivative,
        sublists.ode);

    return { body, objectLists: sublists };
}

/** 建好全部应用内容;不碰桌面容器(那是 `mountDesktop()` 的事). */
export function buildAppViews(root: HTMLElement): AppViews {
    const doc = root.ownerDocument;
    const chrome = createWindowChrome();
    const slots = windowSlotsProvider(UI_CONFIG.window.adopted, chrome);

    const viewport = create_element({ tag: 'div', root: doc }, { id: 'viewport' });
    const source = buildSourceWindow(doc);
    // 视图窗口正文:`ui-scrollbar` 是库的滚动条类(见 css/panels.css 的说明).
    const viewControls = create_element({ tag: 'div', root: doc }, {
        class: 'ui-scrollbar',
        id: 'view-controls'
    });
    const params = buildParamsWindow(doc);
    const diagnosticsWindow = buildDiagnosticsWindow(doc);
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
        diagnostics: [diagnosticsWindow.body],
    };

    /** 窗口 id 守卫:库传进来的是不透明字符串,未知 id 给空内容而不是 undefined. */
    const isWindowId = (id: string): id is WindowId => id in bodies;

    return {
        root,
        viewport,
        chrome,
        windowContent: (id) => ({ slots: slots(id), body: isWindowId(id) ? bodies[id] : [] }),
        sourcePanel: source.body,
        editor: source.editor,
        editorGutter: source.gutter,
        editorLines: source.lines,
        editorHighlight: source.highlight,
        editorHighlightCode: source.highlightCode,
        viewControls,
        paramsPanel: params.paramsPanel,
        diagnostics: diagnosticsWindow.diagnostics,
        processPanel: process.processPanel,
        objectLists: { entity: entities.entity, ...evaluations.objectLists },
    };
}
