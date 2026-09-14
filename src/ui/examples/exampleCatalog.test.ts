/**
 * 示例目录一致性.
 *
 * 锁的是"菜单能选到的示例"与"仓库里真实存在的示例文件"不许分叉:
 * - 新增 `example/*.scad` 忘了登记 -> 文件多出来,失败;
 * - 清单里写了不存在的文件,或 glob 没内联到文本 -> 取不到源码,失败.
 *
 * 与 compiler/dsl/exampleScenes.test.ts 的分工:那个文件锁"示例在当下编译器里
 * 仍能编译",本文件锁"示例清单与文件集一致".两侧都从 `example/` 目录本身出发,
 * 所以谁也不会被另一侧的遗漏糊弄过去.
 */
import { describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import {
    EXAMPLE_CATALOG,
    EXAMPLE_GROUPS,
    exampleSource,
    groupedExamples,
} from './exampleCatalog';

const EXAMPLE_DIR = new URL('../../../example/', import.meta.url);

describe('示例目录', () => {
    it('example/ 下的文件与清单一一对应', async () => {
        const files = (await readdir(EXAMPLE_DIR))
            .filter((name) => name.endsWith('.scad'))
            .sort();
        const listed = EXAMPLE_CATALOG.map((entry) => entry.file).sort();

        expect(listed).toEqual(files);
    });

    it('每一项都能取到非空的示例源码', () => {
        for (const entry of EXAMPLE_CATALOG) {
            const source = exampleSource(entry.file);
            expect(source, `${entry.file} 没有内联源码`).not.toBeNull();
            expect(source!.trim().length, `${entry.file} 源码为空`).toBeGreaterThan(0);
        }
    });

    it('分组取值合法,且分组后一项不丢', () => {
        for (const entry of EXAMPLE_CATALOG) {
            expect(EXAMPLE_GROUPS, `${entry.file} 的分组不在 EXAMPLE_GROUPS 里`)
                .toContain(entry.group);
        }

        const grouped = groupedExamples().flatMap((section) => section.entries);
        expect(grouped.length).toBe(EXAMPLE_CATALOG.length);
    });

    it('文件名不重复:菜单项靠 data-example 定位,重复会点错示例', () => {
        const files = EXAMPLE_CATALOG.map((entry) => entry.file);
        expect(new Set(files).size).toBe(files.length);
    });

    it('清单之外的文件名取不到源码,返回 null 而不是空串', () => {
        expect(exampleSource('no_such_example.scad')).toBeNull();
    });
});
