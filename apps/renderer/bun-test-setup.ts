// bun:test は DOM globals を持たないため、`shared/rpc/messages.ts` の
// `window.__gozdReceive = ...` モジュールトップレベル副作用が走った瞬間に
// `ReferenceError: window is not defined` で全 test がロード失敗する。
//
// この preload で最小限の `window` スタブを定義することで、worktree barrel 等の
// 上流モジュールを test 環境からも load 可能にする (関数 SSOT を `pathUtils.ts` に
// 置く設計を成立させるための構造的前提)。
//
// 実 listener 登録は test 中に呼ばれないため shim 自体は何もしない。

if (typeof globalThis.window === "undefined") {
  (globalThis as { window: unknown }).window = globalThis;
}
