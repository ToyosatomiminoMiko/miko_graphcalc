import { DslApp } from './app/DslApp';
import { applyUiConfig } from './ui/theme/applyUiConfig';

// 先把 UI_CONFIG 落成 :root 上的 CSS 变量,再构造 DslApp:
// EditorLineNumbers 构造时会按最终字体度量行号槽宽,晚一步就会量到兜底字体.
applyUiConfig();

/**
 * 模块级唯一实例.
 *
 * 必须留一个可触达的引用,否则 `DslApp.dispose()` 整棵树(窗口拖动/缩放监听,
 * ResizeObserver,requestAnimationFrame,EventBus 订阅,共享 Worker)都没有
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

const app = new DslApp();
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
