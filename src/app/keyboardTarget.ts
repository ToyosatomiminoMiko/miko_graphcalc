/**
 * 键盘目标的判据:焦点是不是落在"有自己键盘语义"的控件里.
 *
 * 为什么这份判断在本应用里:库(miko_ui)已经不定义任何键盘行为,键盘入口
 * 全部归应用(见 `DslApp` 的 `onKeyDown`).`Home` 在 textarea / input 里是
 * "光标回行首",在 range 上是"跳到最小值",在 contenteditable 里是"移到行首" --
 * 这些都必须原样留给控件,不能被应用的全局快捷键连坐.
 *
 * 这份实现原来在 miko_ui 的 `shared/KeyboardController.ts` 里(`isTypingTarget`,
 * 随该类一起删除),语义逐条照搬:
 * - `INPUT` / `TEXTAREA` / `SELECT` 按标签名认;
 * - `contenteditable` 认"属性存在且不为 `false`"(空串表示可编辑);
 * - 焦点在 `<body>` / `document` 上时事件目标不是 `Element`,判为"不在输入里".
 */
export function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    switch (target.tagName.toUpperCase()) {
        case 'INPUT':
        case 'TEXTAREA':
        case 'SELECT':
            return true;
        default:
            break;
    }
    const contentEditable = target.getAttribute('contenteditable');
    return contentEditable !== null && contentEditable !== 'false';
}
