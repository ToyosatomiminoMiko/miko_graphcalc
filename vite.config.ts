import { defineConfig, searchForWorkspaceRoot, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
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

/** 本仓库根目录(配置文件所在目录),给 `searchForWorkspaceRoot` 与真身解析用. */
const PROJECT_ROOT = fileURLToPath(new URL('.', import.meta.url));

const require = createRequire(import.meta.url);

/**
 * 库(`miko_ui`)在磁盘上的**真身**目录,以及它实际用的 katex 包目录.
 *
 * 为什么需要:本地联调时 `node_modules/miko_ui` 是指向仓库外工作副本的符号链接
 * (见 `scripts/dev_ui_link.py`),而 Vite 默认解析真身路径 -- 库的公式件从
 * `katex/dist/katex.min.css` 里带出一堆 `url(...)` 字体,浏览器直接按
 * `/@fs/<真身>/.../fonts/*.woff2` 请求,落在 `server.fs.allow`(默认只有工作区根)
 * 之外,于是 dev 控制台刷 "outside of Vite serving allow list",公式字体的请求
 * 全部 403(公式照样排,只是掉字形).
 *
 * 为什么 katex 的位置要问**库**而不是本仓库:`node_modules/katex` 是库的依赖,
 * 可能被提升到任何一层;本仓库也已经不声明 katex 了,从这边 `require.resolve`
 * 根本找不到它.所以用 `createRequire(库的 package.json)` 从库的解析上下文去问.
 *
 * 只在 dev server / preview 生效;`vite build` 把字体当资源拷进产物,不需要白名单.
 * 解析不到就跳过:CI 与 npm 形状(库就在本仓库的 `node_modules/` 里,本来就在
 * 工作区根之内)不会因此多出任何路径.
 */
function libraryServeDirs(): string[] {
    const dirs: string[] = [];
    try {
        const manifest = require.resolve('miko_ui/package.json');
        dirs.push(dirname(realpathSync(manifest)));
        try {
            dirs.push(dirname(realpathSync(createRequire(manifest).resolve('katex/package.json'))));
        } catch {
            // 库这一版没带 katex(旧的可选 peer 版):没有字体要放行
        }
    } catch {
        // 库没装出来(例如只跑库自己的测试):没有要额外放行的东西
    }
    return dirs;
}

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
         * 库从 npm 装进来(`miko_ui`),它是唯一需要"钉死到应用根目录一份实例"
         * 的东西:`@preact/signals-core` 是库的响应式真相源,两份实例意味着
         * signal 与 effect 跨在两条注册表上,表现是"值变了界面不动".
         *
         * **为什么这里不再有 `katex`**:本应用不直接依赖 katex -- LaTeX 的排版,
         * 样式(`katex/dist/katex.min.css`)与测试替身都由库自带,应用侧不声明,
         * 不 import,不 mock(见 `src/config/dependencyBoundary.test.ts` 的三条
         * 守卫).这条 dedupe 以前存在的理由是"让测试里的 `vi.mock('katex')`
         * 拦得住库";那个 mock 已经随库的渲染器出口
         * (`setFormulaRenderer` / `installDomStub()`)一起删除,理由随之消失.
         */
        dedupe: ['@preact/signals-core'],
    },
    server: {
        fs: {
            /**
             * 默认白名单只有"工作区根".本地联调时库的真身在仓库外,它的公式字体
             * 走 `/@fs` 请求会被拒(见 `libraryServeDirs`).这里把根与库的真身
             * 一起放行 -- 写 `allow` 会**覆盖**默认值,所以根必须留在数组里.
             */
            allow: [searchForWorkspaceRoot(PROJECT_ROOT), ...libraryServeDirs()],
        },
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
