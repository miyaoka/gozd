// 実行中サーバー（TCP LISTEN プロセス）の検出。Swift 版 `PortScanner.swift` の
// 初回 hydrate（/server/list）対応物。
//
// 現段階は lsof の単発走査で、全件 attribution = EXTERNAL を返す。
// PTY 子孫判定（LIVE / ORPHANED）と serverPortsChange push は PTY 環境変数
// （GOZD_PTY_ID）統合ステップで移植する。

import { ServerAttribution, type ServerEntry } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** lsof の -F 機械可読出力（p=pid / c=command / n=address）を ServerEntry 群に変換する */
export function parseLsofOutput(output: string): ServerEntry[] {
  const byPid = new Map<number, { name: string; ports: Set<number> }>();
  let currentPid = 0;
  let currentName = "";
  for (const line of output.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      currentPid = Number(value);
      continue;
    }
    if (tag === "c") {
      currentName = value;
      continue;
    }
    if (tag !== "n") continue;
    // n の値は `*:8080` / `127.0.0.1:8080` / `[::1]:8080` 形式。最後の `:` 以降が port
    const port = Number(value.slice(value.lastIndexOf(":") + 1));
    if (!Number.isInteger(port)) continue;
    const entry = byPid.get(currentPid) ?? { name: currentName, ports: new Set() };
    entry.ports.add(port);
    byPid.set(currentPid, entry);
  }
  return [...byPid.entries()].map(([pid, { name, ports }]) => ({
    pid,
    name,
    ports: [...ports].sort((a, b) => a - b),
    attribution: ServerAttribution.SERVER_ATTRIBUTION_EXTERNAL,
    worktreePath: "",
    ptyId: 0,
  }));
}

export async function scanListenServers(): Promise<ServerEntry[]> {
  const result = await tryCatch(execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]));
  if (!result.ok) {
    // lsof は該当なしのとき exit 1 を返すため、その場合のみ空扱いにする
    const error = result.error as Error & { code?: number; stdout?: string };
    if (error.code === 1 && (error.stdout === undefined || error.stdout === "")) return [];
    throw result.error;
  }
  return parseLsofOutput(result.value.stdout);
}
