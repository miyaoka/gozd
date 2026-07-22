// RPC dispatcher。Swift 版 `RpcDispatcher.swift` の対応物。
//
// renderer からの request は preload → `ipcMain.handle("rpc:request")` → ここに届く。
// body / response は `@gozd/rpc` の型を structured clone でそのまま運ぶ plain data
// （両端が同じ型定義を参照するため codec は不要。routes.ts の cast / satisfies 契約を参照。
// plain data の不変条件は `@gozd/shared` の `ElectronRpcBridge` docstring が SSOT）。

/** push 発射関数。spawn 時の sender に束縛される */
export type PushFn = (type: string, payload: unknown) => void;

export interface RpcContext {
  push: PushFn;
}

// 戻り値は sync / async 両対応。unknown は Promise<unknown> を包含するため union にしない
export type RpcHandler = (body: unknown, ctx: RpcContext) => unknown;

/** 移行中の観測用: 未実装パスは初回のみ stderr に出す（移行チェックリストとして機能する） */
const loggedUnimplemented = new Set<string>();

export function createRpcDispatcher(routes: ReadonlyMap<string, RpcHandler>) {
  return async (path: string, body: unknown, ctx: RpcContext): Promise<unknown> => {
    const handler = routes.get(path);
    if (handler === undefined) {
      if (!loggedUnimplemented.has(path)) {
        loggedUnimplemented.add(path);
        console.error(`[rpc] unimplemented: ${path}`);
      }
      throw new Error(`unimplemented RPC path: ${path}`);
    }
    return handler(body, ctx);
  };
}
