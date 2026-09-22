import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

/**
 * `src/` 内跨目录导入的根别名.
 *
 * 单一来源约束:Vite/Vitest 不读 `tsconfig.json`,所以这行是
 * `tsconfig.json` 里 `paths: { "@/*": ["./src/*"] }` 的**另一半**,
 * 改一处必须同步另一处(TS 侧管类型检查与编辑器,Vite 侧管 dev/build/test
 * 的实际解析;只改一边的表现是"编辑器不报错但构建失败"或反之).
 *
 * 不覆盖 `new URL(..., import.meta.url)`:那是物理文件定位,不走模块解析.
 * `src/generated/` 刻意不做别名,构建产物不该伪装成源码层.
 */
const SRC_ALIAS = fileURLToPath(new URL('./src', import.meta.url));

/**
 * 独立仓库配置: 本仓库是 GitHub Pages 的"项目页",站点根是
 * `https://toyosatomiminomiko.github.io/miko_graphcalc/`,不是域名根.
 *
 * `base` 是这里唯一的路径开关. 改仓库名时只改这一处即可: Vite 会自动把
 * 它补到 HTML 里的绝对资源路径(`/apple-touch-icon.png` 会变成带前缀的
 * 形式),worker 与 wasm 产物 URL 上; VitePWA 也会据此生成 manifest 的
 * scope/start_url 与 Service Worker 的相对预缓存清单.
 */
/**
 * PWA 的浏览器外框色(manifest 的 theme_color / background_color / HTML 的
 * `<meta name="theme-color">` 共用).
 *
 * 单一来源:这些字段以前各写一遍 `#0d0d0d`,改一处漏一处不会报错,只会让
 * 安装后的启动画面与状态栏颜色分叉.`index.html` 里写占位符
 * `%PWA_CHROME_COLOR%`,由下面的 {@link injectChromeColor} 在开发/构建时替换,
 * HTML 里不留第二份字面量.
 *
 * 它不等于色板里的 `--color-bg-app`(#0e101a),那是页面底色;这里刻意更深,
 * 让独立窗口的状态栏与页面内容有分界.
 */
const PWA_CHROME_COLOR = '#0d0d0d';

/** `index.html` 里待替换的占位符;写成常量是为了让 HTML 与这里同名可查. */
const CHROME_COLOR_PLACEHOLDER = '%PWA_CHROME_COLOR%';

/** 把 {@link PWA_CHROME_COLOR} 注入 `index.html` 的 `<meta name="theme-color">`. */
function injectChromeColor(): Plugin {
    return {
        name: 'graphcalc:inject-pwa-chrome-color',
        transformIndexHtml: (html) =>
            html.replaceAll(CHROME_COLOR_PLACEHOLDER, PWA_CHROME_COLOR),
    };
}

export default defineConfig({
    base: '/miko_graphcalc/',
    resolve: {
        alias: [{ find: /^@\//, replacement: `${SRC_ALIAS}/` }],
        /**
         * 库是 `file:` 链接进来的(`@miko/ui` -> `packages/miko_ui`),它有自己
         * 的 `node_modules`:`katex`(可选 peer 的 dev 安装)与
         * `@preact/signals-core`(运行时依赖)各有一份.不做 dedupe 会同时踩两个
         * 坑:
         *
         * 1. **测试里的 `vi.mock('katex')` 拦不住库**:mock 按"从测试文件解析出
         *    的模块"注册,而库的 `dist/formula/FormulaView.js` 会就近解析到它自己
         *    那份 -- 两份是两个模块实例,于是公式相关的用例会真的去跑 katex;
         * 2. **产物里可能进两份**:peer 依赖的语义本来就是"由消费者提供一份",
         *    所以这里强制所有 `katex` 都解析到应用根目录那一份.
         *
         * `@preact/signals-core` 同理:它是库的响应式真相源,必须只有一个实例,
         * 否则 signal 与 effect 会跨在两条注册表上,表现是"值变了界面不动".
         */
        dedupe: ['katex', '@preact/signals-core'],
    },
    optimizeDeps: {
        include: ['three'],
    },
    test: {
        // 只收本仓库自己的测试.
        //
        // 不写这一条的话 Vitest 用默认 glob(`**/*.test.ts`),会把磁盘上任何
        // 位置的测试都收进来.分离之后 `packages/miko_ui/` 仍可能是本地那份库
        // 的工作副本(gitignored,CI 的干净 clone 里不存在),于是本地跑 77 个
        // 文件,CI 只跑 58 个,数字对不上还看不出来.库的测试现在由库自己的
        // 仓库和 CI 负责,不该在这里重复跑一遍.
        include: ['src/**/*.test.ts'],
        // 解析器集成测试要跑真正的 Rust/WASM 解析器;wasm-bindgen 的默认
        // 初始化在 Node 里走 `fetch(new URL(..., import.meta.url))`,Node 的
        // fetch 不认 file://,会直接 "fetch failed".setup 文件用 initSync
        // 从磁盘读 .wasm 字节先完成初始化,后续 ensureWasmReady 的懒加载
        // 见到实例已存在就跳过(见 src/wasm/init.ts).
        setupFiles: ['./src/testing/setupWasm.ts'],
    },
    plugins: [
        injectChromeColor(),
        VitePWA({
            registerType: 'autoUpdate',
            injectRegister: 'auto',
            includeAssets: [
                'favicon.ico',
                'apple-touch-icon.png',
                'pwa-192x192.png',
                'pwa-512x512.png',
            ],
            manifest: {
                name: 'GraphCalc',
                short_name: 'GraphCalc',
                description: 'GraphCalc DSL',
                lang: 'zh-CN',
                theme_color: PWA_CHROME_COLOR,
                background_color: PWA_CHROME_COLOR,
                display: 'standalone',
                orientation: 'any',
                icons: [
                    {
                        src: 'pwa-192x192.png',
                        sizes: '192x192',
                        type: 'image/png',
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                    },
                    {
                        src: 'pwa-maskable-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'maskable',
                    },
                ],
            },
            workbox: {
                // wasm 也纳入预缓存: 三个内核合计约 1MB,不缓存则离线打开会白屏.
                globPatterns: ['**/*.{js,css,html,ico,png,svg,jpg,gif,woff2,wasm}'],
                cleanupOutdatedCaches: true,
                maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
            },
        }),
    ],
});
