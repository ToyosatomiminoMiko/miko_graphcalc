declare module '*.css';
declare module '*.js';

/**
 * Vite 的 `import.meta.glob`.只声明本项目用到的形态(`?raw` + `eager`,
 * 返回 `{ [路径]: 原始文本 }`),不引入 `vite/client` 全量类型:它自带
 * `*.css` 等资源模块声明,会与本文件上面的同名声明重复.
 */
interface ImportMeta {
    glob(
        pattern: string,
        options: { query: '?raw'; import: 'default'; eager: true },
    ): Record<string, string>;

    /**
     * Vite 的 HMR 句柄.同样只声明本项目用到的形态:`main.ts` 用它在热替换前
     * 拆掉旧 `DslApp` 的监听与动画帧循环.
     */
    readonly hot?: {
        dispose(callback: () => void): void;
    };
}
