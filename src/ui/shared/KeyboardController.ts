/**
 * KeyboardController -- 全应用唯一的键盘事件出口.
 *
 * 整个应用只有这里对 `document` 绑一次 `keydown`:内置快捷键与组件级键盘
 * 激活都表示成一条 KeyboardBinding,由本控制器按注册顺序路由.组件不再各自
 * `addEventListener('keydown')`,所以"哪些键,命中什么目标,命中后做什么"
 * 只需看这一个文件,监听也天然成对(一次 bind / 一次 dispose).
 *
 * 内置绑定:
 * - Home           -> 视角看向原点(0,0,0);焦点在输入控件里时让位给控件
 * - Ctrl/Cmd+Enter -> 运行 DSL(仅当事件目标是编辑器)
 *
 * 组件绑定(经 register 注入,见 DslApp):
 * - 公式的 Enter/Space 复制(FormulaCopyController.keyboardBinding())
 * - 示例浮层的 Esc / 上下键(ExampleLoaderController.keyboardBindings())
 * - 单窗口全屏的 Esc 退出(注册在示例浮层之后:菜单开着时先关菜单)
 *
 * 绑定/解绑严格成对:bind() 之后必须 dispose(),DslApp.dispose() 负责清理.
 */
export interface KeyboardActions {
    /** [键盘事件]按下`home`键视角看向原点(0,0,0) */
    onHome: () => void;
    /** [键盘事件]按下`ctrl`+`enter`键运行DSL */
    onRun: () => void;
}

/**
 * 一条键盘绑定.
 *
 * `keys` 只做粗筛(命中 `event.key`),真正的目标判断放在 `resolve`:
 * 返回处理函数代表"这次事件归本绑定",控制器会 `preventDefault()` 并调用它;
 * 返回 null 表示放行,继续问下一条.
 */
export interface KeyboardBinding {
    /** 关心的 `event.key` 集合. */
    readonly keys: readonly string[];
    /** 命中键名后判定目标;返回 null 表示让给后续绑定. */
    resolve(event: KeyboardEvent): (() => void) | null;
}

/**
 * 焦点是否落在有自己键盘语义的控件里.
 *
 * `Home` 在 textarea/输入框里是"光标回行首",在 range 上是"跳到最小值",
 * 在 contenteditable 里是"移到行首";这些都必须原样留给控件,不能被全局
 * 快捷键连坐(旧实现只看 `event.key === 'Home'`,在编辑器里会同时重置视角).
 *
 * 导出给组件级绑定复用:"什么算输入目标"只需要一份判断.
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

export class KeyboardController {
    private readonly editor: HTMLElement | null;
    private readonly actions: KeyboardActions;

    /**
     * 注册表:内置两条在前,组件绑定 append 在后,先命中者先处理.
     * keydown 在目标上冒泡到 document,所以编辑器快捷键不需要单独绑监听.
     */
    private readonly bindings: KeyboardBinding[];

    constructor(editor: HTMLElement | null, actions: KeyboardActions) {
        this.editor = editor;
        this.actions = actions;
        this.bindings = [
            {
                keys: ['Home'],
                // 焦点在输入控件里时让位,既不重置视角也不吞掉控件自己的 Home 行为.
                resolve: (event) => isTypingTarget(event.target)
                    ? null
                    : () => this.actions.onHome(),
            },
            {
                keys: ['Enter'],
                resolve: (event) => {
                    if (!(event.ctrlKey || event.metaKey)) return null;
                    if (event.target !== this.editor) return null;
                    return () => this.actions.onRun();
                },
            },
        ];
    }

    /** 注册组件级键盘激活;重复 register 按调用顺序排队,不做去重. */
    register(binding: KeyboardBinding): void {
        this.bindings.push(binding);
    }

    /**
     * 全局唯一的 keydown 监听.
     *
     * 命中即停:一条绑定处理过的事件不再向下传,避免"复制公式顺手切了视角"
     * 这类叠加;命中且由本控制器执行时统一 preventDefault(需要保留默认行为
     * 的绑定不应注册到这里,而应自己判断后返回 null).
     */
    private readonly onKeyDown = (event: KeyboardEvent): void => {
        for (const binding of this.bindings) {
            if (!binding.keys.includes(event.key)) continue;
            const run = binding.resolve(event);
            if (run === null) continue;
            event.preventDefault();
            run();
            return;
        }
    };

    /** 绑定全局 keydown 监听 */
    bind(): void {
        document.addEventListener('keydown', this.onKeyDown);
    }

    /** 解绑全局 keydown 监听,与 bind() 成对出现 */
    dispose(): void {
        document.removeEventListener('keydown', this.onKeyDown);
    }
}
