/**
 * 公式里数值/向量的屏幕口径(LaTeX 语法):应用侧**唯一**的口径实例.
 *
 * 这里**只有实例,没有算法**:值 -> 文本的档位(定点 6 位去尾零,绝对值超出
 * `[1e-4, 1e6)` 回退科学计数法)与渲染语法全在库的 `numberText`(`miko_ui`)里;
 * `'latex'` 语法把 `2.775558e-17` 写成 `2.775558\times10^{-17}`(裸 `e` 会被
 * 公式件排成斜体变量,不能原样交给它).向量同理:`numberVectorText` 逐元素走
 * 同一档位,括号与分隔符是它的选项.
 *
 * 为什么实例必须集中在一处:同一个数值在公式里有多个拼装点(对象公式里的
 * 区间端点/隐式场 level/积分上下限,求值条目的数值结果,积分值的异步回填),
 * 这些文本必须逐字符相同.每处各 `numberText({...})` 一次就是"两处各记一套
 * 档位"--历史上 `src/math/latexNumber.ts` 正是为了这套换算自己实现了一遍,
 * 那个文件已删除,既有期望值逐条保留在 `src/math/paramValue.test.ts` 当漂移
 * 哨兵.
 *
 * 元信息:2026-10 由 `latexResultText.ts` 更名而来.它不再只服务"结果":
 * 对象公式里的字面量(区域端点,隐式场 level,积分上下限)也走这里,所以名字
 * 不能再叫 RESULT.
 */
import { numberText, numberVectorText } from 'miko_ui';

/** 单个数值 -> LaTeX. */
export const LATEX_NUMBER_TEXT = numberText({ syntax: 'latex' });

/**
 * 数值数组 -> LaTeX 行向量 `\left(1,\ 2,\ 3\right)`.
 *
 * 括号用 `\left(` / `\right)`:KaTeX 按内容自动定高,分量里出现分数或指数时
 * 不会顶出括号.分隔符是 `,\ ` 而不是库默认的 `, `:公式里逗号后的空白要显式
 * 给(`\,`),否则 KaTeX 会把逗号与后一个分量挤在一起.
 */
export const LATEX_VECTOR_TEXT = numberVectorText({
    syntax: 'latex',
    bracket: ['\\left(', '\\right)'],
    separator: ',\\ ',
});
