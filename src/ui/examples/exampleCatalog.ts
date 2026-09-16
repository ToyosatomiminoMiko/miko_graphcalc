/**
 * 示例目录 -- 左侧「示例」菜单要显示的清单,以及示例源码的来源.
 *
 * 源码为什么用 `import.meta.glob(..., { query: '?raw', eager: true })`:
 * `example/` 不在 `public/` 下,构建后不会进 `dist/`,运行时 `fetch` 在
 * GitHub Pages 上必然 404;把文件复制进 `public/` 又会让同一份文本存在
 * 两个位置,违背"源码是唯一真相源"的约定.raw glob 在**构建期**把文本内联
 * 进 bundle,`example/*.scad` 仍然是唯一真相源,而且文本随 JS 一起进
 * PWA 预缓存,离线打开也能载入示例.
 *
 * 代价:生产站新增示例要重新构建才可见(dev 下丢进 `example/` 立刻就能选到),
 * 而部署本来就要构建,不额外增加步骤.
 *
 * 标题为什么不从文件头注释里抓:示例文件头格式并不统一(有的第一行是
 * `====` 横幅,有的直接是标题),抓注释迟早抓错.文件集与清单的一一对应
 * 由 `exampleCatalog.test.ts` 守住:新增示例忘了登记会被测试挡住.
 */
export const EXAMPLE_GROUPS = ['求导 / 偏导', '其他主题'] as const;

export type ExampleGroup = (typeof EXAMPLE_GROUPS)[number];

export interface ExampleEntry {
    /** `example/` 下的文件名(含扩展名),同时是菜单项的 `data-example` 值. */
    readonly file: string;
    /** 菜单里显示的中文标题;完整说明仍以 `example/README.md` 为准. */
    readonly title: string;
    /** 所属分组,取值必须出现在 `EXAMPLE_GROUPS` 里(有测试守住). */
    readonly group: ExampleGroup;
}

/** 构建期内联的示例源码,键为 `/example/<文件名>`. */
const EXAMPLE_MODULES = import.meta.glob('/example/*.scad', {
    query: '?raw',
    import: 'default',
    eager: true,
});

/**
 * 菜单顺序即此数组顺序,按主题分组,组内按讲解顺序排.
 * 标题与 `example/README.md` 的表对应,但用短名,避免在 300px 宽的面板里换行.
 */
const _orther = '其他主题';
export const EXAMPLE_CATALOG: readonly ExampleEntry[] = [
    { file: 'derivative_graph.scad', title: '导数函数图像', group: '求导 / 偏导' },
    { file: 'derivative_curve.scad', title: '一元函数求导', group: '求导 / 偏导' },
    { file: 'derivative_rules.scad', title: '求导法则对照', group: '求导 / 偏导' },
    { file: 'partial_derivative_surface.scad', title: '二元函数偏导', group: '求导 / 偏导' },
    { file: 'divergence_vector_field.scad', title: '散度 div(F)', group: '求导 / 偏导' },
    { file: 'curl_vector_field.scad', title: '旋度 curl(F)', group: '求导 / 偏导' },
    { file: 'laplacian_scalar_field.scad', title: '拉普拉斯 ∇²f', group: '求导 / 偏导' },
    { file: 'laplacian_harmonic.scad', title: '调和场 ∇²f = 0', group: '求导 / 偏导' },
    { file: 'sphere_gradient.scad', title: '球体隐式场梯度', group: '求导 / 偏导' },
    { file: 'gauss_surface.scad', title: '高斯钟形曲面', group: '求导 / 偏导' },
    { file: 'object_addition.scad', title: '对象相加', group: _orther },
    { file: 'intersection_line_curves.scad', title: '曲线 ∩ 曲线', group: _orther },
    { file: 'intersection_surfaces.scad', title: '曲面 ∩ 曲面', group: _orther },
    { file: 'double_integral_region.scad', title: 'region 域二重积分', group: _orther },
    { file: 'solve_equations.scad', title: '方程求解分步推导', group: _orther },
    { file: 'animation_box_rotations.scad', title: '动画片段顺序播放', group: _orther },
    { file: 'Zemlya.scad', title: '三星覆盖与极冠', group: _orther },
];

/**
 * 取示例源码.清单里没有这个文件,或 glob 没命中(理论上不该发生,由
 * `exampleCatalog.test.ts` 守住)时返回 null,调用方报错而不是塞空文本.
 */
export function exampleSource(file: string): string | null {
    return EXAMPLE_MODULES[`/example/${file}`] ?? null;
}

/** 按 `EXAMPLE_GROUPS` 的顺序分组;没有条目的分组不返回. */
export function groupedExamples(): Array<{ group: ExampleGroup; entries: ExampleEntry[] }> {
    return EXAMPLE_GROUPS.map((group) => ({
        group,
        entries: EXAMPLE_CATALOG.filter((entry) => entry.group === group),
    })).filter((section) => section.entries.length > 0);
}
