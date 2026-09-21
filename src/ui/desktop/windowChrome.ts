/**
 * 窗口标题栏上的四个"应用节点":示例按钮 / RUN / 示例浮层 / 复制提示.
 *
 * **为什么在这里建,而不是留在 `index.html`**:这四个节点的 id 与监听归各自的
 * 控制器(`ExampleLoaderController` / `FormulaCopyController` / `DslApp`),位置
 * 却归窗口外壳.留在 HTML 就得同时维持三套机制:一个"启动前不参与布局"的
 * 隐藏暂存区,一次按 id 取节点,一次"搬进标题栏"的搬运;任何一处漏掉都是静默
 * 错(按钮点不动,浮层留在正文里被裁).在这里用 `el()` 建好再以构造参数注入之后,
 * 节点从出生起就有明确的主人,"谁搬去哪"由 `UI_CONFIG.window.adopted` 一张表
 * 说完(见 docs/windowing-plan.md §5.3).
 *
 * **只建节点,不接线**:监听,开合,回显分别归各自的控制器;本文件与
 * `WindowFrame` 一样,只负责结构,不订阅任何状态.
 *
 * **id 仍保留**:`example-btn` / `example-menu` 这一对是 `Popover` 建立
 * `aria-controls` / `aria-labelledby` 关系用的(见 `ui/widgets/Popover.ts`),
 * 配对靠 id;它们不再被任何 `getElementById` 查找,全应用取节点的唯一入口是
 * `app/appHosts.ts` 与这里的构造注入.
 */
import { UI_CONFIG, type ChromeNodeId, type WindowId, type WindowSlot } from '@/config/uiConfig';
import { el } from '@/ui/widgets/dom';
import type { WindowContentProvider } from './WindowManager';

/**
 * 四个节点的句柄.
 *
 * 形状由 `ChromeNodeId` 锁死:配置里 `adopted[].node` 用到的每个名字都必须是
 * 这里的字段,反之少建一个节点即编译不过 -- 旧写法(按 id 查)漏一个只在
 * 运行期表现为 `null`,这条约束因此不需要额外的测试来守.
 */
export type WindowChrome = Record<ChromeNodeId, HTMLElement>;

export function createWindowChrome(): WindowChrome {
    // `aria-haspopup` 是静态语义,写在这里;`aria-expanded` 是状态,由 Popover
    // 在构造与每次开合时独占写入(见 Popover 的"开合态唯一"约定).
    const exampleButton = el('button', {
        attrs: { type: 'button', 'aria-haspopup': 'true' },
        text: UI_CONFIG.window.chrome.exampleLabel,
    });
    exampleButton.id = 'example-btn';

    const runButton = el('button', {
        attrs: { type: 'button' },
        text: UI_CONFIG.window.chrome.runLabel,
    });
    runButton.id = 'run-btn';

    // 分组与菜单项由 ExampleLoaderController 按 exampleCatalog 渲染,这里只给
    // 空浮层容器与它的无障碍关系.
    const exampleMenu = el('div', {
        class: 'example-menu',
        attrs: { role: 'menu', 'aria-labelledby': exampleButton.id },
    });
    exampleMenu.id = 'example-menu';

    const formulaCopyHint = el('span', {
        class: 'object-list-hint',
        text: UI_CONFIG.window.chrome.copyHint,
    });
    formulaCopyHint.id = 'formula-copy-hint';

    return { exampleButton, runButton, exampleMenu, formulaCopyHint };
}

/**
 * 把 `UI_CONFIG.window.adopted` 解析成 `WindowManager` 要的提供者.
 *
 * 表只读一次并按窗口分组,于是"哪个节点进哪个窗口的哪个槽"没有分支:加一个
 * 标题栏节点 = 加一行配置 + 在 `createWindowChrome` 建一个节点.旧写法是
 * `DslApp._windowContent()` 里按窗口 id 写 if 链,同一件事在三个文件里各说一半.
 */
export function windowSlotsProvider(chrome: WindowChrome): WindowContentProvider {
    const byWindow = new Map<WindowId, Record<WindowSlot, HTMLElement[]>>();
    for (const { node, window: id, slot } of UI_CONFIG.window.adopted) {
        let slots = byWindow.get(id);
        if (!slots) {
            slots = { title: [], actions: [], overlays: [] };
            byWindow.set(id, slots);
        }
        slots[slot].push(chrome[node]);
    }
    return (id) => byWindow.get(id) ?? {};
}
