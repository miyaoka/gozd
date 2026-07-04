// RPC クライアント。preload が contextBridge で公開する `window.__gozdElectronRpc` 経由で
// main process に request を投げる（`ipcMain.handle("rpc:request")` に届く）。
//
// 設計判断:
//
// 1. **proto3 JSON mapping**。`@gozd/proto` から生成された型の `toJSON` /
//    `fromJSON` で encode / decode する。binary は使わない（ブラウザ側で
//    base64 / Uint8Array が煩雑になるため、性能ボトルネックが見えるまで JSON）
//
// 2. **エラーは throw**。ハンドラ未実装・処理失敗は bridge の reject として届くため、
//    tryCatch で受けて Error に包み直す
//
// 3. **fetch(gozd-rpc://) 分岐は Swift shell 期のワイヤの名残**。Swift shell は撤廃済みで
//    Electron では bridge が常に存在するため到達しない dead path だが、proto 廃止
//    （共有 TS 型化）で transport を整理するまで維持する

import { tryCatch, type ElectronRpcBridge } from "@gozd/shared";

interface Codec<T> {
  toJSON(t: T): unknown;
  fromJSON(j: unknown): T;
}

declare global {
  interface Window {
    __gozdElectronRpc?: ElectronRpcBridge;
  }
}

const RPC_BASE = "gozd-rpc://localhost";

export async function rpc<Req, Resp>(
  path: string,
  req: Req,
  reqCodec: Codec<Req>,
  respCodec: Codec<Resp>,
): Promise<Resp> {
  const bodyJson = JSON.stringify(reqCodec.toJSON(req));

  const bridge = window.__gozdElectronRpc;
  if (bridge !== undefined) {
    const result = await tryCatch(bridge.request(path, bodyJson));
    if (!result.ok) {
      throw new Error(`RPC ${path} failed: ${String(result.error)}`);
    }
    return respCodec.fromJSON(JSON.parse(result.value));
  }

  const res = await fetch(`${RPC_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyJson,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC ${path} failed: ${res.status} ${text}`);
  }
  return respCodec.fromJSON(await res.json());
}
