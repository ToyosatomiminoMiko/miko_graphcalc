/**
 * 求值细节的**展示数据契约**.
 *
 * 为什么这两个类型在 `contract/` 而不在 `compiler/dsl/evaluationLatex.ts`
 * (docs/ui-library-extraction-plan.md D3):它们是纯数据(`kind` + `string`),
 * 是"编译器 -> 界面"这条线上**唯一**需要跨过去的东西.放在编译器里,渲染层就
 * 得为了一个类型去 import 编译模块;提到契约层之后,"谁生产 LaTeX"与"谁渲染
 * 一行"之间只剩这份数据形状.
 *
 * 口径:
 * - `kind: 'latex'` 走 KaTeX 排版;
 * - `kind: 'text'` 是纯文本元信息(域/方法/分段/分层这类键值),不套 `\text{}`.
 */

/** 一段可交给 KaTeX 的 LaTeX 源码.是新类型而不是裸 `string`,便于检索与替换. */
export type LatexLine = string;

/**
 * 求值细节的一行:要么是可 KaTeX 排版的公式,要么是**纯文本**元信息.
 *
 * 域/方法/分段/分层这类键值元信息不需要公式排版(KaTeX 里还要套 `\text{}`,
 * 又长又难读),由 UI 直接当文本渲染.
 */
export type EvaluationDetailLine =
    | { kind: 'latex'; latex: LatexLine }
    | { kind: 'text'; text: string };
