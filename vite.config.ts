import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

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
 * PWA 的浏览器外框色(manifest 的 theme_color 与 background_color 共用).
 *
 * 单一来源:这两个字段以前各写一遍 `#0d0d0d`,改一处漏一处不会报错,只会让
 * 安装后的启动画面与状态栏颜色分叉.
 *
 * 注意 `index.html` 的 `<meta name="theme-color">` 是同一族配色的第三份副本:
 * 静态 HTML 读不到这个常量,只能人工保持一致(当前两者相同).
 * 它不等于色板里的 `--color-bg-app`(#0e101a),那是页面底色;这里刻意更深,
 * 让独立窗口的状态栏与页面内容有分界.
 */
const PWA_CHROME_COLOR = '#0d0d0d';

export default defineConfig({
    base: '/miko_graphcalc/',
    optimizeDeps: {
        include: ['three'],
    },
    test: {
        // 解析器集成测试要跑真正的 Rust/WASM 解析器;wasm-bindgen 的默认
        // 初始化在 Node 里走 `fetch(new URL(..., import.meta.url))`,Node 的
        // fetch 不认 file://,会直接 "fetch failed".setup 文件用 initSync
        // 从磁盘读 .wasm 字节先完成初始化,后续 ensureWasmReady 的懒加载
        // 见到实例已存在就跳过(见 src/runtime/wasmRuntime.ts).
        setupFiles: ['./src/test/setupWasm.ts'],
    },
    plugins: [
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
