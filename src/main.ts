import { DslApp } from './app/DslApp';
import { applyUiConfig } from './ui/applyUiConfig';

// 先把 UI_CONFIG 落成 :root 上的 CSS 变量,再构造 DslApp:
// EditorLineNumbers 构造时会按最终字体度量行号槽宽,晚一步就会量到兜底字体.
applyUiConfig();

const app = new DslApp();
app.start();
