/**
 * 公式 DOM 工具单测(UI-P3.5 / UI-P3.6).
 *
 * 锁三件事:
 * 1. 可复制公式带 `data-tex` + `tabindex="0"` + `role="button"` + `aria-label`
 *    (键盘入口的 DOM 契约,UI-P3.6);
 * 2. 不可复制公式一个都不带(摘要行处在 `<summary>` 内,不能塞嵌套交互元素);
 * 3. 模板缓存必须 **clone 而不是搬运**:同一串 LaTeX 渲染两次都还有内容.
 *
 * KaTeX 用写回 textContent 的假实现,断言只看结构与属性,不看排版.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomStub } from '../test/domStub';

vi.mock('katex', () => ({
    default: {
        render: (tex: string, element: { textContent: string }) => {
            element.textContent = tex;
        },
    },
}));
vi.mock('katex/dist/katex.min.css', () => ({}));

import { createFormulaElement } from './FormulaView';

beforeEach(() => {
    installDomStub();
});

describe('createFormulaElement', () => {
    it('可复制公式:带 data-tex 与键盘/角色语义', () => {
        const element = createFormulaElement('x^2', 'object-expr');

        expect(element.className).toBe('object-expr');
        expect(element.dataset.tex).toBe('x^2');
        expect(element.tabIndex).toBe(0);
        expect(element.getAttribute('role')).toBe('button');
        expect(element.getAttribute('aria-label')).toBe('复制公式 TeX');
        expect(element.textContent).toBe('x^2');
    });

    it('不可复制公式:不带任何复制/焦点属性', () => {
        const element = createFormulaElement('x^2', 'eval-summary-formula', false);

        expect(element.dataset.tex).toBeUndefined();
        expect(element.tabIndex).toBe(-1);
        expect(element.getAttribute('role')).toBeNull();
        expect(element.getAttribute('aria-label')).toBeNull();
    });

    it('同一串公式渲染两次都有内容(模板 clone,不搬空缓存)', () => {
        const first = createFormulaElement('y=1');
        const second = createFormulaElement('y=1');

        expect(first.textContent).toBe('y=1');
        expect(second.textContent).toBe('y=1');
        expect(first).not.toBe(second);
    });
});
