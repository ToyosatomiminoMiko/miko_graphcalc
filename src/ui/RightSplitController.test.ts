/**
 * 右面板"参数区 / 视图区"分隔条控制器单测.
 *
 * 这里锁的是控制器自己的不变量:
 * - 指针位置 -> 比例 的换算(含上下限夹取),这是拖动路径的全部数学;
 * - 状态只有一个:比例被写成 `--right-split-basis`,不直接写元素高度;
 * - 拖动收尾 / dispose 后不留监听与残留态(桩的 window 监听实现了
 *   `{ signal }` 语义,拿掉这条回归会被遮住).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { installDomStub, type DomStub, type StubElement } from '../test/domStub';
import {
    computeSplitRatio,
    RightSplitController,
    SPLIT_DEFAULT_RATIO,
    SPLIT_MAX_RATIO,
    SPLIT_MIN_RATIO,
} from './RightSplitController';

interface SplitFixture {
    readonly stub: DomStub;
    readonly root: StubElement;
    readonly panel: StubElement;
    readonly handle: StubElement;
}

function setup(): SplitFixture {
    const stub = installDomStub();
    const root = stub.document.createElement('div');
    root.id = 'app';

    const panel = stub.document.createElement('aside');
    panel.id = 'right-panel';
    panel.className = 'panel';

    const handle = stub.document.createElement('div');
    handle.id = 'right-splitter';
    handle.className = 'right-splitter';

    panel.append(handle);
    root.append(panel);
    stub.document.body.append(root);
    return { stub, root, panel, handle };
}

function readBasis(root: StubElement): string {
    return root.style.getPropertyValue('--right-split-basis');
}

beforeEach(() => {
    installDomStub();
});

describe('computeSplitRatio', () => {
    it('把指针位置换算成"参数区占面板高度的比例"', () => {
        // 面板从 0 到 600px,指针落在 240px 处 -> 40%.
        expect(computeSplitRatio(240, { top: 0, height: 600 })).toBeCloseTo(0.4);
    });

    it('面板不在视口顶端时按顶边偏移换算', () => {
        expect(computeSplitRatio(340, { top: 100, height: 600 })).toBeCloseTo(0.4);
    });

    it('夹在两个边界之间,任一边都不会被拖到看不见', () => {
        expect(computeSplitRatio(-1000, { top: 0, height: 600 })).toBe(SPLIT_MIN_RATIO);
        expect(computeSplitRatio(1000, { top: 0, height: 600 })).toBe(SPLIT_MAX_RATIO);
    });

    it('面板高度为 0(未布局)时不给结果', () => {
        expect(computeSplitRatio(100, { top: 0, height: 0 })).toBeNull();
    });
});

describe('bind 与拖动', () => {
    it('bind 后写出默认比例', () => {
        const { root } = setup();
        new RightSplitController().bind(root as unknown as HTMLElement);

        expect(readBasis(root)).toBe(`${SPLIT_DEFAULT_RATIO * 100}%`);
    });

    it('缺少分隔条或右面板时安静返回,不写变量', () => {
        const stub = installDomStub();
        const root = stub.document.createElement('div');
        root.id = 'app';

        new RightSplitController().bind(root as unknown as HTMLElement);

        expect(readBasis(root)).toBe('');
    });

    it('拖动按位移改变比例,并给出拖动中的视觉与光标线索', () => {
        const { stub, root, panel, handle } = setup();
        panel.offsetHeight = 600;
        new RightSplitController().bind(root as unknown as HTMLElement);

        handle.dispatch('pointerdown', { clientY: 100, pointerId: 1 });
        expect(handle.classList.contains('is-dragging')).toBe(true);
        expect(stub.document.body.style.cursor).toBe('ns-resize');
        expect(handle.hasPointerCapture(1)).toBe(true);

        // 向下 120px = 面板高度的 20%:40% -> 60%.
        handle.dispatch('pointermove', { clientY: 220, pointerId: 1 });
        expect(readBasis(root)).toBe('60%');

        // 抬起:残留态清干净,比例保留在落点.
        handle.dispatch('pointerup', { clientY: 220, pointerId: 1 });
        expect(handle.classList.contains('is-dragging')).toBe(false);
        expect(stub.document.body.style.cursor).toBe('');
        expect(handle.hasPointerCapture(1)).toBe(false);
        expect(readBasis(root)).toBe('60%');
    });

    it('没按下时移动不改变比例', () => {
        const { root, panel, handle } = setup();
        panel.offsetHeight = 600;
        new RightSplitController().bind(root as unknown as HTMLElement);

        handle.dispatch('pointermove', { clientY: 400, pointerId: 1 });

        expect(readBasis(root)).toBe(`${SPLIT_DEFAULT_RATIO * 100}%`);
    });

    it('拖到极端位置时被下限/上限夹住', () => {
        const { root, panel, handle } = setup();
        panel.offsetHeight = 600;
        new RightSplitController().bind(root as unknown as HTMLElement);

        handle.dispatch('pointerdown', { clientY: 300, pointerId: 1 });
        handle.dispatch('pointermove', { clientY: -1000, pointerId: 1 });
        expect(readBasis(root)).toBe(`${SPLIT_MIN_RATIO * 100}%`);

        handle.dispatch('pointermove', { clientY: 1000, pointerId: 1 });
        expect(readBasis(root)).toBe(`${SPLIT_MAX_RATIO * 100}%`);
    });

    it('面板高度为 0 时忽略拖动事件', () => {
        const { root, handle } = setup();
        new RightSplitController().bind(root as unknown as HTMLElement);

        handle.dispatch('pointerdown', { clientY: 100, pointerId: 1 });
        handle.dispatch('pointermove', { clientY: 400, pointerId: 1 });

        expect(readBasis(root)).toBe(`${SPLIT_DEFAULT_RATIO * 100}%`);
    });
});

describe('键盘调整', () => {
    it('上下方向键按步长调整,并阻止页面滚动', () => {
        const { root, handle } = setup();
        new RightSplitController().bind(root as unknown as HTMLElement);

        let prevented = false;
        handle.dispatch('keydown', {
            key: 'ArrowDown',
            preventDefault: () => {
                prevented = true;
            },
        });
        expect(prevented).toBe(true);
        expect(readBasis(root)).toBe('43%');

        handle.dispatch('keydown', { key: 'ArrowUp' });
        expect(readBasis(root)).toBe('40%');
    });

    it('其它按键不调整比例', () => {
        const { root, handle } = setup();
        new RightSplitController().bind(root as unknown as HTMLElement);

        handle.dispatch('keydown', { key: 'Tab' });
        handle.dispatch('keydown', { key: 'a' });

        expect(readBasis(root)).toBe(`${SPLIT_DEFAULT_RATIO * 100}%`);
    });

    it('连续按到底时停在边界上', () => {
        const { root, handle } = setup();
        new RightSplitController().bind(root as unknown as HTMLElement);

        for (let i = 0; i < 60; i += 1) handle.dispatch('keydown', { key: 'ArrowDown' });
        expect(readBasis(root)).toBe(`${SPLIT_MAX_RATIO * 100}%`);

        for (let i = 0; i < 120; i += 1) handle.dispatch('keydown', { key: 'ArrowUp' });
        expect(readBasis(root)).toBe(`${SPLIT_MIN_RATIO * 100}%`);
    });
});

describe('dispose', () => {
    it('拖动中 dispose:监听摘掉,光标与拖动标记复位', () => {
        const { stub, root, panel, handle } = setup();
        panel.offsetHeight = 600;
        const controller = new RightSplitController();
        controller.bind(root as unknown as HTMLElement);

        handle.dispatch('pointerdown', { clientY: 100, pointerId: 1 });
        controller.dispose();

        expect(stub.document.body.style.cursor).toBe('');
        expect(handle.classList.contains('is-dragging')).toBe(false);

        // 监听已随 signal 摘除:后续事件不再产生写入.
        const before = readBasis(root);
        handle.dispatch('pointerdown', { clientY: 100, pointerId: 2 });
        handle.dispatch('pointermove', { clientY: 500, pointerId: 2 });
        expect(readBasis(root)).toBe(before);
        expect(handle.hasPointerCapture(2)).toBe(false);
    });
});

describe('样式契约', () => {
    /**
     * `#params-panel` 的 `flex-basis` 兜底值必须等于默认比例:那两处是同一份
     * "初始分割",写在两个文件里,改一处漏一处就会首帧闪一下别的比例
     * (与 applyUiConfig.test.ts 锁 base.css 兜底的思路一致).
     */
    it('base.css 的兜底比例与 SPLIT_DEFAULT_RATIO 一致', () => {
        const css = readFileSync(new URL('../../css/base.css', import.meta.url), 'utf8');
        const match = /--right-split-basis:\s*([^;]+);/.exec(css);

        expect(match?.[1].trim()).toBe(`${SPLIT_DEFAULT_RATIO * 100}%`);
    });

    it('分隔条样式存在,并声明了纵向拖动的光标与触摸行为', () => {
        const css = readFileSync(new URL('../../css/panels.css', import.meta.url), 'utf8');
        const rule = /\.right-splitter\s*\{([\s\S]*?)\}/.exec(css);

        expect(rule?.[1]).toMatch(/cursor:\s*ns-resize/);
        expect(rule?.[1]).toMatch(/touch-action:\s*none/);
    });
});
