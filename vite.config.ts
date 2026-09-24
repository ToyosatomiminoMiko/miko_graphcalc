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
         * 库从 npm 装进来(`miko_ui`),它自己的运行时依赖只有
         * `@preact/signals-core` 一个,`katex` 是可选 peer.本应用的
         * package.json 也**显式**声明了这两个:应用自己要直接用它们,而且
         * 声明在这里才能保证解析到应用根目录的那一份实例.dedupe 是第二道
         * 保险:把它们钉死到应用根目录的那一份实例上.
         *
         * 为什么必须只有一份:
         *
         * 1. **测试里的 `vi.mock('katex')` 要能拦住库**:mock 按"从测试文件解析
         *    出的模块"注册,库的 `dist/formula/FormulaView.js` 必须解析到同一个
         *    实例,否则公式相关的用例会真的去跑 katex;
         * 2. **`@preact/signals-core` 是库的响应式真相源**:两份实例意味着 signal
         *    与 effect 跨在两条注册表上,表现是"值变了界面不动".
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
        // 位置的测试都收进来:开发机上库的工作副本就在别处(本机是
        // `../__projects_web/miko_ui`),它的测试会被顺带跑一遍.这种"本地多跑
        // 一批,CI 少跑一批"的差异看不出来.库的测试由库自己的仓库和 CI 负责,
        // 不该在这里重复跑一遍.
        include: ['src/**/*.test.ts'],
        // 库从 npm 装进来后落在 `node_modules/` 里,Vitest 默认把它当外部依赖交给
        // Node 原生 ESM 解析 -- 而库产物里的相对导入不带扩展名(如
        // `dist/index.js` 里的 `./reactive`),Node 会报
        // `ERR_UNSUPPORTED_DIR_IMPORT`.把它 inline 进来走 Vite 的解析器 / 转换链,
        // 顺带处理 `dist/formula/FormulaView.js` 里的 `katex/dist/katex.min.css`.
        // 以前库是 `file:` 软链(指向仓库外的 `.cache/`),Vite 按源码处理,所以没暴露.
        server: {
            deps: {
                inline: ['miko_ui'],
            },
        },
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
