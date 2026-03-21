import type { GozdRPC } from "@gozd/rpc";
import Electrobun, { Electroview } from "electrobun/view";

/** RPC スキーマから webview 向けメッセージのペイロード型を導出 */
type Msg = GozdRPC["webview"]["messages"];

// bun → webview メッセージのコールバックリスト（動的リスナー用）
const listeners = {
  ptyData: [] as Array<(payload: Msg["ptyData"]) => void>,
  ptyExit: [] as Array<(payload: Msg["ptyExit"]) => void>,
  fsChange: [] as Array<(payload: Msg["fsChange"]) => void>,
  gitStatusChange: [] as Array<(payload: Msg["gitStatusChange"]) => void>,
  worktreeChange: [] as Array<() => void>,
  gozdOpen: [] as Array<(payload: Msg["gozdOpen"]) => void>,
  gozdHook: [] as Array<(payload: Msg["gozdHook"]) => void>,
  lspDiagnostics: [] as Array<(payload: Msg["lspDiagnostics"]) => void>,
};

const rpc = Electroview.defineRPC<GozdRPC>({
  handlers: {
    requests: {},
    messages: {
      ptyData: (payload) => {
        for (const fn of listeners.ptyData) fn(payload);
      },
      ptyExit: (payload) => {
        for (const fn of listeners.ptyExit) fn(payload);
      },
      fsChange: (payload) => {
        for (const fn of listeners.fsChange) fn(payload);
      },
      gitStatusChange: (payload) => {
        for (const fn of listeners.gitStatusChange) fn(payload);
      },
      worktreeChange: () => {
        for (const fn of listeners.worktreeChange) fn();
      },
      gozdOpen: (payload) => {
        for (const fn of listeners.gozdOpen) fn(payload);
      },
      gozdHook: (payload) => {
        for (const fn of listeners.gozdHook) fn(payload);
      },
      lspDiagnostics: (payload) => {
        for (const fn of listeners.lspDiagnostics) fn(payload);
      },
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

// Electrobun WebView では window.open が機能しないため、
// RPC 経由で bun 側の openExternal に転送する
window.open = (url) => {
  if (typeof url === "string") {
    electrobun.rpc!.send.openExternal({ url });
  }
  return null;
};

/** disposer パターンでリスナーを登録する */
function subscribe<K extends keyof typeof listeners>(key: K, fn: (typeof listeners)[K][number]) {
  (listeners[key] as Array<typeof fn>).push(fn);
  return () => {
    const arr = listeners[key] as Array<typeof fn>;
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  };
}

export function useRpc() {
  return {
    /** request（Promise ベース、bun が処理して応答を返す） */
    request: electrobun.rpc!.request,
    /** message（一方向、bun 側の handlers.messages で受信） */
    send: electrobun.rpc!.send,

    // bun → webview メッセージの購読
    onPtyData: (fn: (payload: Msg["ptyData"]) => void) => subscribe("ptyData", fn),
    onPtyExit: (fn: (payload: Msg["ptyExit"]) => void) => subscribe("ptyExit", fn),
    onFsChange: (fn: (payload: Msg["fsChange"]) => void) => subscribe("fsChange", fn),
    onGitStatusChange: (fn: (payload: Msg["gitStatusChange"]) => void) =>
      subscribe("gitStatusChange", fn),
    onWorktreeChange: (fn: () => void) => subscribe("worktreeChange", fn),
    onGozdOpen: (fn: (payload: Msg["gozdOpen"]) => void) => subscribe("gozdOpen", fn),
    onGozdHook: (fn: (payload: Msg["gozdHook"]) => void) => subscribe("gozdHook", fn),
    onLspDiagnostics: (fn: (payload: Msg["lspDiagnostics"]) => void) =>
      subscribe("lspDiagnostics", fn),
  };
}
