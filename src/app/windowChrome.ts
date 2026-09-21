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
 * **为什么在应用侧而不在库里**(docs/ui-library-extraction-plan.md D9):"示例"
 * 与 "RUN" 是这个应用的文案,示例浮层是这个应用的菜单;库只提供"把节点放进
 * 标题栏槽位"的能力(`windowSlotsProvider` 与 `mountDesktop` 的 `slots`).
 *
 * **只建节点,不接线**:监听,开合,回显分别归各自的控制器;本文件只负责结构,
 * 不订阅任何状态.
 *
 * **id 仍保留**:`example-btn` / `example-menu` 这一对是 `Popover` 建立
 * `aria-controls` / `aria-labelledby` 关系用的(见 `widgets/Popover.ts`),
 * 配对靠 id;它们不再被任何 `getElementById` 查找(装配层拿的是句柄).
 */
import { el } from '@miko/ui';
import { UI_CONFIG, type ChromeNodeId } from '@/config/uiConfig';

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
