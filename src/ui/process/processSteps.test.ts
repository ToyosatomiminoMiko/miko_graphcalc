/**
 * 过程步骤的数据词汇单测:上限截断与步骤分区都是纯函数,必须能独立断言
 * (路线图改造原则 4 / 设计文档 P5).
 */
import { describe, expect, it } from 'vitest';
import { SOLVE_STEP_KINDS } from '@/contract/ir';
import {
    PROCESS_STEP_KIND_LABELS,
    partitionStepsByKind,
    truncateProcessSteps,
    type ProcessStep,
    type ProcessStepKind,
} from './processSteps';

function step(latex: string, kind: ProcessStepKind, reason: string): ProcessStep {
    return { latex, kind, reason };
}

describe('truncateProcessSteps', () => {
    it('未超上限:原样返回且不标截断', () => {
        const steps = [step('a', 'rule', '链式法则'), step('b', 'algebra', '移项')];

        const result = truncateProcessSteps(steps, 5);

        expect(result.steps).toBe(steps);
        expect(result.droppedSteps).toBeNull();
    });

    it('恰好等于上限也算未截断(边界归 L1/完整展示)', () => {
        const steps = [step('a', 'rule', 'r'), step('b', 'numeric', 'n')];

        expect(truncateProcessSteps(steps, 2).droppedSteps).toBeNull();
    });

    it('上限先向下取整:3.5 与 3 是同一个口径', () => {
        const steps = Array.from({ length: 4 }, (_, index) =>
            step(`x_{${index}}`, 'numeric', '数值代入'));

        expect(truncateProcessSteps(steps, 3.5).droppedSteps).toBe(1);
        expect(truncateProcessSteps(steps, 3).droppedSteps).toBe(1);
    });

    it('超过上限:截断并给出被丢弃的步数', () => {
        const steps = Array.from({ length: 7 }, (_, index) =>
            step(`x_{${index}}`, 'numeric', '数值代入'));

        const result = truncateProcessSteps(steps, 3);

        expect(result.steps).toHaveLength(3);
        expect(result.steps[0].latex).toBe('x_{0}');
        expect(result.droppedSteps).toBe(4);
    });

    it('上限非正数:返回空列表并把全部步骤记为丢弃(不抛异常)', () => {
        const steps = [step('a', 'rule', 'r'), step('b', 'numeric', 'n')];

        const zero = truncateProcessSteps(steps, 0);
        expect(zero.steps).toEqual([]);
        expect(zero.droppedSteps).toBe(2);

        const negative = truncateProcessSteps(steps, -3);
        expect(negative.steps).toEqual([]);
        expect(negative.droppedSteps).toBe(2);
    });
});

describe('partitionStepsByKind', () => {
    it('按 kind 分区:组内保持原顺序,空区不出现', () => {
        const groups = partitionStepsByKind([
            step('a', 'rule', '链式法则'),
            step('b', 'numeric', '数值代入'),
            step('c', 'rule', '积法则'),
        ]);

        expect(groups.map((group) => group.kind)).toEqual(['rule', 'numeric']);
        expect(groups[0].steps.map((entry) => entry.latex)).toEqual(['a', 'c']);
        expect(groups[1].steps.map((entry) => entry.latex)).toEqual(['b']);
    });

    it('分区顺序是规范顺序,不随步骤出现顺序变化', () => {
        const groups = partitionStepsByKind([
            step('a', 'numeric', '数值代入'),
            step('b', 'definition', '算子定义式'),
        ]);

        // 规范顺序取内核分区:法则 / 代数 / 定义 / 数值.
        expect(groups.map((group) => group.kind)).toEqual(['definition', 'numeric']);
    });

    it('空步骤列表给空分区', () => {
        expect(partitionStepsByKind([])).toEqual([]);
    });
});

describe('依据文案表', () => {
    it('内核的每个分区都有中性名字(新增分区会在这里失败,而不是静默无文案)', () => {
        expect([...SOLVE_STEP_KINDS].sort()).toEqual(
            Object.keys(PROCESS_STEP_KIND_LABELS).sort(),
        );
        for (const kind of SOLVE_STEP_KINDS) {
            expect(PROCESS_STEP_KIND_LABELS[kind].length).toBeGreaterThan(0);
        }
    });
});
