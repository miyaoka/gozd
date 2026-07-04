// TCP LISTEN プロセスの lsof 走査と機械可読出力の parse。
// 帰属判定（live / orphaned / external）と周期 push は portScanner.ts が担い、
// 本モジュールは「今 LISTEN している pid / name / ports の列挙」だけを供給する。

import { tryCatch } from "@gozd/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ListenProcess {
  pid: number;
  name: string;
  ports: number[];
}

/** lsof の -F 機械可読出力（p=pid / c=command / n=address）を ListenProcess 群に変換する */
export function parseLsofOutput(output: string): ListenProcess[] {
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
  }));
}

/** 全 TCP LISTEN プロセスを列挙する。列挙失敗は undefined（呼び出し側が scan を skip する） */
export async function listListenProcesses(): Promise<ListenProcess[] | undefined> {
  const result = await tryCatch(execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]));
  if (!result.ok) {
    // lsof は該当なしのとき exit 1 を返すため、その場合のみ正当な「0 件」扱いにする
    const error = result.error as Error & { code?: number; stdout?: string };
    if (error.code === 1 && (error.stdout === undefined || error.stdout === "")) return [];
    console.error(`[PortScanner] lsof failed: ${result.error}`);
    return undefined;
  }
  return parseLsofOutput(result.value.stdout);
}
