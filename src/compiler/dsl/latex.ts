/**
 * SceneIR -> LaTeX 公式的纯函数层.
 *
 * 只消费 IR 里的纯数据,不碰 DOM/Three.js;每个对象返回一段可直接交给
 * KaTeX 的字符串.表达式本体由 Rust/WASM 的 `latex_expression` 生成,
 * 这里只负责补上对象语义(curve 是 y=...,surface 是 z=...,求导对象是
 * d/dx(源函数)=导函数 或 ∂/∂y(源函数)=导函数,region 是不等式带,
 * 积分是 ∫/∬/∭...).
 */
import type { DerivativeOrigin, IntegralTask, SceneObject } from '../ir/types';
import { cachedLatexExpression } from './expression';

function latexNumber(value: number): string {
    if (!Number.isFinite(value)) return String(value);
    return String(value);
}

/** 数值 -> LaTeX 数字(供求值结果公式复用;与 latexNumber 同口径). */
export function latexNumberText(value: number): string {
    return latexNumber(value);
}

/**
 * 求导算子:curve 用常导 d/dx,surface 用偏导 ∂/∂x 或 ∂/∂y.
 *
 * 分母必须带求导变量,否则公式只是无意义的 "d/d";括号里放源函数,使公式
 * 读作"对该函数求导",与 derivative 语句语义一致(见 staticScene.ts 的
 * buildDerivativeObjectBlueprint).
 */
function derivativeOperatorLatex(origin: DerivativeOrigin, partial: boolean): string {
    // \partial 是控制词,后面必须留空格,否则会被读成 \partialx 这类未定义命令;
    // \mathrm{d} 自带花括号,直接接变量即可.
    return partial
        ? `\\frac{\\partial}{\\partial ${origin.variable}}`
        : `\\frac{\\mathrm{d}}{\\mathrm{d}${origin.variable}}`;
}

/**
 * 求导对象的公式:curve 是 y=...,surface 是 z=...;括号里放源函数.
 *
 * 公式同时给出两边信息,缺一不可:
 * - 左边 `d/dx(源函数)` 说明"对谁求导"(与 derivative 语句语义一致);
 * - 右边 `=导函数` 是符号引擎算出的结果(对象自身的 expr).
 * 只留算子会丢掉求导结果,只留结果又看不出这是求导对象.
 */
function derivativeLatex(
    target: 'y' | 'z',
    origin: DerivativeOrigin,
    resultExpr: string,
    partial: boolean,
): string {
    return [
        `${target}=`,
        derivativeOperatorLatex(origin, partial),
        `\\left(${cachedLatexExpression(origin.sourceExpr)}\\right)`,
        `=${cachedLatexExpression(resultExpr)}`,
    ].join('');
}

/**
 * 实体对象表达式行对应的 LaTeX.
 *
 * 目前只对真正"携带表达式/可展示"的对象生成公式:
 * - curve / surface:标量函数;若带 derivativeOrigin 则写成
 *   微分算子(源函数)=导函数;
 * - vector_field / point / vector:数组/向量;
 * - region:两条边界曲线围成的 x 型带状不等式 + x 区间;
 * - 体积对象(sphere/box/conic)在 IR 中只有数值化后的几何参数,
 *   继续使用 ObjectListController 里的纯文本摘要,避免给出误导性方程.
 *
 * region 需要按名解析边界曲线,因此额外接收 `objectsByName` 解析器.
 */
export function sceneObjectLatex(
    object: SceneObject,
    objectsByName: Map<string, SceneObject> = new Map(),
): string | null {
    try {
        switch (object.kind) {
            case 'curve':
                return object.derivativeOrigin
                    ? derivativeLatex('y', object.derivativeOrigin, object.expr, false)
                    : `y=${cachedLatexExpression(object.expr)}`;
            case 'surface':
                return object.derivativeOrigin
                    ? derivativeLatex('z', object.derivativeOrigin, object.expr, true)
                    : `z=${cachedLatexExpression(object.expr)}`;
            case 'vector_field': {
                const components = object.components
                    .map((component) => cachedLatexExpression(component))
                    .join(',\\ ');
                // 由隐式场求导得到的向量场是 ∇f:公式要保留梯度算子,括号里
                // 放源标量场,等号右侧是三分量(与 derivativeLatex 同款契约).
                if (object.gradientOrigin) {
                    return [
                        '\\mathbf{F}=\\nabla\\left(',
                        cachedLatexExpression(object.gradientOrigin.sourceExpr),
                        '\\right)=\\left(',
                        components,
                        '\\right)',
                    ].join('');
                }
                return `\\mathbf{F}\\left(x,y,z\\right)=\\left(${components}\\right)`;
            }
            case 'point':
            case 'vector':
                // point/vector 的 expr 是 `[x, y, z]` / `[[起点], [方向]]`,
                // Rust 打印器会把嵌套数组也转成 LaTeX,保留原始符号参数.
                return cachedLatexExpression(object.expr);
            case 'region': {
                const curveA = objectsByName.get(object.curveAName);
                const curveB = objectsByName.get(object.curveBName);
                if (!curveA || !curveB || curveA.kind !== 'curve' || curveB.kind !== 'curve') {
                    return null;
                }
                const [a, b] = object.range;
                const fA = cachedLatexExpression(curveA.expr);
                const fB = cachedLatexExpression(curveB.expr);
                // min/max 语义在数值侧统一取;公式展示两条边界曲线的次序.
                return [
                    fA,
                    `\\le y\\le`,
                    fB,
                    `,\\quad ${latexNumber(a)}\\le x\\le ${latexNumber(b)}`,
                ].join(' ');
            }
            case 'implicit':
                // 隐式场本身就是方程:`f(x,y,z) = level`,左端没有因变量,
                // 不能套 curve/surface 的 `y=` / `z=`.
                return `${cachedLatexExpression(object.expr)}=${latexNumber(object.level)}`;
            case 'sphere':
            case 'box':
            case 'conic':
                return null;
        }
    } catch {
        // DSL 编译阶段已经校验过表达式;这里只做展示,失败时回退纯文本.
        return null;
    }
}

/**
 * 积分任务的积分式(不含方法名,方法名由 UI 拼在公式后面).
 *
 * 只返回 LaTeX 正文;找不到被积对象/域种类异常时返回 null,由 UI 回退到
 * 文字摘要.域维度与形状由 task 的显式 `dim`/`domainKind` 决定,不再靠
 * range 长度猜测.
 */
export function integralLatex(
    task: IntegralTask,
    objects: readonly SceneObject[],
): string | null {
    return integralBodyLatex(task, objects);
}

/**
 * 积分式本体(``∫_a^b f dx`` 这类),供两处复用:
 * - 实体列表的积分条目公式(本文件 `integralLatex`);
 * - 求值对象的列表条目(ui/ObjectListController 展开细节里的完整公式).
 *
 * 两处必须同源,否则展开前后会给出两个不同版本的积分式.
 */
export function integralBodyLatex(
    task: IntegralTask,
    objects: readonly SceneObject[],
): string | null {
    try {
        const source = objects.find((object) => object.id === task.objectId);
        if (!source) return null;
        const integrand = cachedLatexExpression(task.integrand);

        if (task.domainKind === 'interval' && task.range) {
            const [a, b] = task.range as [number, number];
            return [
                `\\int_{${latexNumber(a)}}^{${latexNumber(b)}}`,
                integrand,
                '\\mathrm{d}x',
            ].join(' ');
        }

        if (task.domainKind === 'rectangle' && task.range) {
            const [xa, xb, ya, yb] = task.range as [
                number,
                number,
                number,
                number,
            ];
            return [
                `\\int_{${latexNumber(xa)}}^{${latexNumber(xb)}}`,
                `\\int_{${latexNumber(ya)}}^{${latexNumber(yb)}}`,
                integrand,
                '\\mathrm{d}y\\,\\mathrm{d}x',
            ].join(' ');
        }

        if (task.domainKind === 'region') {
            const domain = source.name ?? `D`;
            return [
                `\\iint_{${domain}}`,
                integrand,
                '\\,\\mathrm{d}A',
            ].join(' ');
        }

        if (task.domainKind === 'solid') {
            const domain = source.name ?? `V`;
            return [
                `\\iiint_{${domain}}`,
                integrand,
                '\\,\\mathrm{d}V',
            ].join(' ');
        }

        return null;
    } catch {
        return null;
    }
}
