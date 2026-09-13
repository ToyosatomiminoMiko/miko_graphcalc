/**
 * 求值对象(分析/积分/求交)列表条目的 LaTeX 拼装.
 *
 * 与 latex.ts 的分工:latex.ts 负责**实体对象**(curve/surface/... 的方程)
 * 与积分式本体,本文件负责**求值条目**的两段展示--
 * - 摘要(summary):默认可见的一行,只放关键量(`∇f(P) = ...`);
 * - 细节(details):展开后才排版的完整推导/数值(`P=(...)`,球坐标回显,
 *   逐分量结果,方法的完整积分式...).
 *
 * 纯函数,只消费 IR,不碰 DOM:这样摘要/细节两套公式能单测,渲染层
 * (ui/ObjectListController)只负责把字符串交给 KaTeX.细节行按"一行一条"
 * 返回,列表里一行排不下时由 CSS 横向滚动承接(KaTeX 不换行,这是屏上
 * 唯一不破坏公式语义的溢出处理).
 *
 * 折叠态是否给数值是**有意按算子区分**的(见 UI-P3.13):需要展开才能读到
 * 推导过程的(梯度,积分)只给算子/积分式的书写形式,数值留在细节行;
 * 没有中间步骤可看的(散度,旋度)直接把结果排进摘要.同一列表里两类条目
 * 折叠态的信息量因此不同,这是设计选择而不是漏排.
 */
import type { AnalysisResult, IntegralTask, SceneObject } from '../ir/types';
import { latexResultNumber } from '../../math/latexNumber';
import { integralBodyLatex, latexNumberText } from './latex';

/** 一行公式片段(LaTeX 字符串). */
export type LatexLine = string;

/**
 * 积分式本体(``∫_a^b f dx``),再导出给 UI:积分条目的摘要排版它,数值回填后
 * 把 `=数值` 接在同一个字符串上,保证摘要与细节两处公式同源.
 */
export { integralBodyLatex };

/** 数值数组 -> LaTeX 行向量 `\left(1, 2, 3\right)`. */
function vectorLatex(values: readonly number[]): string {
    return `\\left(${values.map((value) => latexNumberText(value)).join(',\\ ')}\\right)`;
}

/**
 * 分析结果摘要:默认可见的一行.
 *
 * 只给"哪个算子在哪个点":数值放到展开细节里,同一行不重复出现算子与结果.
 * 标量场梯度在 `symbolic` 里带符号定义 `∇f = (f_x, f_y, f_z)`,点代入该
 * 定义后就是细节里的中间步骤.
 */
export function analysisLatexSummary(analysis: AnalysisResult): LatexLine {
    const point = vectorLatex(analysis.point);
    switch (analysis.op) {
        case 'gradient':
            return `\\nabla f\\left(${point}\\right)`;
        case 'divergence':
            return `\\nabla\\cdot\\mathbf{F}\\left(${point}\\right)=${latexNumberText(analysis.scalar ?? NaN)}`;
        case 'curl':
            return `\\nabla\\times\\mathbf{F}\\left(${point}\\right)=${vectorLatex(analysis.vector)}`;
    }
}

/**
 * 分析结果细节:展开后逐行排版,按"先算子的符号展开,再该点的数值"排列.
 *
 * 梯度(与求导对象同一个展示契约:先给算子公式,再给结果):
 * 1. `∇f = (f_x, f_y, f_z)`(符号定义,保持系数符号);
 * 2. `∇f(P) = (数值, ...)`;
 * 3. `P = (...)`,球坐标回显 `(r, θ, φ)`,`f(P)`,切线 `T`.
 *
 * 散度/旋度没有逐分量符号表达式(IR 不保存向量场分量的符号式),因此只给
 * 数值结果行,不编造中间步骤.
 */
export function analysisLatexDetails(analysis: AnalysisResult): EvaluationDetailLine[] {
    const lines: LatexLine[] = [];

    if (analysis.symbolic) {
        lines.push(analysis.symbolic);
    }

    if (analysis.op === 'gradient') {
        lines.push(`\\nabla f\\left(P\\right)=${vectorLatex(analysis.vector)}`);
    } else if (analysis.op === 'divergence') {
        lines.push(
            `\\left(\\nabla\\cdot\\mathbf{F}\\right)\\left(P\\right)=${latexNumberText(analysis.scalar ?? NaN)}`,
        );
    } else {
        lines.push(
            `\\left(\\nabla\\times\\mathbf{F}\\right)\\left(P\\right)=${vectorLatex(analysis.vector)}`,
        );
    }

    lines.push(`P=${vectorLatex(analysis.point)}`);

    // 球坐标回显:与 at spherical 共用同一份约定(见 math/CoordinateSystem.ts).
    if (analysis.pointSpherical) {
        lines.push(
            `\\left(r,\\theta,\\varphi\\right)=${vectorLatex(analysis.pointSpherical)}`,
        );
    }

    if (analysis.op === 'gradient') {
        if (analysis.scalar !== null) {
            lines.push(`f\\left(P\\right)=${latexNumberText(analysis.scalar)}`);
        }
        if (analysis.tangent) {
            lines.push(`\\mathbf{T}=${vectorLatex(analysis.tangent)}`);
        }
    }

    return lines.map((latex) => ({ kind: 'latex', latex }));
}

/**
 * 积分结果摘要:默认可见的一行.
 *
 * 只给积分式本身(不接 `=`):与梯度条目同一条约定--折叠态是算子的书写形式,
 * 数值结果由 setIntegralResult 排版成完整等式,展开细节里再出现一次完整
 * 等式,避免同一个 `∫f dx =` 在摘要与细节里重复两遍.
 *
 * 找不到被积对象时返回 null,调用方回退到纯文本摘要.
 */
export function integralLatexSummary(
    task: IntegralTask,
    objects: readonly SceneObject[],
): LatexLine | null {
    return integralBodyLatex(task, objects);
}

/**
 * 求值细节的一行:要么是可 KaTeX 排版的公式,要么是**纯文本**元信息.
 *
 * 域/方法/分段/分层这类键值元信息不需要公式排版(KaTeX 里还要套 `\text{}`,
 * 又长又难读),由 UI 直接当文本渲染.
 */
export type EvaluationDetailLine =
    | { kind: 'latex'; latex: LatexLine }
    | { kind: 'text'; text: string };

/**
 * 积分结果细节:展开后逐行排版.
 *
 * - 第一行是**完整等式**(积分式 = 数值),与结果行同一个公式;数值尚未回填时
 *   省略等号右侧;
 * - 其后的域对象 / 方法 / 分段 / 分层是纯文本元信息,不走 KaTeX.
 */
export function integralLatexDetails(
    task: IntegralTask,
    objects: readonly SceneObject[],
    methodLabel: string,
    result: number | null = null,
): EvaluationDetailLine[] {
    const lines: EvaluationDetailLine[] = [];
    const body = integralBodyLatex(task, objects);
    if (body !== null) {
        lines.push({
            kind: 'latex',
            latex: result === null ? body : `${body}=${latexResultNumber(result)}`,
        });
    }
    const source = objects.find((object) => object.id === task.objectId);
    const domain = source ? source.name : `#${task.objectId}`;
    lines.push({ kind: 'text', text: `域: ${domain} · 方法: ${methodLabel}` });
    lines.push({ kind: 'text', text: `分段: ${task.segments} · 分层: ${task.layers}` });
    return lines;
}

/**
 * 求交任务的最小形状.
 *
 * 直接收 `IntersectionTask` 会让本模块也依赖 `IntersectionOutput`(异步结果),
 * 而这里只用到任务本身的标识字段;用结构类型表述真实依赖,便于单测少造数据.
 */
export interface IntersectionTaskLike {
    name: string;
    aName: string;
    bName: string;
    aId: number;
    bId: number;
    segments: number;
}

/**
 * 求交结果摘要:默认可见的一行.
 *
 * 求交是异步任务,首次渲染时还没有交点/交线数量,所以摘要只给"谁与谁求交";
 * 数量摘要沿用既有纯文本(见 ui/evaluation/intersectionRow.ts 的
 * `intersectionSummary`),细节行给出两个源对象,采样分段与输出形态.
 */
export function intersectionLatexSummary(task: IntersectionTaskLike): LatexLine {
    return `${task.aName}\\cap ${task.bName}`;
}

/** 求交细节行:对象,分辨率与输出形态. */
export function intersectionLatexDetails(task: IntersectionTaskLike): EvaluationDetailLine[] {
    return [
        {
            kind: 'latex',
            latex: `A=${task.aName}\\ \\left(\\#${task.aId}\\right)`
                + `\\quad B=${task.bName}\\ \\left(\\#${task.bId}\\right)`,
        },
        { kind: 'text', text: `采样分段: ${task.segments}` },
    ];
}
