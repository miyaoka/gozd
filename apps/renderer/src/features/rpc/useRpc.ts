import type { FileDiagnostics, OrkisRPC } from "@orkis/rpc";
import Electrobun, { Electroview } from "electrobun/view";

// bun → webview メッセージのコールバックリスト（動的リスナー用）
const listeners = {
  ptyData: [] as Array<(payload: { id: number; data: string }) => void>,
  ptyExit: [] as Array<(payload: { id: number; exitCode: number }) => void>,
  fsChange: [] as Array<(payload: { relDir: string }) => void>,
  gitStatusChange: [] as Array<(payload: { statuses: Record<string, string> }) => void>,
  orkisOpen: [] as Array<
    (payload: { dir: string; file?: string; fileServerBaseUrl: string }) => void
  >,
  orkisHook: [] as Array<(payload: { event: string; payload: Record<string, unknown> }) => void>,
  lspDiagnostics: [] as Array<(payload: FileDiagnostics) => void>,
};

const rpc = Electroview.defineRPC<OrkisRPC>({
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
      orkisOpen: (payload) => {
        for (const fn of listeners.orkisOpen) fn(payload);
      },
      orkisHook: (payload) => {
        for (const fn of listeners.orkisHook) fn(payload);
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
    onPtyData: (fn: (payload: { id: number; data: string }) => void) => subscribe("ptyData", fn),
    onPtyExit: (fn: (payload: { id: number; exitCode: number }) => void) =>
      subscribe("ptyExit", fn),
    onFsChange: (fn: (payload: { relDir: string }) => void) => subscribe("fsChange", fn),
    onGitStatusChange: (fn: (payload: { statuses: Record<string, string> }) => void) =>
      subscribe("gitStatusChange", fn),
    onOrkisOpen: (
      fn: (payload: { dir: string; file?: string; fileServerBaseUrl: string }) => void,
    ) => subscribe("orkisOpen", fn),
    onOrkisHook: (fn: (payload: { event: string; payload: Record<string, unknown> }) => void) =>
      subscribe("orkisHook", fn),
    onLspDiagnostics: (fn: (payload: FileDiagnostics) => void) => subscribe("lspDiagnostics", fn),
  };
}
