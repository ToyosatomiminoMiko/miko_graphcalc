/**
 * 随仓库分发的 DSL 源码整体编译回归.
 *
 * `example/*.miko` 是用户第一眼会跑的东西(原来的 index.html 默认场景已在
 * `example/test.miko`,也在这个目录里),也是 DSL 语义(尤其编译期校验)回归时
 * 最先被打破的地方:编译器新增一条"报错而不是静默当自由参数"的规则,就可能让
 * 既有示例直接编译失败.这里用真实 Rust 解析器 + 真实符号引擎把 `example/`
 * 全量跑一遍,只断言"能编译出 SceneIR",不锁任何几何细节--细节由各自主题的
 * 测试覆盖.
 *
 * 与 objectAddition.test.ts 的分工:那个文件锁对象相加的语义,本文件锁
 * "仓库自带的源码在当下编译器里仍然成立".
 */
import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { parseMiko } from '@/compiler/parser';
import { compileScene } from './DslCompiler';
import { testMatrixOps } from '@/testing/matrixOps';

describe('仓库自带 DSL 源码', () => {
    it('example/ 下每个示例都能编译出 SceneIR', async () => {
        const dir = new URL('../../../example/', import.meta.url);
        const files = (await readdir(dir)).filter((name) => name.endsWith('.miko'));
        expect(files.length).toBeGreaterThan(0);

        const failures: string[] = [];
        for (const file of files) {
            const source = await readFile(new URL(file, dir), 'utf8');
            try {
                compileScene(await parseMiko(source), {}, testMatrixOps);
            } catch (error) {
                failures.push(
                    `${file}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        expect(failures).toEqual([]);
    });

    it('默认场景 example/test.miko 能编译出非空 SceneIR', async () => {
        // 这条原先是"读 index.html 里 <textarea> 的默认源码";默认场景整体移入
        // example/ 之后,真相源只剩 `example/test.miko`,这里改为直接读它.
        const source = await readFile(
            new URL('../../../example/test.miko', import.meta.url),
            'utf8',
        );
        const scene = compileScene(await parseMiko(source), {}, testMatrixOps);
        expect(scene.objects.length).toBeGreaterThan(0);
    });
});
