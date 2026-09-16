/**
 * 三级披露判据(L0 摘要行 / L1 行内 `<details>` / L2 过程页).
 *
 * 判据是**纯函数**:细节行数超过阈值就进 L2 过程页,否则留在 L1 原地
 * (短过程零改动).阈值进 `UI_CONFIG.process`(纯数据),不在代码里留字面量.
 *
 * 为什么按"细节行数"而不是"字符数"或"公式宽度":行数是列表布局的天然单位--
 * 底栏一屏约 14 行简单式(见 docs/equation-solving-process.md 第 1.1 节),
 * `N` 直接对应"留在 L1 最多占多少行",而不是一个需要换算的代理量.
 * 长等式仍然会横向滚动,那是宽度问题,与"要不要换一页"无关.
 */
import { UI_CONFIG } from '../../config/uiConfig';
import type { EvaluationDetailLine } from '../../compiler/dsl/evaluationLatex';

/** 默认阈值:与 `UI_CONFIG.process.disclosureThreshold` 同一份数据. */
export const PROCESS_DISCLOSURE_THRESHOLD = UI_CONFIG.process.disclosureThreshold;

/**
 * 细节行数是否超过阈值(严格大于).
 *
 * 恰好等于阈值仍留在 L1:`≤ N 行`是 L1 的长度预算,边界归 L1 才不会让
 * "刚好 N 行"的条目无谓地跳页.
 */
export function needsProcessPage(
    lines: readonly EvaluationDetailLine[],
    threshold: number = PROCESS_DISCLOSURE_THRESHOLD,
): boolean {
    return lines.length > threshold;
}
