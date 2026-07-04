// 実行中サーバー（TCP LISTEN プロセス）の定期ポーリング検出。Swift 版 `PortScanner.swift`
// の対応物（issue #768）。
//
// macOS にはソケットの LISTEN 開始を通知する event API が無いため、lsof で全 LISTEN を
// 周期スキャンする。各 LISTEN プロセスの ppid チェーン（ps -axo pid=,ppid=）を辿り、
// 祖先が gozd PTY の shell プロセスなら当該 worktree に帰属させる。
//
// 帰属の 3 分類:
//   - live:     生きている PTY の子孫。worktreePath / ptyId が有効
//   - orphaned: 過去に live 帰属したが PTY が消滅（ターミナルを閉じた後も port を掴む）
//   - external: gozd 外のプロセス
//
// snapshot は前回と差分があるときだけ onSnapshot に渡す（push churn 抑制）。
// renderer mount 時の初回 hydrate は `/server/list` が current() を pull する。
// 列挙（lsof / ps）が失敗したスキャンは丸ごと skip する: ps 失敗時は ppid チェーンが
// 辿れず全サーバーが誤帰属し、lsof 失敗時は「0 件」誤 snapshot で全バッジが消える。
// どちらも次の成功スキャンまで前回 snapshot を維持する（空配列 = 正当な 0 件は push する）。

import { tryCatch } from "@gozd/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ListenProcess } from "./serverList";

const execFileAsync = promisify(execFile);

const SCAN_INTERVAL_MS = 3000;
// ppid チェーンを辿る最大段数。循環 / 異常な親子関係でも無限ループしない安全弁
const MAX_ANCESTRY_DEPTH = 64;

export type ServerAttributionKind = "live" | "orphaned" | "external";

export interface ScannedServer {
  pid: number;
  name: string;
  ports: number[];
  attribution: ServerAttributionKind;
  worktreePath: string;
  ptyId: number;
}

export interface PtyOwner {
  ptyId: number;
  worktreePath: string;
}

/** 全プロセスの pid → ppid。列挙失敗は undefined（呼び出し側が scan を skip する） */
export async function listProcParents(): Promise<Map<number, number> | undefined> {
  const result = await tryCatch(execFileAsync("ps", ["-axo", "pid=,ppid="]));
  if (!result.ok) {
    console.error(`[PortScanner] ps failed: ${result.error}`);
    return undefined;
  }
  const parents = new Map<number, number>();
  for (const line of result.value.stdout.split("\n")) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid, ppid);
  }
  return parents;
}

interface PortScannerDeps {
  /** 全 TCP LISTEN プロセス。列挙失敗は undefined（scan を skip） */
  listListenProcesses: () => Promise<ListenProcess[] | undefined>;
  /** 全プロセスの pid → ppid。列挙失敗は undefined（scan を skip） */
  listProcParents: () => Promise<Map<number, number> | undefined>;
  /** gozd PTY の shell pid → 帰属先。routes.ts の pty registry から都度取得する */
  ptyOwners: () => Map<number, PtyOwner>;
  onSnapshot: (servers: ScannedServer[]) => void;
}

export function createPortScanner(deps: PortScannerDeps) {
  // 一度 live 帰属した LISTEN pid → 最後に観測した worktreePath。PTY 消滅後に
  // orphaned 判定するために記憶する。プロセス消滅時に scan 末尾で掃除するため
  // 無制限には伸びない。pid 再利用の理論的リスクはあるが、観測のみで破壊操作は
  // しないため許容する（Swift 版と同じ判断）
  const knownWorktreeByPid = new Map<number, string>();
  let lastSnapshot: ScannedServer[] = [];
  let pushedOnce = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let scanning = false;

  function attribute(
    pid: number,
    parents: Map<number, number>,
    owners: Map<number, PtyOwner>,
  ): { attribution: ServerAttributionKind; worktreePath: string; ptyId: number } {
    let cursor = pid;
    let depth = 0;
    while (cursor > 1 && depth < MAX_ANCESTRY_DEPTH) {
      const owner = owners.get(cursor);
      if (owner !== undefined) {
        knownWorktreeByPid.set(pid, owner.worktreePath);
        return { attribution: "live", worktreePath: owner.worktreePath, ptyId: owner.ptyId };
      }
      const parent = parents.get(cursor);
      if (parent === undefined) break;
      cursor = parent;
      depth += 1;
    }
    const remembered = knownWorktreeByPid.get(pid);
    if (remembered !== undefined) {
      return { attribution: "orphaned", worktreePath: remembered, ptyId: 0 };
    }
    return { attribution: "external", worktreePath: "", ptyId: 0 };
  }

  async function scanOnce(): Promise<void> {
    // interval と手動呼び出しの並走で scan が重ならないようにする
    if (scanning) return;
    scanning = true;
    const listens = await deps.listListenProcesses();
    const parents = await deps.listProcParents();
    scanning = false;
    if (listens === undefined || parents === undefined) return;

    const owners = deps.ptyOwners();
    const servers: ScannedServer[] = listens.map((listen) => {
      const resolved = attribute(listen.pid, parents, owners);
      return {
        pid: listen.pid,
        name: listen.name,
        ports: [...listen.ports].sort((a, b) => a - b),
        attribution: resolved.attribution,
        worktreePath: resolved.worktreePath,
        ptyId: resolved.ptyId,
      };
    });
    // port 昇順 → pid 昇順で安定ソート。差分比較の安定性も担保する
    servers.sort((lhs, rhs) => {
      const lp = lhs.ports[0] ?? Number.MAX_SAFE_INTEGER;
      const rp = rhs.ports[0] ?? Number.MAX_SAFE_INTEGER;
      return lp !== rp ? lp - rp : lhs.pid - rhs.pid;
    });

    // 消滅済み pid を記憶から掃除する（orphaned 記憶が無制限に伸びるのを防ぐ）
    for (const pid of knownWorktreeByPid.keys()) {
      if (!parents.has(pid)) knownWorktreeByPid.delete(pid);
    }

    // ソート済み + フィールド順固定なので JSON 比較で差分判定できる
    if (pushedOnce && JSON.stringify(servers) === JSON.stringify(lastSnapshot)) return;
    lastSnapshot = servers;
    pushedOnce = true;
    deps.onSnapshot(servers);
  }

  function start(): void {
    if (timer !== undefined) return;
    // 初回は即座に scan する。起動直後の push が renderer mount 前で取りこぼされても、
    // mount 時の `/server/list` pull（current）が hydrate するため遅延は不要
    void scanOnce();
    timer = setInterval(() => void scanOnce(), SCAN_INTERVAL_MS);
  }

  function stop(): void {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  }

  /** renderer mount 時の pull 応答用。直近 snapshot を返す */
  function current(): ScannedServer[] {
    return lastSnapshot;
  }

  return { start, stop, current, scanOnce };
}
