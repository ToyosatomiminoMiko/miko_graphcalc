/**
 * 面板布局控制器单测(UI-P3.2 / UI-P3.3).
 *
 * 锁两件事:
 * - 折叠按钮的文案说明"按下会发生什么"(展开/收起),并带
 *   `aria-expanded` / `aria-controls`;
 * - 折叠态只有一个状态源与一个写入点:`dispose()` 先把 DOM 复位成展开,
 *   再次 `bind()` 不会得到"模型展开 / DOM 折叠"的自相矛盾面板.
 *
 * 拖拽尺寸路径现在也覆盖:`bindDragGesture` 把拖动收成一份共用实现,桩又实现了
 * `setPointerCapture` 的重定向语义(move/up 只在捕获元素上触发),所以"拖宽度"
 * 与"拖高度"可以在单测里完整走一遍,不必再依赖真机.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { UI_CONFIG } from '../../config/uiConfig';
import { installDomStub, type DomStub, type StubElement } from '../../test/domStub';
import { PanelController } from './PanelController';

interface FakePanel {
    readonly panel: StubElement;
    readonly header: StubElement;
    readonly button: StubElement;
    readonly body: StubElement;
    readonly handle: StubElement;
}

function createPanel(
    stub: DomStub,
    id: string,
    title: string,
    tag: 'aside' | 'footer',
): FakePanel {
    const panel = stub.document.createElement(tag);
    panel.id = id;
    panel.classList.add('panel');

    const header = stub.document.createElement('header');
    header.className = 'panel-header';
    const titleSpan = stub.document.createElement('span');
    titleSpan.className = 'panel-title';
    titleSpan.textContent = title;
    const button = stub.document.createElement('button');
    button.textContent = '收起';
    button.dataset.panelToggle = `#${id}`;
    header.append(titleSpan, button);

    const body = stub.document.createElement('section');
    body.id = `${id}-body`;

    const handle = stub.document.createElement('div');
    handle.className = 'resize-handle';
    handle.dataset.resizePanel = id;
    // 真标记里三根分隔条的光标由 css/layout.css 给出(layout.css 的
    // .resize-handle-top 是 ns-resize,左右两根是 ew-resize);DOM 桩不解析
    // 样式表,所以拖动读到的光标要像真标记那样写在元素上.
    handle.style.cursor = id === 'bottom-panel' ? 'ns-resize' : 'ew-resize';

    panel.append(header, body, handle);
    return { panel, header, button, body, handle };
}

function setup(): { stub: DomStub; root: StubElement; left: FakePanel; bottom: FakePanel } {
    const stub = installDomStub();
    const root = stub.document.createElement('div');
    root.id = 'app';
    const left = createPanel(stub, 'left-panel', '源码', 'aside');
    const bottom = createPanel(stub, 'bottom-panel', '对象', 'footer');
    root.append(left.panel, bottom.panel);
    stub.document.body.append(root);
    return { stub, root, left, bottom };
}

beforeEach(() => {
    installDomStub();
});

describe('折叠态的可访问语义(UI-P3.2)', () => {
    it('bind 后按钮是"收起"并标出展开状态与受控面板', () => {
        const { root, left } = setup();
        new PanelController().bind(root as unknown as HTMLElement);

        expect(left.button.textContent).toBe('收起');
        expect(left.button.getAttribute('aria-expanded')).toBe('true');
        expect(left.button.getAttribute('aria-controls')).toBe('left-panel');
    });

    it('折叠后按钮文案变成"展开",不再退化成面板标题', () => {
        const { root, left } = setup();
        new PanelController().bind(root as unknown as HTMLElement);

        left.button.dispatch('click');

        expect(left.panel.classList.contains('collapsed')).toBe(true);
        expect(left.button.textContent).toBe('展开');
        expect(left.button.getAttribute('aria-expanded')).toBe('false');
        // 承载按钮的 header 保留(折叠条要能点开),正文与手柄收起.
        expect(left.header.style.display).toBe('');
        expect(left.body.style.display).toBe('none');
        expect(left.handle.style.display).toBe('none');
        expect(root.style.getPropertyValue('--left-panel-width')).toBe(
            `${UI_CONFIG.panel.collapsedSideWidth}px`,
        );
    });

    it('再次点击恢复展开与原始宽度', () => {
        const { root, left } = setup();
        new PanelController().bind(root as unknown as HTMLElement);

        left.button.dispatch('click');
        left.button.dispatch('click');

        expect(left.panel.classList.contains('collapsed')).toBe(false);
        expect(left.button.textContent).toBe('收起');
        expect(left.body.style.display).toBe('');
        expect(root.style.getPropertyValue('--left-panel-width')).toBe(
            `${UI_CONFIG.panel.sideDefaultWidth}px`,
        );
    });

    it('各面板互不影响', () => {
        const { root, left, bottom } = setup();
        new PanelController().bind(root as unknown as HTMLElement);

        left.button.dispatch('click');

        expect(left.panel.classList.contains('collapsed')).toBe(true);
        expect(bottom.panel.classList.contains('collapsed')).toBe(false);
        expect(bottom.body.style.display).toBe('');
        expect(root.style.getPropertyValue('--footer-height')).toBe(
            `${UI_CONFIG.panel.footerDefaultHeight}px`,
        );
    });
});

describe('拖拽尺寸(共用拖动件)', () => {
    it('左面板向右拖变宽:按位移累计并写进 CSS 变量', () => {
        const { stub, root, left } = setup();
        new PanelController().bind(root as unknown as HTMLElement);
        const start = UI_CONFIG.panel.sideDefaultWidth;

        left.handle.dispatch('pointerdown', { clientX: 100, clientY: 0, pointerId: 1 });
        expect(left.handle.classList.contains('is-dragging')).toBe(true);
        expect(stub.document.body.style.cursor).toBe('ew-resize');
        expect(left.handle.hasPointerCapture(1)).toBe(true);

        left.handle.dispatch('pointermove', { clientX: 140, clientY: 0, pointerId: 1 });
        expect(root.style.getPropertyValue('--left-panel-width')).toBe(`${start + 40}px`);

        // 增量语义:第二次移动是相对上一次落点累计,不是相对起点.
        left.handle.dispatch('pointermove', { clientX: 160, clientY: 0, pointerId: 1 });
        expect(root.style.getPropertyValue('--left-panel-width')).toBe(`${start + 60}px`);

        left.handle.dispatch('pointerup', { clientX: 160, clientY: 0, pointerId: 1 });
        expect(left.handle.classList.contains('is-dragging')).toBe(false);
        expect(stub.document.body.style.cursor).toBe('');
        expect(left.handle.hasPointerCapture(1)).toBe(false);
        // 收尾不改值,停在落点.
        expect(root.style.getPropertyValue('--left-panel-width')).toBe(`${start + 60}px`);
    });

    it('右面板向左拖才是变宽,底部面板向上拖才是变高', () => {
        const stub = installDomStub();
        const root = stub.document.createElement('div');
        root.id = 'app';
        const right = createPanel(stub, 'right-panel', '视图', 'aside');
        const bottom = createPanel(stub, 'bottom-panel', '对象', 'footer');
        root.append(right.panel, bottom.panel);
        stub.document.body.append(root);
        new PanelController().bind(root as unknown as HTMLElement);

        const sideStart = UI_CONFIG.panel.sideDefaultWidth;
        right.handle.dispatch('pointerdown', { clientX: 500, clientY: 0, pointerId: 1 });
        right.handle.dispatch('pointermove', { clientX: 450, clientY: 0, pointerId: 1 });
        expect(root.style.getPropertyValue('--right-panel-width')).toBe(`${sideStart + 50}px`);

        const footerStart = UI_CONFIG.panel.footerDefaultHeight;
        bottom.handle.dispatch('pointerdown', { clientX: 0, clientY: 500, pointerId: 2 });
        bottom.handle.dispatch('pointermove', { clientX: 0, clientY: 460, pointerId: 2 });
        expect(root.style.getPropertyValue('--footer-height')).toBe(`${footerStart + 40}px`);
        expect(stub.document.body.style.cursor).toBe('ns-resize');
    });

    it('折叠状态下的分隔条不可拖:不起手,也不改宽度', () => {
        const { stub, root, left } = setup();
        new PanelController().bind(root as unknown as HTMLElement);
        left.button.dispatch('click');

        const collapsed = root.style.getPropertyValue('--left-panel-width');
        left.handle.dispatch('pointerdown', { clientX: 100, clientY: 0, pointerId: 1 });
        left.handle.dispatch('pointermove', { clientX: 200, clientY: 0, pointerId: 1 });

        // 展开态宽度没被写进去(collapsed 分支仍写 COLLAPSED_SIDE_WIDTH).
        expect(root.style.getPropertyValue('--left-panel-width')).toBe(collapsed);
        expect(left.handle.classList.contains('is-dragging')).toBe(false);
        expect(stub.document.body.style.cursor).toBe('');
    });

    it('拖动中 dispose:监听摘掉,光标与拖动标记复位', () => {
        const { stub, root, left } = setup();
        const controller = new PanelController();
        controller.bind(root as unknown as HTMLElement);

        left.handle.dispatch('pointerdown', { clientX: 100, clientY: 0, pointerId: 1 });
        controller.dispose();

        expect(stub.document.body.style.cursor).toBe('');
        expect(left.handle.classList.contains('is-dragging')).toBe(false);
        expect(left.handle.hasPointerCapture(1)).toBe(false);
    });

    it('被夹在上下限之间:拖到极端不会把面板拖没', () => {
        const { root, left } = setup();
        new PanelController().bind(root as unknown as HTMLElement);

        left.handle.dispatch('pointerdown', { clientX: 0, clientY: 0, pointerId: 1 });
        left.handle.dispatch('pointermove', { clientX: -10_000, clientY: 0, pointerId: 1 });
        expect(root.style.getPropertyValue('--left-panel-width')).toBe(
            `${UI_CONFIG.panel.sideMinWidth}px`,
        );

        left.handle.dispatch('pointermove', { clientX: 10_000, clientY: 0, pointerId: 1 });
        expect(root.style.getPropertyValue('--left-panel-width')).toBe(
            `${UI_CONFIG.panel.sideMaxWidth}px`,
        );
    });
});

describe('dispose 复位与重复 bind(UI-P3.3)', () => {
    it('dispose 把模型与 DOM 一起复位成展开态', () => {
        const { root, left } = setup();
        const controller = new PanelController();
        controller.bind(root as unknown as HTMLElement);

        left.button.dispatch('click');
        controller.dispose();

        expect(left.panel.classList.contains('collapsed')).toBe(false);
        expect(left.body.style.display).toBe('');
        expect(left.handle.style.display).toBe('');
        expect(left.button.textContent).toBe('收起');
        expect(left.button.getAttribute('aria-expanded')).toBe('true');
        expect(root.style.getPropertyValue('--left-panel-width')).toBe(
            `${UI_CONFIG.panel.sideDefaultWidth}px`,
        );
    });

    it('dispose 后再次 bind,折叠/展开仍然自洽', () => {
        const { root, left } = setup();
        const controller = new PanelController();
        controller.bind(root as unknown as HTMLElement);
        left.button.dispatch('click');
        controller.dispose();

        controller.bind(root as unknown as HTMLElement);
        expect(left.panel.classList.contains('collapsed')).toBe(false);
        expect(left.body.style.display).toBe('');

        left.button.dispatch('click');
        expect(left.panel.classList.contains('collapsed')).toBe(true);
        expect(left.button.textContent).toBe('展开');
        expect(root.style.getPropertyValue('--left-panel-width')).toBe(
            `${UI_CONFIG.panel.collapsedSideWidth}px`,
        );
    });

    it('dispose 会摘掉旧监听:重新 bind 只保留一份监听', () => {
        const { root, left } = setup();
        const controller = new PanelController();
        controller.bind(root as unknown as HTMLElement);
        controller.dispose();

        // dispose 的 abort 摘掉旧监听(桩实现了 { signal } 语义):点击不再改状态.
        left.button.dispatch('click');
        controller.bind(root as unknown as HTMLElement);
        // 若旧监听还在,dispose 后那次点击会把折叠态留在集合里,重新 bind 时
        // _applyLayout 会立刻把面板折叠起来.
        expect(left.panel.classList.contains('collapsed')).toBe(false);

        // 也只应有一份监听:点一次折叠一次,而不是"折叠又被另一份展开".
        left.button.dispatch('click');
        expect(left.panel.classList.contains('collapsed')).toBe(true);
        expect(left.button.textContent).toBe('展开');
        expect(root.style.getPropertyValue('--left-panel-width')).toBe(
            `${UI_CONFIG.panel.collapsedSideWidth}px`,
        );
    });
});

describe('右栏宽度按页(宽度组)记', () => {
    function setupRight(): {
        stub: DomStub;
        root: StubElement;
        right: FakePanel;
        controller: PanelController;
    } {
        const stub = installDomStub();
        const root = stub.document.createElement('div');
        root.id = 'app';
        const right = createPanel(stub, 'right-panel', '参数', 'aside');
        root.append(right.panel);
        stub.document.body.append(root);

        const controller = new PanelController();
        controller.bind(root as unknown as HTMLElement);
        return { stub, root, right, controller };
    }

    it('切页 = 切宽度:各页各自的调整互不覆盖', () => {
        const { root, right, controller } = setupRight();
        const paramsDefault = UI_CONFIG.panel.sideDefaultWidth;

        expect(root.style.getPropertyValue('--right-panel-width')).toBe(
            `${UI_CONFIG.panel.sideDefaultWidth}px`,
        );
        expect(root.style.getPropertyValue('--right-panel-width')).toBe(`${paramsDefault}px`);

        // 参数页拖宽 40px(右面板向左拖是变宽).
        right.handle.dispatch('pointerdown', { clientX: 500, clientY: 0, pointerId: 1 });
        right.handle.dispatch('pointermove', { clientX: 460, clientY: 0, pointerId: 1 });
        right.handle.dispatch('pointerup', { clientX: 460, clientY: 0, pointerId: 1 });
        expect(root.style.getPropertyValue('--right-panel-width')).toBe(`${paramsDefault + 40}px`);

        // 切到过程页:换成过程组的默认宽度(与参数页不同).
        controller.setWidthGroup('right-panel', 'process');
        expect(root.style.getPropertyValue('--right-panel-width')).toBe(
            `${UI_CONFIG.process.defaultWidth}px`,
        );

        // 过程页拖窄 40px.
        right.handle.dispatch('pointerdown', { clientX: 500, clientY: 0, pointerId: 2 });
        right.handle.dispatch('pointermove', { clientX: 540, clientY: 0, pointerId: 2 });
        right.handle.dispatch('pointerup', { clientX: 540, clientY: 0, pointerId: 2 });
        expect(root.style.getPropertyValue('--right-panel-width')).toBe(
            `${UI_CONFIG.process.defaultWidth - 40}px`,
        );

        // 切回参数页:用户对参数页的调整还在,没有被过程页的拖动顶掉.
        controller.setWidthGroup('right-panel', 'params');
        expect(root.style.getPropertyValue('--right-panel-width')).toBe(`${paramsDefault + 40}px`);
    });

    it('过程页在前时,同一根手柄改的是过程组的宽度', () => {
        const { root, right, controller } = setupRight();
        controller.setWidthGroup('right-panel', 'process');

        right.handle.dispatch('pointerdown', { clientX: 500, clientY: 0, pointerId: 1 });
        right.handle.dispatch('pointermove', { clientX: 460, clientY: 0, pointerId: 1 });
        right.handle.dispatch('pointerup', { clientX: 460, clientY: 0, pointerId: 1 });

        expect(root.style.getPropertyValue('--right-panel-width')).toBe(
            `${UI_CONFIG.process.defaultWidth + 40}px`,
        );
        // 参数组不受影响.
        controller.setWidthGroup('right-panel', 'params');
        expect(root.style.getPropertyValue('--right-panel-width')).toBe(
            `${UI_CONFIG.panel.sideDefaultWidth}px`,
        );
    });

    it('dispose 把宽度组复位成参数页(与折叠复位同一条路径)', () => {
        const { root, controller } = setupRight();
        controller.setWidthGroup('right-panel', 'process');

        controller.dispose();

        expect(root.style.getPropertyValue('--right-panel-width')).toBe(
            `${UI_CONFIG.panel.sideDefaultWidth}px`,
        );
        expect(root.style.getPropertyValue('--right-panel-width')).toBe(
            `${UI_CONFIG.panel.sideDefaultWidth}px`,
        );
    });
});

describe('带标签页的右栏:折叠与页级显隐互不干扰', () => {
    function setupTabsPanel(): {
        stub: DomStub;
        root: StubElement;
        panel: StubElement;
        header: StubElement;
        tabs: StubElement;
        paramsPage: StubElement;
        processPage: StubElement;
        button: StubElement;
    } {
        const stub = installDomStub();
        const root = stub.document.createElement('div');
        root.id = 'app';

        const panel = stub.document.createElement('aside');
        panel.id = 'right-panel';
        panel.className = 'panel';

        // 标签栏必须在 header **内部**:折叠遍历隐藏的是面板的直接子元素,
        // 放进页容器里一折叠就再也切不回来(见设计文档 3.2 第 1 条).
        const header = stub.document.createElement('header');
        header.className = 'panel-header';
        const tabs = stub.document.createElement('div');
        tabs.id = 'right-tabs';
        const button = stub.document.createElement('button');
        button.textContent = '收起';
        button.dataset.panelToggle = '#right-panel';
        header.append(tabs, button);

        const paramsPage = stub.document.createElement('div');
        paramsPage.id = 'right-page-params';
        const processPage = stub.document.createElement('div');
        processPage.id = 'right-page-process';
        processPage.setAttribute('hidden', '');

        const handle = stub.document.createElement('div');
        handle.dataset.resizePanel = 'right-panel';
        handle.style.cursor = 'ew-resize';

        panel.append(header, paramsPage, processPage, handle);
        root.append(panel);
        stub.document.body.append(root);
        return { stub, root, panel, header, tabs, paramsPage, processPage, button };
    }

    it('折叠隐藏两页但保留页签所在的 header,展开后两页恢复', () => {
        const { root, panel, header, tabs, paramsPage, processPage, button } = setupTabsPanel();
        new PanelController().bind(root as unknown as HTMLElement);

        button.dispatch('click');

        expect(panel.classList.contains('collapsed')).toBe(true);
        expect(header.style.display).toBe('');
        expect(paramsPage.style.display).toBe('none');
        expect(processPage.style.display).toBe('none');
        // 标签栏不在折叠遍历的直接子元素里,其显隐由 CSS 的 .collapsed 负责.
        expect(tabs.style.display).toBe('');

        button.dispatch('click');

        expect(paramsPage.style.display).toBe('');
        expect(processPage.style.display).toBe('');
        // 展开不等于把过程页也显示出来:页级 hidden 仍归标签页控制器.
        expect(processPage.getAttribute('hidden')).toBe('');
    });
});
