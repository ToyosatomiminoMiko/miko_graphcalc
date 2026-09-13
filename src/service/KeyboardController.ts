/**
 * KeyboardController -- 键盘快捷键绑定的统一出口.
 *
 * 一切键盘事件监听集中在这里定义,绑定与解绑,装配层(DslApp)只负责
 * 传入回调,不再直接对 document / 编辑器 addEventListener,避免监听泄漏.
 *
 * 快捷键:
 * - 【全局】Home           -> 视角看向原点(0,0,0)   (绑在 document)
 * - 【编辑器】Ctrl/Cmd+Enter -> 运行 DSL            (绑在 dsl-editor)
 *
 * 绑定/解绑严格成对:bind() 之后必须 dispose(),DslApp.dispose() 负责清理.
 */
export interface KeyboardActions {
    /** [键盘事件]按下`home`键视角看向原点(0,0,0) */
    onHome: () => void;
    /** [键盘事件]按下`ctrl`+`enter`键运行DSL */
    onRun: () => void;
}

export class KeyboardController {
    private readonly editor: HTMLElement | null;
    private readonly actions: KeyboardActions;

    /** [键盘事件监听]按下`home`键视角看向原点(0,0,0) */
    private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Home') {
            this.actions.onHome();
        }
    };

    /** [键盘事件监听]按下`ctrl`+`enter`键运行DSL */
    private readonly onEditorKeyDown = (event: KeyboardEvent): void => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            this.actions.onRun();
        }
    };

    constructor(editor: HTMLElement | null, actions: KeyboardActions) {
        this.editor = editor;
        this.actions = actions;
    }

    /** 绑定所有键盘监听 */
    bind(): void {
        document.addEventListener('keydown', this.onDocumentKeyDown);
        this.editor?.addEventListener('keydown', this.onEditorKeyDown);
    }

    /** 解绑所有键盘监听,与 bind() 成对出现 */
    dispose(): void {
        document.removeEventListener('keydown', this.onDocumentKeyDown);
        this.editor?.removeEventListener('keydown', this.onEditorKeyDown);
    }
}
