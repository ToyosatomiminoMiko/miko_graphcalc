// 样式入口:**顺序即层叠顺序**,与拆分前 `index.html` 的 7 个 <link> 一致.
// Vite 会把它们(含从包里 import 的那三份)抽成产物里的一个 <link>,所以生产
// 构建的首帧不依赖 JS;开发态由 Vite 注入,顺序同上.
import '@miko/ui/styles/tokens.css';
import '../css/base.css';
import '@miko/ui/styles/desktop.css';
import '../css/panels.css';
import '../css/editor.css';
import '@miko/ui/styles/editor.css';
import '@miko/ui/styles/widgets.css';
import '../css/diagnostics.css';
import '../css/process.css';

import { DslApp } from './app/DslApp';
import { buildAppViews } from './app/appViews';
import { applyUiConfig } from './app/applyUiConfig';

// 先把 UI_CONFIG 落成 :root 上的 CSS 变量,再构造 DslApp:
// EditorLineNumbers 构造时会按最终字体度量行号槽宽,晚一步就会量到兜底字体.
applyUiConfig();

/**
 * 模块级唯一实例.
 *
 * 必须留一个可触达的引用,否则 `DslApp.dispose()` 整棵树(窗口拖动/缩放监听,
 * ResizeObserver,requestAnimationFrame,视图订阅,共享 Worker)都没有
 * 调用时机 -- 写好的清理路径会变成只对测试生效的死代码.
 *
 * 暴露到 window 是为了**开发期**能手动 `__dslApp.dispose()`,不承担对外 API
 * 角色:没有任何生产代码读它.
 */
declare global {
    interface Window {
        __dslApp?: DslApp;
    }
}

// `index.html` 里只剩一个 `#app`:窗口层 / Dock / 面板宿主都由 `mountDesktop()`
// 与 `buildAppViews()` 建(D1),这里只取那个容器,缺了就抛出带 id 的错误.
const root = document.getElementById('app');
if (!root) {
    throw new Error('index.html 缺少 #app:应用容器是页面上唯一需要手写的宿主');
}

const app = new DslApp(buildAppViews(root));
window.__dslApp = app;
app.start();

// 开发期 HMR:模块被热替换前先拆掉旧实例的监听与 rAF 循环,否则每改一次 main
// 就会多挂一套快捷键/拖动监听,并多出一个永不停止的动画帧回调.
if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        app.dispose();
        delete window.__dslApp;
    });
}
