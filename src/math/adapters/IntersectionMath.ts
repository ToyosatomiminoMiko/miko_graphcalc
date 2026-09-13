/**
 * 求交 TS 适配层.
 *
 * 旧版 IntersectionMath.ts(闭包式 FieldFn/ParamPatch + 逐点 evaluateScalarAt)
 * 已整体移植到 Rust `math_rs::intersection_core`.这里只保留:
 * - SceneObject/静态 transform -> 可序列化描述符的转换;
 * - Worker 返回的扁平数组 -> `Vec3[]`/`Vec3[][]` 的解码.
 *
 * 数值算法,容差与 marching squares 的 Rust 单元测试是权威验证.
 */
import type {
    IntersectionOutput,
    IntersectionTask,
    SceneObject,
    Vec3,
} from '../../compiler/ir/types';
import { NUMERIC_CONFIG } from '../../config/numericConfig';
import { splitCoefficients } from './coefficientUtils';
import {
    flattenOptionalMat4,
    invertMat4,
    type Mat4,
} from '../tensor/rowMajorMatrix';

const SUPPORTED_INTERSECTION_KINDS = new Set<SceneObject['kind']>([
    'curve',
    'surface',
    'sphere',
    'box',
    'conic',
]);

/** 单个求交参与方的可序列化描述符. */
export interface IntersectionComputeSide {
    kind: 'curve' | 'surface' | 'sphere' | 'box' | 'conic';
    expr: string;
    coefficientNames: string[];
    coefficientValues: number[];
    /** 布局见 Rust `intersection_core::ObjectDescriptor`. */
    params: number[];
    /** 扁平 16 个元素;无静态 transform 时为空数组. */
    matrix: number[];
    inverse: number[];
}

/** 一次求交请求(不含 Worker id). */
export interface IntersectionComputeInput {
    a: IntersectionComputeSide;
    b: IntersectionComputeSide;
    segments: number;
}

function curveParams(object: Extract<SceneObject, { kind: 'curve' }>): number[] {
    return [...(object.range ?? NUMERIC_CONFIG.curve.defaultRange)];
}

function surfaceParams(object: Extract<SceneObject, { kind: 'surface' }>): number[] {
    return [...object.range];
}

function sphereParams(
    object: Extract<SceneObject, { kind: 'sphere' }>,
): number[] {
    return [
        object.position.x,
        object.position.y,
        object.position.z,
        object.radius,
    ];
}

function boxParams(object: Extract<SceneObject, { kind: 'box' }>): number[] {
    return [
        object.position.x,
        object.position.y,
        object.position.z,
        object.size[0],
        object.size[1],
        object.size[2],
    ];
}

function conicParams(
    object: Extract<SceneObject, { kind: 'conic' }>,
): number[] {
    return [
        object.position.x,
        object.position.y,
        object.position.z,
        object.baseRadius,
        object.topRadius,
        object.height,
    ];
}

export function describeSide(
    object: SceneObject,
    matrix: Mat4 | null,
    inverse: Mat4 | null,
): IntersectionComputeSide {
    if (!SUPPORTED_INTERSECTION_KINDS.has(object.kind)) {
        throw new Error(`求交不支持对象类型 ${object.kind}`);
    }
    let params: number[] = [];
    switch (object.kind) {
        case 'curve':
            params = curveParams(object);
            break;
        case 'surface':
            params = surfaceParams(object);
            break;
        case 'sphere':
            params = sphereParams(object);
            break;
        case 'box':
            params = boxParams(object);
            break;
        case 'conic':
            params = conicParams(object);
            break;
    }
    const coefficients =
        object.kind === 'curve' || object.kind === 'surface'
            ? object.coefficients
            : [];
    const { names: coefficientNames, values: coefficientValues } =
        splitCoefficients(coefficients);
    return {
        kind: object.kind as IntersectionComputeSide['kind'],
        expr: object.kind === 'curve' || object.kind === 'surface'
            ? object.expr
            : '',
        coefficientNames,
        coefficientValues,
        params,
        matrix: flattenOptionalMat4(matrix),
        inverse: flattenOptionalMat4(inverse),
    };
}

function findObject(
    objects: readonly SceneObject[],
    id: number,
): SceneObject | null {
    return objects.find((object) => object.id === id) ?? null;
}

/**
 * 把编译产出的求交任务转成 Worker 输入.
 *
 * 求交结果是独立求值对象,源对象在渲染层是否隐藏不影响它:隐藏只是
 * "不画这个面",源对象仍参与求交计算,否则单独隐藏一张面会连交线一起消失.
 * 源对象的表达式/系数/几何参数/静态矩阵都进入输入,因此
 * `JSON.stringify(input)` 可以直接作为渲染层的缓存键.
 */
export function buildIntersectionInput(
    task: IntersectionTask,
    objects: readonly SceneObject[],
    transforms: Readonly<Record<number, Mat4>>,
): IntersectionComputeInput | null {
    if (!task.enabled) return null;
    const a = findObject(objects, task.aId);
    const b = findObject(objects, task.bId);
    if (!a || !b) return null;

    const matrixA = transforms[task.aId] ?? null;
    const matrixB = transforms[task.bId] ?? null;
    const inverseA = matrixA ? invertMat4(matrixA) : null;
    const inverseB = matrixB ? invertMat4(matrixB) : null;
    if ((matrixA && !inverseA) || (matrixB && !inverseB)) return null;

    return {
        a: describeSide(a, matrixA, inverseA),
        b: describeSide(b, matrixB, inverseB),
        segments: task.segments,
    };
}

/** 把 Rust 返回的扁平坐标还原成 IR 输出. */
export function decodeIntersectionOutput(
    points: ArrayLike<number>,
    curvePoints: ArrayLike<number>,
    curveOffsets: ArrayLike<number>,
): IntersectionOutput {
    const decodePoints = (raw: ArrayLike<number>): Vec3[] => {
        const result: Vec3[] = [];
        for (let i = 0; i + 2 < raw.length; i += 3) {
            result.push({ x: raw[i], y: raw[i + 1], z: raw[i + 2] });
        }
        return result;
    };

    const curves: Vec3[][] = [];
    for (let i = 0; i + 1 < curveOffsets.length; i += 1) {
        const start = curveOffsets[i] * 3;
        const end = curveOffsets[i + 1] * 3;
        const raw: Vec3[] = [];
        for (let j = start; j + 2 < end; j += 3) {
            raw.push({
                x: curvePoints[j],
                y: curvePoints[j + 1],
                z: curvePoints[j + 2],
            });
        }
        if (raw.length >= 2) curves.push(raw);
    }

    return {
        points: decodePoints(points),
        curves,
    };
}
