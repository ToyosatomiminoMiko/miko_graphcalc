/**
 * 示例目录 -- 左侧「示例」菜单要显示的清单,以及示例源码的来源.
 *
 * 结构是**分组键 -> 组内课程**:
 *
 * ```ts
 * export const EXAMPLE_CATALOG = {
 *     derivatives: [{ file: 'derivative_graph.miko', title: '导数函数图像' }, ...],
 *     others: [...],
 * };
 * ```
 *
 * - 分组键是 ASCII 标识符:代码,测试,`data-*`/持久化里都能稳定使用;
 *   菜单里显示的中文组名另由 {@link EXAMPLE_GROUP_TITLES} 给出.键与文案分开,
 *   改文案不会连带改键,键也不会因为出现中文而难写(见 `ExampleGroup`).
 * - 条目(**课程**)里没有 `group` 字段:分组只由它挂在哪个键下决定,避免
 *   "键说一组,字段说另一组"两处不一致.
 * - 分组顺序 = 键的书写顺序,组内顺序 = 数组顺序,菜单直接照此渲染;空组不出现.
 *
 * 源码为什么用 `import.meta.glob(..., { query: '?raw', eager: true })`:
 * `example/` 不在 `public/` 下,构建后不会进 `dist/`,运行时 `fetch` 在
 * GitHub Pages 上必然 404;把文件复制进 `public/` 又会让同一份文本存在
 * 两个位置,违背"源码是唯一真相源"的约定.raw glob 在**构建期**把文本内联
 * 进 bundle,`example/*.miko` 仍然是唯一真相源,而且文本随 JS 一起进
 * PWA 预缓存,离线打开也能载入示例.
 *
 * 代价:生产站新增示例要重新构建才可见(dev 下丢进 `example/` 立刻就能选到),
 * 而部署本来就要构建,不额外增加步骤.
 *
 * 标题为什么不从文件头注释里抓:示例文件头格式并不统一(有的第一行是
 * `====` 横幅,有的直接是标题),抓注释迟早抓错.文件集与清单的一一对应
 * 由 `exampleCatalog.test.ts` 守住:新增示例忘了登记会被测试挡住.
 */

/**
 * 一门课程(示例菜单里的一项).
 *
 * 只有"是哪个文件"与"叫什么"两件事:分组是清单里的键,不是条目的字段.
 */
export interface ExampleEntry {
    /** `example/` 下的文件名(含扩展名),同时是菜单项的 `data-example` 值. */
    readonly file: string;
    /** 菜单里显示的中文标题;完整说明仍以 `example/README.md` 为准. */
    readonly title: string;
}

/** 构建期内联的示例源码,键为 `/example/<文件名>`. */
const EXAMPLE_MODULES = import.meta.glob('/example/*.miko', {
    query: '?raw',
    import: 'default',
    eager: true,
});

/**
 * 示例清单:分组键 -> 组内课程.
 *
 * 键是 ASCII 标识符(中文组名见 {@link EXAMPLE_GROUP_TITLES}),书写顺序就是
 * 菜单顺序,组内按讲解顺序排.标题与 `example/README.md` 的表对应,但用短名,
 * 避免在 300px 宽的面板里换行.
 *
 * 为什么用 `satisfies` 而不是 `: Record<string, ...>` 标注:标注会把键类型擦成
 * `string`,`ExampleGroup` 就丢了"只能是这几个组名"的约束,`EXAMPLE_GROUP_TITLES`
 * 的穷尽检查也随之失效.
 */
export const EXAMPLE_CATALOG = {
    derivatives: [
        { file: 'derivative_graph.miko', title: '导数函数图像' },
        { file: 'derivative_curve.miko', title: '一元函数求导' },
        { file: 'derivative_rules.miko', title: '求导法则对照' },
        { file: 'partial_derivative_surface.miko', title: '二元函数偏导' },
        { file: 'divergence_vector_field.miko', title: '散度 div(F)' },
        { file: 'curl_vector_field.miko', title: '旋度 curl(F)' },
        { file: 'laplacian_scalar_field.miko', title: '拉普拉斯 ∇²f' },
        { file: 'laplacian_harmonic.miko', title: '调和场 ∇²f = 0' },
        { file: 'sphere_gradient.miko', title: '球体隐式场梯度' },
        { file: 'gauss_surface.miko', title: '高斯钟形曲面' },
    ],
    others: [
        { file: 'object_addition.miko', title: '对象相加' },
        { file: 'intersection_line_curves.miko', title: '曲线 ∩ 曲线' },
        { file: 'intersection_surfaces.miko', title: '曲面 ∩ 曲面' },
        { file: 'double_integral_region.miko', title: 'region 域二重积分' },
        { file: 'solve_equations.miko', title: '方程求解分步推导' },
        { file: 'antiderivative_basic.miko', title: '不定积分与求导验算' },
        { file: 'antiderivative_rational.miko', title: '有理函数部分分式' },
        { file: 'animation_box_rotations.miko', title: '动画片段顺序播放' },
        { file: 'Zemlya.miko', title: '三星覆盖与极冠' },
        { file: 'ode_separable.miko', title: '微分方程:可分离' },
        { file: 'ode_linear_first_order.miko', title: '微分方程:一阶线性' },
        { file: 'ode_second_order.miko', title: '微分方程:二阶常系数' },
        { file: 'ode_with_initial.miko', title: '微分方程:初值' },
        // 默认场景: "全部功能一览".
        { file: 'test.miko', title: '全部功能一览' },
    ],
} satisfies Record<string, readonly ExampleEntry[]>;

/** 分组键(清单里键的联合类型);菜单顺序见 {@link groupedExamples}. */
export type ExampleGroup = keyof typeof EXAMPLE_CATALOG;

/**
 * 分组键 -> 菜单里显示的中文组名.
 *
 * 单独一份映射而不是把中文写进 `EXAMPLE_CATALOG` 的键:键是标识符,要能在
 * 代码/测试里当 `data-*` 或持久化值稳定使用;中文是文案,两件事的生命周期不同.
 * 类型是 `Record<ExampleGroup, string>`,漏写某个分组编译期就会报错.
 */
export const EXAMPLE_GROUP_TITLES: Record<ExampleGroup, string> = {
    derivatives: '求导 / 偏导',
    others: '其他主题',
};

/**
 * 首屏默认载入的示例(文件名).
 *
 * `index.html` 里 `<textarea id="dsl-editor">` 的默认源码已经移入 `example/`,
 * 编辑器初值是空的;App 启动时若编辑器为空,就把这一门课写进去,首屏不是一片
 * 空视口.
 *
 * 为什么放在清单模块而不是写死在 `DslApp`:装配层只该知道"载入默认示例",
 * "默认是哪一门课"属于课程清单.这个文件名必须在 {@link EXAMPLE_CATALOG} 里
 * (由 `exampleCatalog.test.ts` 守住).
 */
export const DEFAULT_EXAMPLE_FILE = 'test.miko';

/**
 * 取示例源码.清单里没有这个文件,或 glob 没命中(理论上不该发生,由
 * `exampleCatalog.test.ts` 守住)时返回 null,调用方报错而不是塞空文本.
 */
export function exampleSource(file: string): string | null {
    return EXAMPLE_MODULES[`/example/${file}`] ?? null;
}

/**
 * 全部课程,按分组的书写顺序拍平;组内顺序不变.
 *
 * 菜单渲染走 {@link groupedExamples},需要**按文件名反查**时(点击委托只拿到
 * `data-example`,拿不到分组)走这里.
 */
export function allExamples(): readonly ExampleEntry[] {
    return Object.values(EXAMPLE_CATALOG).flat();
}

/**
 * 首屏默认示例条目;清单里没有 {@link DEFAULT_EXAMPLE_FILE} 时返回 null.
 *
 * 返回整条目而不是文件名:`DslApp` 载入后要用 `entry.file` 把菜单项标成当前项
 * (`setActive`),直接给条目省得调用方再按文件名查一次.
 */
export function defaultExample(): ExampleEntry | null {
    return allExamples().find((entry) => entry.file === DEFAULT_EXAMPLE_FILE) ?? null;
}

/**
 * 按键的书写顺序分组;没有条目的分组不返回.
 *
 * `title` 是 {@link EXAMPLE_GROUP_TITLES} 里那一份显示名:菜单不需要认识
 * "键 -> 中文名"这条规则,拿到 section 就能直接渲染.
 */
export function groupedExamples(): Array<{
    readonly group: ExampleGroup;
    readonly title: string;
    readonly entries: readonly ExampleEntry[];
}> {
    return (Object.keys(EXAMPLE_CATALOG) as ExampleGroup[])
        .map((group) => ({
            group,
            title: EXAMPLE_GROUP_TITLES[group],
            entries: EXAMPLE_CATALOG[group],
        }))
        .filter((section) => section.entries.length > 0);
}
