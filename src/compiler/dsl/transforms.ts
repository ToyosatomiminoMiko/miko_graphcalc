/**
 * 场景矩阵与变换解析.
 *
 * 矩阵语法解析与常量求值由 Rust/WASM 完成;这里只负责把扁平的 16 个
 * 数值重新组织为 Mat4,并解析 DSL 的 transform 组合语法.
 *
 * ## 变换表达式语法表(202609 review 收敛结论)
 *
 * 三种语境原先各自写了一份"as_transform/裸名/函数"查找逻辑,允许的引用面
 * 还互相矛盾(对象选项只认 transform,动画却 matrix 优先,transform 声明体
 * 又不能引用其他 transform).现收敛为"一个矩阵因子 + 语境限制":
 *
 *   矩阵因子 := fn_call | as_transform(NAME) | NAME
 *     fn_call          translate([x,y,z]) | rotate([x,y,z]) | scale([x,y,z]),
 *                      参数为常量表达式,经 evaluateNumber 求值;
 *     as_transform(NAME) 显式引用 matrix 声明(与同名 transform 区分);
 *     NAME             裸名引用,解析顺序固定 matrix 优先,transform 次之.
 *
 *   语境:
 *     - tensor transform 声明体(parseTransformExpression):因子可用 '*'
 *       组合;列向量约定 M*v 下最左因子先作用于几何(与既有乘法次序一致).
 *       组合内允许引用"已声明过的" matrix/transform(按声明顺序解析);
 *     - animation 表达式(parseSingleTransformExpression):只允许单个因子;
 *       组合请拆成多个 animation 按序引用(见 staticScene 校验);
 *     - 对象 transform 选项(resolveObjectTransform):只允许单个"命名"引用
 *       (不接受就地函数构造),语义是引用一份已声明的姿态.
 *
 * 这样同一份引用解析不存在第二个实现,语境差异只剩"能否组合/能否用函数".
 */
import type { MatrixOps } from '../../math/tensor/SceneTransform';
import {
    cloneMat4,
    mat4FromFlat,
    type Mat4,
} from '../../math/tensor/rowMajorMatrix';
import { evaluateMatrixExpr, evaluateNumber } from './expression';
import { splitTopLevel } from '../text';

export function evaluateMatrix(raw: string): Mat4 | null {
    try {
        return mat4FromFlat(evaluateMatrixExpr(raw));
    } catch {
        return null;
    }
}

/** 解析 `as_transform(M)` 形式并返回引用的名称;其他写法返回 null. */
function asTransformReference(expression: string): string | null {
    const match = /^as_transform\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)$/.exec(expression);
    return match?.[1] ?? null;
}

/** 裸名引用的标识符形态. */
function isIdentifier(expression: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(expression);
}

/**
 * 命名引用解析的唯一入口:
 * - as_transform(NAME) 只查 matrix 声明;
 * - 裸名按 matrix 优先,transform 次之的顺序解析(三种语境统一,不再倒挂).
 * 查不到时返回 null,由调用方决定报错文案.
 */
function resolveNamedReference(
    expression: string,
    matrices: Map<string, Mat4>,
    transforms: Map<string, Mat4>,
): Mat4 | null {
    const matrixName = asTransformReference(expression);
    if (matrixName !== null) {
        const matrix = matrices.get(matrixName);
        return matrix ? cloneMat4(matrix) : null;
    }
    if (isIdentifier(expression)) {
        const matrix = matrices.get(expression);
        if (matrix) return cloneMat4(matrix);
        const transform = transforms.get(expression);
        if (transform) return cloneMat4(transform);
    }
    return null;
}

function parseTransformFunction(part: string, ops: MatrixOps): Mat4 | null {
    const match = /^(translate|scale|rotate)\s*\(\s*\[([^\]]*)\]\s*\)$/.exec(part);
    if (!match) return null;

    const values = match[2].split(',').map((item) => evaluateNumber(item.trim()));
    if (values.some((value) => value === null) || values.length !== 3) return null;
    const numbers = values as number[];

    switch (match[1]) {
        case 'translate':
            return ops.translate(numbers);
        case 'scale':
            return ops.scale(numbers);
        case 'rotate':
            return ops.rotate(numbers);
        default:
            return null;
    }
}

/** 单个矩阵因子:fn_call 或命名引用(见文件头语法表). */
function parseTransformFactor(
    part: string,
    matrices: Map<string, Mat4>,
    transforms: Map<string, Mat4>,
    ops: MatrixOps,
): Mat4 | null {
    return parseTransformFunction(part, ops) ?? resolveNamedReference(part, matrices, transforms);
}

/**
 * 解析 transform 声明体:因子链(可为单个因子).
 * 组合引用按声明顺序解析,因此只能引用已声明过的 matrix/transform
 * (staticScene 按语句顺序边解析边写入 transforms 表).
 */
export function parseTransformExpression(
    raw: string,
    matrices: Map<string, Mat4>,
    transforms: Map<string, Mat4>,
    ops: MatrixOps,
): Mat4 | null {
    const expression = raw.trim();
    const parts = splitTopLevel(expression, '*').map((part) => part.trim());
    if (parts.length === 0 || parts.some((part) => part.length === 0)) {
        return null;
    }

    let result = ops.identity();
    for (const part of parts) {
        const matrix = parseTransformFactor(part, matrices, transforms, ops);
        if (!matrix) return null;
        result = ops.multiply(result, matrix);
    }
    return result;
}

/**
 * 解析单个动画变换:只接受"一个矩阵因子",不接受 `*` 组合
 * (复杂动画应由多个 animation 声明按顺序引用,见文件头语法表).
 */
export function parseSingleTransformExpression(
    raw: string,
    matrices: Map<string, Mat4>,
    transforms: Map<string, Mat4>,
    ops: MatrixOps,
): Mat4 | null {
    const expression = raw.trim();
    const parts = splitTopLevel(expression, '*').map((part) => part.trim());
    if (parts.length !== 1 || parts[0].length === 0) return null;
    return parseTransformFactor(parts[0], matrices, transforms, ops);
}

/**
 * 解析对象 transform 选项:只允许单个"命名"引用(见文件头语法表).
 * 引用未声明的名字必须抛错--对象选项静默忽略"写错名字"会画出一个没有
 * 姿态的物体,违背 DSL 的严格失败原则.
 */
export function resolveObjectTransform(
    raw: string | undefined,
    transforms: Map<string, Mat4>,
    matrices: Map<string, Mat4>,
): Mat4 | null {
    if (!raw) return null;
    const reference = resolveNamedReference(raw.trim(), matrices, transforms);
    if (reference) return reference;
    throw new Error(`对象 transform 引用了不存在的矩阵或变换 ${raw.trim()}`);
}
