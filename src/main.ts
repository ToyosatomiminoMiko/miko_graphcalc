// 样式入口:**两层,库层在前,应用层在后**(顺序即层叠顺序).
//
// 为什么是"整层压"而不是逐份交错:赢家该由"谁负责这块样式"决定,不该由"文件
// 排在第几位"决定.库的按钮基线本来就写成零优先级的 `:where(.ui-button)`,是
// "库在前,消费方在后"的用法;应用层整层压上去之后,没有任何一条应用规则会因为
// "库的某份样式表恰好排在它后面"而静默失效 -- 旧的交错顺序就踩过这个坑:
// `panels.css` 里的 `.row-visibility-btn` 被排在后面的 `widgets.css` 盖掉了.
//
// 这条界限由 `src/config/styleLayers.test.ts` 守着:应用层只写库不拥有的类,
// 不重复库已有的东西.要改样式就改库(或往库里加),不要在应用里覆盖.
//
// Vite 会把下面这些抽成产物里的一个 <link>,所以生产构建的首帧不依赖 JS;
// 开发态由 Vite 注入,顺序同上.
//
// 1) 库层:一行 = 库的全部默认样式.内部顺序(tokens -> 控件 -> 桌面 -> 编辑器
//    外壳)由库自己的 `styles.css` 决定,应用不插手;库以后新增样式表,这里
//    也不用改.
import '@miko/ui/styles.css';
//
// 2) 应用层:只写应用自己的类 / id / 页面级规则,按用途拆成五份.
import '../css/base.css';
import '../css/panels.css';
import '../css/editor.css';
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
