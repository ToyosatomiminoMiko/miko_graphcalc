/**
 * 静态场景的**声明级收集**passes:matrix / transform / animation 三类语句求值,
 * 以及对象名索引与 animation 选项解析.
 *
 * 从 staticScene.ts 拆出:这些 pass 只做"语句 -> 命名表"的登记与校验,不碰
 * blueprint,也不消费 params,与静态场景的蓝图建模是两件事;放在同一文件里
 * 会让 buildStaticScene 被三段循环淹没(见 staticScene.ts 文件头).
 *
 * 处理顺序有语义(由 staticScene.ts 依次调用):
 * 1. `collectTensorDeclarations`:matrix 先全部求值;
 * 2. `collectTransformDeclarations`:transform 按声明顺序边解析边写入,
 *    因此可引用此前已声明的 matrix/transform(见 transforms.ts 语法表);
 * 3. `collectAnimationDeclarations`:animation 引用上面两张表,单矩阵限制与
 *    duration 正数校验在这里完成.
 */
import type { AstProgram, ObjectStatement } from '@/contract/ast';
import type { AnimationClip } from '@/contract/ir';
import { type Mat4 } from '@/math/matrix/rowMajorMatrix';
import type { MatrixOps } from '@/math/matrix/MatrixOps';
import { withStatementSpan } from '@/compiler/errors';
import { assertKnownOptions, findOption, toFiniteNumber } from './options';
import {
    evaluateMatrix,
    parseSingleTransformExpression,
    parseTransformExpression,
} from './transforms';

/**
 * 场景对象声明按名索引.
 *
 * region 按名引用两条边界 curve,允许引用声明在区域之后的对象,
 * 因此必须先建这份 名字 -> ObjectStatement 的索引(编译期与运行时的 region
 * 校验共用,避免各写一遍遍历).
 */
export function objectStatementsByName(ast: AstProgram): Map<string, ObjectStatement> {
    const map = new Map<string, ObjectStatement>();
    for (const statement of ast.statements) {
        if (statement.type !== 'object' || statement.name === undefined) continue;
        map.set(statement.name, statement);
    }
    return map;
}

/**
 * 所有"已声明的值名" -> 类型说明(供对象相加的引用解析报错).
 *
 * 对象相加的引用解析用它把"引用了一个不是 curve/surface 的已声明名字"
 * 识别成错误,而不是当成自由参数凭空多出一个滑块(见 objects/references.ts).
 * 说明文字进报错文案:`sphere 对象` 与 `derivative 产物` 对用户是两种不同的
 * 误解,分开写才能给出可操作的提示.
 *
 * param 不在此列(参数名在引用解析里优先,保持既有语义);
 * matrix/transform/animation 也不参与函数表达式,同样不计入.
 */
export function collectDeclaredValueNames(ast: AstProgram): Map<string, string> {
    const names = new Map<string, string>();
    for (const statement of ast.statements) {
        switch (statement.type) {
            case 'object':
                names.set(statement.name, `${statement.kind} 对象`);
                break;
            case 'derivative':
                names.set(statement.name, 'derivative 产物');
                break;
            case 'antiderivative':
                names.set(statement.name, 'antiderivative 产物');
                break;
            case 'ode':
                names.set(statement.name, '微分方程产物');
                break;
            case 'analysis':
                names.set(statement.name, '分析产物');
                break;
            case 'integral':
                names.set(statement.name, '积分产物');
                break;
            case 'intersection':
                names.set(statement.name, '求交产物');
                break;
            default:
                break;
        }
    }
    return names;
}

/** matrix 声明:求值进 `matrices`(标量/向量声明尚未实现,照旧报错). */
export function collectTensorDeclarations(
    ast: AstProgram,
    matrices: Map<string, Mat4>,
): void {
    for (const statement of ast.statements) {
        if (statement.type !== 'tensor') continue;
        // 语句级错误定位:tensor 声明校验失败时携带本语句 span.
        withStatementSpan(statement.span, () => {
            if (statement.kind === 'matrix') {
                const matrix = evaluateMatrix(statement.expr);
                if (matrix) matrices.set(statement.name, matrix);
                else throw new Error(`矩阵 ${statement.name} 无法求值`);
            } else if (statement.kind === 'scalar') {
                throw new Error(`标量声明 ${statement.name} 暂未实现`);
            } else if (statement.kind === 'vector') {
                throw new Error(`向量声明 ${statement.name} 暂未实现`);
            }
            // transform 语句在下一轮单独处理.
        });
    }
}

/** transform 声明:按声明顺序解析,可引用此前已声明的 matrix/transform. */
export function collectTransformDeclarations(
    ast: AstProgram,
    matrices: Map<string, Mat4>,
    transforms: Map<string, Mat4>,
    matrixOps: MatrixOps,
): void {
    for (const statement of ast.statements) {
        if (statement.type !== 'tensor' || statement.kind !== 'transform') continue;
        withStatementSpan(statement.span, () => {
            // transforms 表按声明顺序边解析边写入,因此 transform 声明体可以
            // 引用"此前已声明"的 matrix/transform(见 transforms.ts 语法表).
            const transform = parseTransformExpression(
                statement.expr,
                matrices,
                transforms,
                matrixOps,
            );
            if (transform) transforms.set(statement.name, transform);
            else throw new Error(`变换 ${statement.name} 无法求值`);
        });
    }
}

/** animation 声明:单矩阵 + 正 duration,登记进 `animations`. */
export function collectAnimationDeclarations(
    ast: AstProgram,
    matrices: Map<string, Mat4>,
    transforms: Map<string, Mat4>,
    matrixOps: MatrixOps,
    animations: Map<string, AnimationClip>,
): void {
    for (const statement of ast.statements) {
        if (statement.type !== 'animation') continue;
        withStatementSpan(statement.span, () => {
            if (animations.has(statement.name)) {
                throw new Error(`动画 ${statement.name} 重复声明`);
            }

            assertKnownOptions(statement.options, ['duration'], `动画 ${statement.name}`);
            const matrix = parseSingleTransformExpression(
                statement.expr,
                matrices,
                transforms,
                matrixOps,
            );
            if (!matrix) {
                throw new Error(`动画 ${statement.name} 只能包含一个矩阵变换`);
            }

            const duration = toFiniteNumber(
                findOption(statement.options, 'duration') ?? '',
                `动画 ${statement.name} 的 duration`,
            );
            if (duration <= 0) {
                throw new Error(`动画 ${statement.name} 的 duration 必须大于 0`);
            }

            animations.set(statement.name, {
                name: statement.name,
                duration,
                matrix,
            });
        });
    }
}

/**
 * 对象的 `animation = [a, b]` 选项 -> 动画名列表.
 *
 * 接受单个名字或方括号列表;空串/缺省得到空列表.名字先做标识符校验,
 * "引用了不存在的动画"由调用方在 `animations` 表上另行判定.
 */
export function parseAnimationNames(raw: string | undefined, context: string): string[] {
    if (raw === undefined) return [];

    const body = raw.trim();
    if (body.length === 0) return [];

    if (body.startsWith('[') || body.endsWith(']')) {
        const inner = body.slice(1, -1).trim();
        if (inner.length === 0) return [];
        const names = inner.split(',').map((item) => item.trim());
        if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
            throw new Error(`${context} 包含无效动画名: ${raw}`);
        }
        return names;
    }

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(body)) {
        throw new Error(`${context} 包含无效动画名: ${raw}`);
    }
    return [body];
}
