// 起動 channel（"stable" | "local" | "dev-<worktree hash>"）。SSOT は main の gozdEnv.channel で、
// additionalArguments → preload の contextBridge 経由で `window.__gozdChannel` に届く。

declare global {
  interface Window {
    __gozdChannel?: string;
  }
}

/** タイトルバーに出す channel チップのラベル。stable（release CI ビルド）だけチップなし。
 * 引数欠落や preload 不在（test 環境等）はすべて dev 側に倒す全域定義 */
export function channelChipLabel(): "dev" | "local" | undefined {
  const channel = window.__gozdChannel;
  if (channel === "stable") return undefined;
  if (channel === "local") return "local";
  return "dev";
}
