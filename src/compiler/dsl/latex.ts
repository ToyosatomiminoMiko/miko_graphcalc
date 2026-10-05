/**
 * SceneIR -> LaTeX 公式的纯函数层.
 *
 * 只消费 IR 里的纯数据,不碰 DOM/Three.js;每个对象返回一段可直接交给
 * KaTeX 的字符串.表达式本体由 Rust/WASM 的 `latex_expression` 生成,
 * 这里只负责补上对象语义(curve 是 y=...,surface 是 z=...,求导对象是
 * d/dx(源函数)=导函数 或 ∂/∂y(源函数)=导函数,region 是不等式带,
 * 积分是 ∫/∬/∭...).
 *
 * 数值本身**不在这里格式化**:区间端点/隐式场 level/积分上下限都经库的
 * `numberText({ syntax: 'latex' })` 实例(`@/math/latexText` 的
 * LATEX_NUMBER_TEXT),否则同一份值会在结果行与上下限里出现两种写法.
 * 这里的字符串拼装只承担"数学语义"(哪个位置放什么),不承担数值口径.
 */
import type {
    AntiderivativeOrigin,
    DerivativeOrigin,
    IntegralTask,
    OdeOrigin,
    SceneObject,
} from '@/contract/ir';
import { LATEX_NUMBER_TEXT } from '@/math/latexText';
import { cachedLatexExpression } from './expression';

/**
 * 求导算子:curve 用常导 d/dx,surface 用偏导 ∂/∂x 或 ∂/∂y.
 *
 * 分母必须带求导变量,否则公式只是无意义的 "d/d";括号里放源函数,使公式
 * 读作"对该函数求导",与 derivative 语句语义一致(见 derivativeBlueprint.ts 的
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
 * 原函数对象的公式:`y = ∫(被积函数) dx + c`(surface 用 `z`,并对 y 积分时写 `dy`).
 *
 * 与 {@link derivativeLatex} 同一套展示契约:保留积分号说明"这条曲线是怎么来的",
 * 右侧给出对象自身的表达式(已把积分常数并入).常数写成 `+ (数值)` 而不是 `+C`:
 * 下发的对象必须可求值,`C` 只是符号通解的一部分,展示层在摘要里保留 `+C`.
 */
function antiderivativeLatex(
    target: 'y' | 'z',
    origin: AntiderivativeOrigin,
    constant: number,
): string {
    const integral = `\\int\\left(${cachedLatexExpression(origin.integrandExpr)}\\right)\\,\\mathrm{d}${origin.variable}`;
    if (constant === 0) {
        return `${target}=${integral}`;
    }
    return `${target}=${integral}+\\left(${LATEX_NUMBER_TEXT.toText(constant)}\\right)`;
}

/**
 * 微分方程对象的公式.
 *
 * - 斜率场(surface,`z = f(x,y)` 的复用):排成 `y' = f(x,y)`,因为对学生来说
 *   这一项的含义是"方程右端",不是一条普通曲面;`z=` 会让"斜率场"这个身份
 *   完全看不出来(设计文档 P1-A 的配色/说明引导就靠这一行文字);
 * - 解曲线:`y = 解式 (特解)` 或 `y = 解式 (C = 数值)`--把常数取值写在括号里,
 *   否则一族曲线在列表里长得一模一样,分不清哪条是哪条.
 */
function odeLatex(target: 'y' | 'z', origin: OdeOrigin, resultExpr: string): string {
    if (origin.role === 'slope') {
        return `y'=${cachedLatexExpression(resultExpr)}`;
    }
    const label = origin.role === 'particular'
        ? '特解'
        : origin.constant === null
            ? '解族'
            : `解族 C=${LATEX_NUMBER_TEXT.toText(origin.constant)}`;
    // 反斜杠必须成对:模板字符串里 `\t` 是制表符,`\r` 是回车,`\quad` 这类
    // 未知转义会把反斜杠吞掉.这一行历史上漏过一层,ODE 解族公式因此在屏幕上
    // 排成 `quadleft(` + TAB + `ext{...}` + 回车 + `ight)`(2026-10 修).
    return `${target}=${cachedLatexExpression(resultExpr)}\\quad\\left(\\text{${label}}\\right)`;
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
                if (object.odeOrigin) {
                    return odeLatex('y', object.odeOrigin, object.expr);
                }
                if (object.antiderivativeOrigin) {
                    return antiderivativeLatex('y', object.antiderivativeOrigin, object.antiderivativeOrigin.constant);
                }
                return object.derivativeOrigin
                    ? derivativeLatex('y', object.derivativeOrigin, object.expr, false)
                    : `y=${cachedLatexExpression(object.expr)}`;
            case 'surface':
                if (object.odeOrigin) {
                    return odeLatex('z', object.odeOrigin, object.expr);
                }
                if (object.antiderivativeOrigin) {
                    return antiderivativeLatex('z', object.antiderivativeOrigin, object.antiderivativeOrigin.constant);
                }
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
                    `,\\quad ${LATEX_NUMBER_TEXT.toText(a)}\\le x\\le ${LATEX_NUMBER_TEXT.toText(b)}`,
                ].join(' ');
            }
            case 'implicit':
                // 隐式场本身就是方程:`f(x,y,z) = level`,左端没有因变量,
                // 不能套 curve/surface 的 `y=` / `z=`.
                return `${cachedLatexExpression(object.expr)}=${LATEX_NUMBER_TEXT.toText(object.level)}`;
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
 * 积分式本体(``∫_a^b f dx`` 这类).
 *
 * **唯一来源**:求值条目列表的摘要与细节(`evaluationLatex.ts` 的
 * `integralLatexSummary` / `integralLatexDetailEntries`)都调它,所以折叠态
 * 与展开态不可能给出两个版本的积分式.编译器不再另算一份存进 IR--
 * 2026-10 删掉的 `SceneIR.integralFormulas` 就是那个第二来源:只被测试读,
 * 却每次编译都真跑一遍 LaTeX 拼装.
 *
 * 只返回 LaTeX 正文(不含方法名,方法名由 UI 拼在公式后面);找不到被积对象
 * 或域种类异常时返回 null,由 UI 回退到文字摘要.域维度与形状由 task 的显式
 * `dim`/`domainKind` 决定,不再靠 range 长度猜测.
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
                `\\int_{${LATEX_NUMBER_TEXT.toText(a)}}^{${LATEX_NUMBER_TEXT.toText(b)}}`,
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
                `\\int_{${LATEX_NUMBER_TEXT.toText(xa)}}^{${LATEX_NUMBER_TEXT.toText(xb)}}`,
                `\\int_{${LATEX_NUMBER_TEXT.toText(ya)}}^{${LATEX_NUMBER_TEXT.toText(yb)}}`,
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
