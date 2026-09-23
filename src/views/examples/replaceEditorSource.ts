/**
 * 把整份源码写进编辑器,并尽量保留浏览器原生撤销栈.
 *
 * 为什么不能用 `editor.value = source`:
 * textarea 的撤销栈由浏览器的编辑管线维护,`.value` setter 属于"程序化重置值",
 * **不进编辑管线,还会把已有历史整段清空**.实测(Chromium 152 / Firefox 155):
 * 先手写内容再 `.value = ` 覆盖,连按 10 次 Ctrl+Z 也回不到原来的代码;而走
 * `execCommand('insertText')` 覆盖,一次 Ctrl+Z 就整段退回.
 *
 * 为什么必须先 `focus()` 再 `select()`:
 * - 不 focus:焦点在菜单按钮上时,Chrome 会把文本插进"上一次获得焦点的那个
 *   textarea"(返回 true 却插错地方),Firefox 直接返回 false--两个引擎的
 *   失败方式不同,都不能依赖当前焦点;
 * - 不 select:只 focus 会把文本插到光标处,拼在原代码中间(OLD -> OBBBLD).
 *
 * 换行不会被改写:实测多行文本进 textarea 后仍是 LF,没有 `\r\n`.
 * 合成 `InputEvent` 或 `setRangeText()` 都不进撤销栈,不是可用替代.
 *
 * 返回值只表达"成功与否",不表达"要不要刷新 UI":成功后浏览器自己会派发
 * `input` 事件,而回退路径不派发--调用方拿不准时,直接在调用后刷新一次
 * 行号栏/预览即可(见 `EditorLineNumbers.refresh()`,它本就是为程序化改写
 * 编辑器准备的).
 */

export function replaceTextareaSource(
    editor: HTMLTextAreaElement,
    source: string,
): boolean {
    if (insertTextPreservingUndo(editor, source)) return true;

    // 兜底:旧引擎,未来 execCommand 被移除,或命令被拒绝时,
    // 牺牲撤销栈也要把源码放进去(否则"载入示例"直接失效).
    editor.value = source;
    return false;
}

/**
 * 首屏种子源码:把默认示例写进**原本为空**的编辑器.
 *
 * 与 {@link replaceTextareaSource} 分开:那条路要保住用户已有代码的撤销栈,
 * 所以必须 `focus()` + `select()` + `execCommand`;而启动时编辑器本来是空的,
 * 没有历史要保,抢焦点反而会盖掉窗口系统刚设好的初始焦点.这里直接赋值,
 * 调用方自己刷新行号栏与高亮层--直接赋值不派发 `input` 事件.
 */
export function seedTextareaSource(editor: HTMLTextAreaElement, source: string): void {
    editor.value = source;
}

function insertTextPreservingUndo(
    editor: HTMLTextAreaElement,
    source: string,
): boolean {
    try {
        editor.focus();
        editor.select();
    } catch {
        return false;
    }

    // 已弃用的 execCommand(全应用只剩这一处;不受 SecureContext 门禁,代价是要用户手势):
    // focus + select 之后调用,文本才会落在「整段替换」的位置上.局部类型断言
    // 也是为了让 `@deprecated` 的删除线只留在这一行.
    const doc = editor.ownerDocument;
    const exec = (doc as {
        execCommand?: (id: string, showUI?: boolean, value?: string) => boolean;
    }).execCommand;
    try {
        // 返回 true 只表示浏览器接受了命令;不存在/被拒/抛错一律 false,由调用方退到 `.value =`.
        return exec?.call(doc, 'insertText', false, source) === true;
    } catch {
        return false;
    }
}
