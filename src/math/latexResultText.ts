/**
 * 结果数值的屏幕口径(LaTeX 语法):`∫f dx = 数值` 右端那一段.
 *
 * 这里**只有一条口径实例,没有算法**:数值 -> 文本的档位与渲染语法全在库的
 * `numberText`(`miko_ui`)里 -- 定点 6 位去尾零,绝对值超出 `[1e-4, 1e6)` 回退
 * 科学计数法,`'latex'` 语法把 `2.775558e-17` 写成 `2.775558\times10^{-17}`
 * (裸 `e` 会被公式件排成斜体变量,不能原样交给它).
 *
 * 为什么还要留一个模块:同一段口径有两个拼装点 -- 编译期的条目细节
 * (`compiler/dsl/evaluationLatex.ts`)与积分值的异步回填
 * (`ui/evaluation/integralItem.ts`),两处的 `=数值` 必须逐字符相同;实例化一次,
 * 避免"两处各记一套档位".
 *
 * 历史:`src/math/latexNumber.ts` 曾自己实现这套换算,库里
 * `numberText({ syntax: 'latex' })` 落地后整块删除;既有期望值逐条保留在
 * `src/math/paramValue.test.ts` 当漂移哨兵.
 */
import { numberText } from 'miko_ui';

export const LATEX_RESULT_TEXT = numberText({ syntax: 'latex' });
