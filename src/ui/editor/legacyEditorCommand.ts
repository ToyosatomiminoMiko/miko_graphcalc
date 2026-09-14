/**
 * `document.execCommand` 的收口调用点.
 *
 * 为什么还必须用这个已弃用的 API:
 * - 「载入示例」要在**保留浏览器原生撤销栈**的前提下整段替换 textarea 内容.
 *   实测只有 `execCommand('insertText')` 做得到:直接 `.value =` 会清空撤销
 *   历史,`setRangeText()` 与合成 `InputEvent` 都不进撤销栈(见
 *   `examples/replaceEditorSource.ts` 的文件头);
 * - 非安全上下文(如 file://)下的剪贴板回退同样只有 `execCommand('copy')`
 *   这一条路(见 `FormulaCopyController.legacyCopy`).
 * 现代替代品 `EditContext` 目前只有 Chromium 实现,且不适用于 `<textarea>`.
 *
 * 为什么要有这一层:
 * `lib.dom` 把 `execCommand` 标了 `@deprecated`,编辑器会在**每个调用点**画
 * 删除线并报 ts(6387);把调用收进一个自己声明签名的地方,弃用提示只出现在
 * 这个文件里,调用方读到的是"这是有意为之的旧通道",而不是满屏删除线.
 * (tsc 不把 deprecation 当诊断输出,所以 `npm run typecheck` 对这类提示是
 * 沉默的--它不会替我们守住这一点.)
 *
 * 注意 `execCommand` 必须**调用时**从 `document` 上取:测试用的 DOM 桩是在
 * 模块加载之后才替换 `document.execCommand` 的,模块加载期缓存引用会让所有
 * 桩测试失真.
 */
interface LegacyEditorCommandHost {
    /** 旧编辑命令签名;`showUI` 恒传 false,所以不对外暴露. */
    execCommand?(commandId: string, showUI?: boolean, value?: string): boolean;
}

/**
 * 执行一条旧编辑命令(`insertText` / `copy`).
 *
 * 返回 true 只表示浏览器接受了命令.命令不存在,被拒绝(返回 false)或抛错时
 * 统一返回 false,由调用方决定兜底路径.
 */
export function runLegacyEditorCommand(commandId: string, value?: string): boolean {
    const host = document as unknown as LegacyEditorCommandHost;
    if (typeof host.execCommand !== 'function') return false;

    try {
        return host.execCommand(commandId, false, value) === true;
    } catch {
        return false;
    }
}
