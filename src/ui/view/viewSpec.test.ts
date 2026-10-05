/**
 * 视图窗口元素清单的守卫.
 *
 * `viewSpec.ts` 是"视图窗口里有什么"的唯一处,但它是**数据**,不是代码路径:
 * 写错一个状态键,少写一行,或者某个 `ViewState` 字段加了却没人绑,光看清单
 * 看不出来.这里把三件事变成会红的测试:
 *
 * 1. **错键**:清单里的每个键都得是 `ViewState` 真有的字段.键的类型来自
 *    `keyof ViewState`,所以打错字本来就编译不过;这一条守的是"自定义行"里那份
 *    `keys`(它是 `readonly ViewStateKey[]`,同样编译期就受限,但两处一起守更省心).
 * 2. **孤儿 signal**:`ViewState` 的每个字段必须被**清单引用**或被
 *    `RenderController` 订阅.只加信号不接线(或删了控件留下信号)不会报错,
 *    只会留一个永远不动的状态字段;这条会直接点名.
 * 3. **抢一个真相**:同一个状态字段不能被两行主绑定(两个控件各写各的,值会打架).
 *
 * 判据里的"真实字段全集"来自 `Object.keys(createViewState())` -- 类型擦除后
 * 只剩对象键,这是仓库里既有的做法(见 `styleLayers.test.ts` /
 * `dependencyBoundary.test.ts` 都按源码文本做判据);"谁订阅了"同样按
 * `RenderController.ts` 的源码文本取,不抄一份名单(抄一份就是第三个漂移点).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createViewState } from './viewState';
import { VIEW_BLOCKS, type ViewBlockSpec, type ViewRowSpec } from './viewSpec';

/** 清单展开成行(分组只影响 DOM 包装,不影响键). */
function rowsOf(blocks: readonly ViewBlockSpec[]): ViewRowSpec[] {
    return blocks.flatMap((block) => (block.kind === 'group' ? [...block.rows] : [block]));
}

/**
 * 主绑定:一行恰好绑一个状态字段(行内小开关每个各绑一个).
 *
 * 自定义行不在此列:它的绑定写在 `build` 里,类型系统看不到,由 `keys` 补声明
 * (见 `customKeys`) -- 所以"抢一个真相"这条只查主绑定,自定义行不重复计.
 */
function boundKeys(rows: readonly ViewRowSpec[]): string[] {
    return rows.flatMap((row) => {
        switch (row.kind) {
            case 'switch':
            case 'number':
            case 'segmented':
                return [row.key];
            case 'toggle-row':
                return row.toggles.map((toggle) => toggle.key);
            case 'custom':
                return [];
        }
    });
}

/** 自定义行声明的引用键. */
function customKeys(rows: readonly ViewRowSpec[]): string[] {
    return rows.flatMap((row) => (row.kind === 'custom' ? [...row.keys] : []));
}

const ROWS = rowsOf(VIEW_BLOCKS);
const BOUND = boundKeys(ROWS);
const CUSTOM = customKeys(ROWS);
const STATE_KEYS = Object.keys(createViewState());

/** `RenderController.bindViewState` 里读到的状态字段. */
function renderBoundKeys(): string[] {
    const source = readFileSync(
        new URL('../../app/RenderController.ts', import.meta.url),
        'utf8',
    );
    return [...source.matchAll(/\bstate\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
}

describe('视图窗口元素清单', () => {
    it('清单里的键都是真实存在的视图状态字段', () => {
        const unknown = [...BOUND, ...CUSTOM].filter((key) => !STATE_KEYS.includes(key));

        expect(unknown, '清单里写了一个 ViewState 没有的键').toEqual([]);
    });

    it('没有孤儿状态:每个字段都被清单引用或被渲染侧订阅', () => {
        const referenced = new Set([...BOUND, ...CUSTOM, ...renderBoundKeys()]);
        const orphans = STATE_KEYS.filter((key) => !referenced.has(key));

        expect(
            orphans,
            '这些 ViewState 字段既没绑到控件,也没被 RenderController 订阅:'
            + '只加信号不接线不会报错,只会留一个永远不动的状态',
        ).toEqual([]);
    });

    it('一个状态字段不被两行主绑定', () => {
        const duplicated = [...new Set(
            BOUND.filter((key, index) => BOUND.indexOf(key) !== index),
        )];

        expect(
            duplicated,
            '同一个字段被两行绑了:两个控件各写各的,真相会打架',
        ).toEqual([]);
    });

    it('清单是纯数据:顶层块的顺序与分组由它自己决定', () => {
        // 顺序不是"随便排的":相机行与预置视角在最上,三个分组按 点 / 坐标轴 /
        // 曲面 排列(与 ViewPanel.test.ts 的顶层类名序列同一条事实,这里是
        // 清单侧的对照).
        expect(VIEW_BLOCKS.map((block) => (block.kind === 'group' ? block.title : block.kind)))
            .toEqual(['custom', 'segmented', '点', '坐标轴', '曲面']);
    });
});
