// RPC クライアント。preload が contextBridge で公開する `window.__gozdElectronRpc` 経由で
// main process に request を投げる（`ipcMain.handle("rpc:request")` に届く）。
//
// 設計判断:
//
// 1. **型付き JSON ワイヤ**。`@gozd/rpc` の型を JSON.stringify / JSON.parse でそのまま運ぶ。
//    codec は持たない。response 型は feature の rpc wrapper が generic で当てる
//    （main 側 routes.ts が同じ型を `satisfies` でチェックして返す契約なので、
//    ワイヤ両端の型は単一定義を共有する）
//
// 2. **エラーは throw**。ハンドラ未実装・処理失敗は bridge の reject として届くため、
//    tryCatch で受けて Error に包み直す

import { tryCatch, type ElectronRpcBridge } from "@gozd/shared";

declare global {
  interface Window {
    __gozdElectronRpc?: ElectronRpcBridge;
  }
}

export async function rpc<Resp>(path: string, req: unknown): Promise<Resp> {
  const bridge = window.__gozdElectronRpc;
  if (bridge === undefined) {
    // Electron renderer では preload が必ず bridge を公開する。不在は bootstrap 順序の
    // 破綻なので fallback せずエラーにする
    throw new Error(`RPC ${path} failed: electron bridge not available`);
  }
  const result = await tryCatch(bridge.request(path, JSON.stringify(req)));
  if (!result.ok) {
    throw new Error(`RPC ${path} failed: ${String(result.error)}`);
  }
  return JSON.parse(result.value) as Resp;
}
