/**
 * 仅保留错误与警告的紧凑提示控制器.
 *
 * 计算成功信息不进入这里;解析/编译错误/资源降采样等警告
 * 会显示在右侧参数滑块下方.
 *
 * 容器在 HTML 里带 `aria-live="polite"`:任何 DOM 变动都会被读屏播报,所以
 * 渲染层走 `render(list)`(整体替换,内容一致时**一次 DOM 操作都不做**),而不是
 * 每帧 `clear()` + 逐条 `add()` -- 后者在拖参数时会每帧重放同一批警告(UI-P3.7).
 * `add`/`clear` 保留给"一次性提示"场景(如 DslApp.run 的编译错误).
 */
export type DiagnosticLevel = 'warning' | 'error';

/** 一条诊断提示(渲染层的输入形状). */
export interface DiagnosticEntry {
    readonly level: DiagnosticLevel;
    readonly message: string;
}

interface DiagnosticNode {
    /** 去重/复用键:`level` + 消息. */
    readonly key: string;
    readonly node: HTMLElement;
}

/** 诊断条目键.用不可见分隔符,避免 level 与消息拼接后产生歧义. */
function diagnosticKey(level: DiagnosticLevel, message: string): string {
    return `${level}\u0000${message}`;
}

export class DiagnosticsController {
    private entries: DiagnosticNode[] = [];

    constructor(private readonly container: HTMLElement) {}

    clear(): void {
        this.container.replaceChildren();
        this.entries = [];
    }

    add(level: DiagnosticLevel, message: string): void {
        const node = this._createNode(level, message);
        this.entries.push({ key: diagnosticKey(level, message), node });
        this.container.append(node);
    }

    /**
     * 用一批诊断整体替换当前内容.
     *
     * 键序列与当前一致时直接返回:内容没变就不碰 DOM,live region 不会重复播报.
     * 变了则尽量复用同键节点,只移动/替换确实变化的部分.
     */
    render(next: readonly DiagnosticEntry[]): void {
        const nextKeys = next.map((entry) => diagnosticKey(entry.level, entry.message));
        const unchanged = nextKeys.length === this.entries.length
            && nextKeys.every((key, index) => key === this.entries[index].key);
        if (unchanged) return;

        // 按 key 分桶复用旧节点(同一键可能出现多条,所以是桶不是单值).
        const pool = new Map<string, HTMLElement[]>();
        for (const entry of this.entries) {
            const bucket = pool.get(entry.key);
            if (bucket) bucket.push(entry.node);
            else pool.set(entry.key, [entry.node]);
        }

        this.entries = next.map((entry) => {
            const key = diagnosticKey(entry.level, entry.message);
            const node = pool.get(key)?.shift() ?? this._createNode(entry.level, entry.message);
            return { key, node };
        });
        this.container.replaceChildren(...this.entries.map((entry) => entry.node));
    }

    dispose(): void {
        this.clear();
    }

    private _createNode(level: DiagnosticLevel, message: string): HTMLElement {
        const entry = document.createElement('div');
        entry.className = `diagnostic diagnostic-${level}`;
        entry.textContent = `[${level}] ${message}`;
        return entry;
    }
}
