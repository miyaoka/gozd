// 起動 channel（"stable" | "dev-<worktree hash>"）。SSOT は main の gozdEnv.channel で、
// additionalArguments → preload の contextBridge 経由で `window.__gozdChannel` に届く。

declare global {
  interface Window {
    __gozdChannel?: string;
  }
}

/** stable（packaged .app）を明示的に受け取ったときだけ false。
 * 引数欠落や preload 不在（test 環境等）はすべて非 packaged = dev 側に倒す全域定義 */
export function isDevChannel(): boolean {
  return window.__gozdChannel !== "stable";
}
