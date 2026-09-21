/**
 * `index.html` 的宿主节点:全应用**唯一**按 id 取节点的地方.
 *
 * 为什么集中成一个函数:装配层过去散着二十多次 `document.getElementById`,
 * 每一次都要在"id 写错"与"HTML 里改过名"之间手动对齐,而 `!` 把这些错误推迟到
 * 运行期,报出来的是下游的 `Cannot read properties of null`(见
 * `ui/widgets/dom.ts` 与 `ui/view/ViewPanel.ts` 对旧做法的记录).收在这里之后:
 *
 * - 字符串 -> 节点 的绑定只有一个文件,一次执行,缺任何一个宿主都在这里报出
 *   带 id 的错误消息;
 * - `DslApp` 与 `WindowManager` 都不再碰 `document`(窗口正文宿主也在这里按
 *   `UI_CONFIG.window.windows[].hostId` 取好传进去);
 * - 守这条契约的测试只有一处:`ui/desktop/desktopHosts.test.ts` 管配置与 HTML
 *   一致,`app/appHosts.test.ts` 管 HTML 里的 id 都被认领.
 *
 * 标题栏上的四个节点**不在这里**:它们由 `ui/desktop/windowChrome.ts` 用 `el()`
 * 建,不走 id 查找.
 */
import { UI_CONFIG, type WindowId } from '@/config/uiConfig';
import type { ObjectListContainers } from '@/ui/objects/ObjectListController';

/** `index.html` 提供的全部节点(按用途成组). */
export interface AppHosts {
    /** 应用根节点:`Popover` / `FormulaCopyController` 的"点外部关闭"挂在这里. */
    readonly app: HTMLElement;
    /** 3D 视口. */
    readonly viewport: HTMLElement;
    /** 窗口层与它的两个伴生容器(Dock,吸附高亮). */
    readonly windowLayer: HTMLElement;
    readonly dock: HTMLElement;
    readonly snapPreview: HTMLElement;
    /** 五个窗口的正文宿主,按窗口 id 取;key 来自配置里的 `hostId`. */
    readonly windowBodies: ReadonlyMap<WindowId, HTMLElement>;
    /** 视图窗口的正文宿主(`view` 窗口的宿主;`createViewPanel` 的容器). */
    readonly viewControls: HTMLElement;
    /** 参数窗口里的两块内容. */
    readonly paramsPanel: HTMLElement;
    readonly diagnostics: HTMLElement;
    /** 过程窗口的正文宿主. */
    readonly processPanel: HTMLElement;
    /** 源码编辑器:`textarea` 本体 + 行号槽 + 高亮层. */
    readonly editor: HTMLTextAreaElement;
    readonly editorGutter: HTMLElement;
    readonly editorLines: HTMLElement;
    readonly editorHighlight: HTMLElement;
    readonly editorHighlightCode: HTMLElement;
    /** 对象窗口里的七个子列表容器. */
    readonly objectLists: ObjectListContainers;
}

/** 按 id 取一个必需节点;缺了就报出 id,而不是把 `null` 传给下游. */
function require<T extends HTMLElement>(doc: Document, id: string): T {
    const element = doc.getElementById(id);
    if (!element) {
        throw new Error(
            `readAppHosts: index.html 里缺少 #${id}(宿主改名/删除后应当在这里失败,`
            + '而不是在运行期抛 Cannot read properties of null)',
        );
    }
    return element as T;
}

/**
 * 五个窗口的正文宿主:key 与 `UI_CONFIG.window.windows[].hostId` 一一对应.
 *
 * `WindowManager` 收这张表而不是自己去 `document` 里查,所以"哪个窗口装哪个
 * 宿主"只有配置一处声明,配置与 HTML 不一致由 `desktopHosts.test.ts` 拦下.
 */
function readWindowBodies(doc: Document): Map<WindowId, HTMLElement> {
    const bodies = new Map<WindowId, HTMLElement>();
    for (const spec of UI_CONFIG.window.windows) {
        bodies.set(spec.id, require(doc, spec.hostId));
    }
    return bodies;
}

/** 读一次全部宿主;装配期调用(`main.ts` 在 `new DslApp()` 之前). */
export function readAppHosts(doc: Document = document): AppHosts {
    const windowBodies = readWindowBodies(doc);
    return {
        app: require(doc, 'app'),
        viewport: require(doc, 'viewport'),
        windowLayer: require(doc, 'window-layer'),
        dock: require(doc, 'dock'),
        snapPreview: require(doc, 'snap-preview'),
        windowBodies,
        // `readWindowBodies()` 保证五个宿主齐全,所以这里取得到.
        viewControls: windowBodies.get('view')!,
        paramsPanel: require(doc, 'params-panel'),
        diagnostics: require(doc, 'diagnostics'),
        processPanel: require(doc, 'process-panel'),
        editor: require<HTMLTextAreaElement>(doc, 'dsl-editor'),
        editorGutter: require(doc, 'dsl-editor-gutter'),
        editorLines: require(doc, 'dsl-editor-lines'),
        editorHighlight: require(doc, 'dsl-editor-highlight'),
        editorHighlightCode: require(doc, 'dsl-editor-highlight-code'),
        objectLists: {
            entity: require(doc, 'entity-object-list'),
            analysis: require(doc, 'analysis-object-list'),
            integral: require(doc, 'integral-object-list'),
            intersection: require(doc, 'intersection-object-list'),
            solve: require(doc, 'solve-object-list'),
            antiderivative: require(doc, 'antiderivative-object-list'),
            ode: require(doc, 'ode-object-list'),
        },
    };
}
