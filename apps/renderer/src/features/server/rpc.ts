// server feature の RPC wrapper (issue #768)。
// 検出結果は push (serverPortsChange) と pull (/server/list) の 2 経路で届き、
// どちらも @gozd/rpc の `ServerEntry` を型付きワイヤで運ぶ。
import type { ServerAttribution, ServerEntry, ServerListResponse } from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

/** サーバープロセスの帰属種別。ワイヤ型をそのまま feature 内部表現として使う。 */
export type ServerAttributionKind = ServerAttribution;

/** 検出した 1 サーバープロセス。ワイヤ型をそのまま feature 内部表現として使う。 */
export type ServerInfo = ServerEntry;

/** mount 時の hydrate。PortScanner の直近 snapshot を pull する。 */
export async function rpcServerList(): Promise<ServerInfo[]> {
  const resp = await rpc<ServerListResponse>("/server/list", {});
  return resp.servers;
}
