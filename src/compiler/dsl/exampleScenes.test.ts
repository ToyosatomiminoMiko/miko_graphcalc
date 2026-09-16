/**
 * 随仓库分发的 DSL 源码整体编译回归.
 *
 * `example/*.scad` 与 `index.html` 里 `<textarea id="dsl-editor">` 的默认源码
 * 是用户第一眼会跑的东西,也是 DSL 语义(尤其编译期校验)回归时最先被打破的
 * 地方:编译器新增一条"报错而不是静默当自由参数"的规则,就可能让既有示例
 * 直接编译失败.这里用真实 Rust 解析器 + 真实符号引擎把两份内容全量跑一遍,
 * 只断言"能编译出 SceneIR",不锁任何几何细节--细节由各自主题的测试覆盖.
 *
 * 与 objectAddition.test.ts 的分工:那个文件锁对象相加的语义,本文件锁
 * "仓库自带的源码在当下编译器里仍然成立".
 */
import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { parseMiko } from '../parser';
import { compileScene } from './DslCompiler';
import { testMatrixOps } from '../../testing/matrixOps';

describe('仓库自带 DSL 源码', () => {
    it('example/ 下每个示例都能编译出 SceneIR', async () => {
        const dir = new URL('../../../example/', import.meta.url);
        const files = (await readdir(dir)).filter((name) => name.endsWith('.scad'));
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

    it('index.html 的默认源码能编译出 SceneIR', async () => {
        const html = await readFile(new URL('../../../index.html', import.meta.url), 'utf8');
        const match = html.match(/<textarea id="dsl-editor"[^>]*>([\s\S]*?)<\/textarea>/);
        expect(match).not.toBeNull();

        const scene = compileScene(await parseMiko(match![1]), {}, testMatrixOps);
        expect(scene.objects.length).toBeGreaterThan(0);
    });
});
