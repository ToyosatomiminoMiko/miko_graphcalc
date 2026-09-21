/**
 * PWA 浏览器外框色的单一来源守卫.
 *
 * 这个颜色同时喂给三处:manifest 的 `theme_color` / `background_color`,以及
 * `index.html` 的 `<meta name="theme-color">`.前两处直接读 vite.config.ts 的
 * `PWA_CHROME_COLOR`;第三处由 `transformIndexHtml` 在开发/构建时把
 * `%PWA_CHROME_COLOR%` 占位符换成同一个常量.
 *
 * 因此 HTML 里只能有占位符,不能出现字面量:一旦有人把颜色抄回 HTML,这里就会
 * 失败,避免"改一处漏一处"的第三份副本悄悄回来(与 desktopHosts.test 锁
 * index.html 不留窗口结构与配置副本同一条理由).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('PWA 外框色只有一处设置', () => {
    it('index.html 的 theme-color 只写占位符,不写字面量', () => {
        const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
        const meta = /<meta\s+name="theme-color"[^>]*>/.exec(html)?.[0] ?? '';

        expect(meta).toContain('%PWA_CHROME_COLOR%');
        // 占位符之外不允许再出现任何颜色字面量.
        expect(meta).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    });
});
