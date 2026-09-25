/**
 * 积分条目的"过程"入口单测.
 *
 * 锁的是一条**异步时序**上的不变量:积分数值回来走 `renderValue`(直接改
 * DOM,不重建行),所以"过程"入口必须**在点击时**读当前值--回调闭包捕获
 * 构造期的 `value` 会永远停在 `null`,过程页就会缺一个右端.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomStub, type StubElement } from '@/testing/domStub';

vi.mock('katex', () => ({
    default: {
        render: (tex: string, element: { textContent: string }) => {
            element.textContent = tex;
        },
    },
}));
vi.mock('katex/dist/katex.min.css', () => ({}));
// 积分细节只有 3 行,默认阈值(5)下"过程"入口不出现.这里只放宽**披露判据**
// 本身,让"点按钮 -> 拿文档"这条真实路径可以被驱动:驱动器不是被测逻辑,
// 而过程文档的新鲜度才是.
vi.mock('@/ui/process/disclosure', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../process/disclosure')>()),
    needsProcessPage: () => true,
}));

import type { IntegralTask, SceneObject } from '@/contract/ir';
import type { ProcessDocument } from '@/adapters/processSteps';
import { IntegralItem } from './integralItem';
import type { EvaluationContext } from './EvaluationItem';

const curve: SceneObject = {
    kind: 'curve',
    id: 1,
    name: 'c1',
    expr: 'x',
    coefficients: [],
    color: '#ffffff',
    enabled: true,
};

const task: IntegralTask = {
    name: 'I',
    objectId: 1,
    sourceKind: 'curve',
    dim: 1,
    domainKind: 'interval',
    method: 'riemann:mid',
    integrand: 'x',
    integrandCoefficients: [],
    countCoefficients: [],
    range: [-4, 4],
    segments: 32,
    layers: 8,
    show: true,
    enabled: true,
};

function setup(cached: number | null = null): {
    item: IntegralItem;
    documents: ProcessDocument[];
} {
    const documents: ProcessDocument[] = [];
    const context: EvaluationContext = {
        objects: [curve],
        toggleHidden: () => {},
        openProcess: (request) => documents.push(request.document),
    };
    return { item: new IntegralItem(task, context, cached), documents };
}

function clickProcessEntry(item: IntegralItem): void {
    // 列表行的 DOM 由 DOM 桩提供,所以这里按桩元素取(与其它 item 测试同一做法).
    const button = item.row.querySelector('.row-process-btn') as unknown as StubElement | null;
    expect(button).not.toBeNull();
    button!.dispatch('click');
}

describe('积分过程的数值新鲜度', () => {
    beforeEach(() => {
        installDomStub();
    });

    it('异步回填后点"过程":等式带上刚算出的数值,而不是构造期的 null', () => {
        const { item, documents } = setup(null);

        item.renderValue(1.5);
        clickProcessEntry(item);

        expect(documents).toHaveLength(1);
        expect(documents[0].steps).toHaveLength(1);
        expect(documents[0].steps[0].latex).toContain('=1.5');
    });

    it('值再变一次后点"过程":用最后一次的值', () => {
        const { item, documents } = setup(1.5);

        item.renderValue(2.25);
        clickProcessEntry(item);

        expect(documents[0].steps[0].latex).toContain('=2.25');
        expect(documents[0].steps[0].latex).not.toContain('1.5');
    });

    it('出错后点"过程":丢掉数值,等式退回不带右端', () => {
        const { item, documents } = setup(1.5);

        item.renderError('计算失败');
        clickProcessEntry(item);

        expect(documents[0].steps[0].latex).not.toContain('=');
    });
});
