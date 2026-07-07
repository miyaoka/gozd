// server feature の RPC wrapper と wire 型の正規化 (issue #768)。
//
// 検出結果は 2 経路で届く:
//   - push (serverPortsChange): main が手組み dict で送る
//   - pull (/server/list): ServerListResponse（型付きワイヤ）
// attribution は両経路とも main 内部表現と同じ文字列。push は手組み dict のため
// 防御的に正規化して feature 内部型 `ServerInfo` に揃える。
import type { ServerAttribution, ServerEntry, ServerListResponse } from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

/** サーバープロセスの帰属種別。ワイヤ型をそのまま feature 内部表現として使う。 */
export type ServerAttributionKind = ServerAttribution;

/** 検出した 1 サーバープロセス。ワイヤ型をそのまま feature 内部表現として使う。 */
export type ServerInfo = ServerEntry;

/** serverPortsChange push payload (main の手組み dict と一致)。 */
export interface ServerPortsChangePayload {
  servers: {
    pid: number;
    name: string;
    ports: number[];
    attribution: string;
    worktreePath: string;
    ptyId: number;
  }[];
}

// 文字列 (push) → 帰属種別。任意文字列が来うる部分マッピングなので参照側で
// `?? "external"` の fallback が機能的に必要（帰属不明 = gozd 外扱いが最も無害）。
const STRING_ATTRIBUTION: Record<string, ServerAttributionKind> = {
  live: "live",
  orphaned: "orphaned",
  external: "external",
};

/** push payload を ServerInfo[] に正規化する。 */
export function serversFromPayload(payload: ServerPortsChangePayload): ServerInfo[] {
  return payload.servers.map((s) => ({
    ...s,
    attribution: STRING_ATTRIBUTION[s.attribution] ?? "external",
  }));
}

/** mount 時の hydrate。PortScanner の直近 snapshot を pull する。 */
export async function rpcServerList(): Promise<ServerInfo[]> {
  const resp = await rpc<ServerListResponse>("/server/list", {});
  return resp.servers;
}
