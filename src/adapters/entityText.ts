/**
 * 实体条目的文案:类型标签与表达式摘要.
 *
 * 从 `ObjectListController` 搬出来的纯函数,只依赖 IR(`SceneObject`)与数字排版
 * (`numberText`):实体行结构在 `EntityItem`,这里只管"这一条显示成什么字".
 */
import type { SceneObject } from '@/contract/ir';
import { formatNumber, formatVector } from '@miko/ui';

const ENTITY_KIND_LABELS: Record<SceneObject['kind'], string> = {
    curve: '曲线',
    surface: '曲面',
    vector_field: '向量场',
    point: '点',
    vector: '向量',
    sphere: '球体',
    box: '方块',
    conic: '旋转体',
    region: '区域',
    implicit: '隐式场',
};

/** 旋转体的 UI 名称由实际上下底半径推出,而不是按 DSL 关键字固定. */
export function sceneObjectKindLabel(object: SceneObject): string {
    if (object.kind !== 'conic') {
        return ENTITY_KIND_LABELS[object.kind];
    }
    // 上下底都为 0 是退化体,既不是圆柱也不是圆锥,回退到通用名.
    if (object.baseRadius < 1e-9 && object.topRadius < 1e-9) {
        return ENTITY_KIND_LABELS.conic;
    }
    if (Math.abs(object.topRadius - object.baseRadius) < 1e-9) {
        return '圆柱';
    }
    if (object.topRadius < 1e-9) {
        return '圆锥';
    }
    return '圆台';
}

/** 实体表达式摘要(公式排不出来时的纯文本回退,见 `EntityItem`). */
export function sceneObjectExpression(object: SceneObject): string {
    switch (object.kind) {
        case 'curve':
        case 'surface':
            return object.expr;
        case 'vector_field':
            return `[${object.components.join(', ')}]`;
        case 'point':
        case 'vector':
            return object.expr;
        case 'sphere':
            return `中心=${formatVector([object.position.x, object.position.y, object.position.z])} · r=${formatNumber(object.radius)}`;
        case 'box':
            return `中心=${formatVector([object.position.x, object.position.y, object.position.z])} · size=${formatVector(object.size)}`;
        case 'conic':
            return `中心=${formatVector([object.position.x, object.position.y, object.position.z])} · base=${formatNumber(object.baseRadius)} · top=${formatNumber(object.topRadius)} · h=${formatNumber(object.height)}`;
        case 'region':
            return `边界=${object.curveAName}, ${object.curveBName} · x∈[${formatNumber(object.range[0])}, ${formatNumber(object.range[1])}]`;
        case 'implicit':
            // V1 只有方程本体,没有自有网格;摘要直接给 `f = level`.
            return `${object.expr} = ${formatNumber(object.level)} · ${object.dim}D`;
    }
}
