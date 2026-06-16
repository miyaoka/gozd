// server feature の RPC wrapper と wire 型の正規化 (issue #768)。
//
// native からの検出結果は 2 経路で届く:
//   - push (serverPortsChange): AppRuntime が手組み dict で送る。attribution は文字列
//   - pull (/server/list): proto ServerEntry。attribution は enum
// どちらも feature 内部型 `ServerInfo` に正規化して store が一元的に扱う。
import {
  ServerAttribution,
  ServerEntry,
  ServerListRequest,
  ServerListResponse,
  WindowSetServerPanelOpenRequest,
  WindowSetServerPanelOpenResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

/** サーバープロセスの帰属種別 (feature 内部表現)。 */
export type ServerAttributionKind = "live" | "orphaned" | "external";

/** 検出した 1 サーバープロセス (feature 内部表現)。 */
export interface ServerInfo {
  pid: number;
  name: string;
  ports: number[];
  attribution: ServerAttributionKind;
  /** live / orphaned のとき帰属先 worktree の絶対パス。external は空。 */
  worktreePath: string;
  /** live のとき帰属先 PTY id。それ以外は 0。 */
  ptyId: number;
}

/** serverPortsChange push payload (AppRuntime の手組み dict と一致)。 */
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

// proto enum → feature 内部表現。enum 全値を網羅する全域マッピングなので呼び出し側の
// fallback は不要。UNSPECIFIED / UNRECOGNIZED は「帰属不明 = gozd 外扱い」が最も無害。
const PROTO_ATTRIBUTION: Record<ServerAttribution, ServerAttributionKind> = {
  [ServerAttribution.SERVER_ATTRIBUTION_LIVE]: "live",
  [ServerAttribution.SERVER_ATTRIBUTION_ORPHANED]: "orphaned",
  [ServerAttribution.SERVER_ATTRIBUTION_EXTERNAL]: "external",
  [ServerAttribution.SERVER_ATTRIBUTION_UNSPECIFIED]: "external",
  [ServerAttribution.UNRECOGNIZED]: "external",
};

// 文字列 (push) → feature 内部表現。任意文字列が来うる部分マッピングなので参照側で
// `?? "external"` の fallback が機能的に必要 (PROTO_ATTRIBUTION との非対称はこのため)。
const STRING_ATTRIBUTION: Record<string, ServerAttributionKind> = {
  live: "live",
  orphaned: "orphaned",
  external: "external",
};

function fromProtoEntry(entry: ServerEntry): ServerInfo {
  return {
    pid: entry.pid,
    name: entry.name,
    ports: entry.ports,
    attribution: PROTO_ATTRIBUTION[entry.attribution],
    worktreePath: entry.worktreePath,
    ptyId: entry.ptyId,
  };
}

/** push payload を ServerInfo[] に正規化する。 */
export function serversFromPayload(payload: ServerPortsChangePayload): ServerInfo[] {
  return payload.servers.map((s) => ({
    pid: s.pid,
    name: s.name,
    ports: s.ports,
    attribution: STRING_ATTRIBUTION[s.attribution] ?? "external",
    worktreePath: s.worktreePath,
    ptyId: s.ptyId,
  }));
}

/** mount 時の hydrate。PortScanner の直近 snapshot を pull する。 */
export async function rpcServerList(): Promise<ServerInfo[]> {
  const resp = await rpc(
    "/server/list",
    ServerListRequest.create(),
    ServerListRequest,
    ServerListResponse,
  );
  return resp.servers.map(fromProtoEntry);
}

/** パネル開閉状態を native titlebar のトグルボタンにミラーする。 */
export const rpcWindowSetServerPanelOpen = (open: boolean) =>
  rpc(
    "/window/setServerPanelOpen",
    WindowSetServerPanelOpenRequest.create({ open }),
    WindowSetServerPanelOpenRequest,
    WindowSetServerPanelOpenResponse,
  );
