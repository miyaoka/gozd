// 実行中サーバー (TCP LISTEN プロセス) の検出結果 (issue #768)。
//
// PortScanner が数秒間隔で全プロセスの LISTEN ソケットを走査し、各プロセスの ppid
// チェーンを辿って worktree に帰属させる。結果は `serverPortsChange` push で全 snapshot
// として renderer に配送する (差分ではなく毎回全件; renderer 側は latest-wins で置換)。
// push payload / pull response の両方が ServerEntry を wire shape として共有する。

import type { EmptyMessage } from "./common";

/** サーバープロセスの帰属種別。main 側 portScanner の内部表現と同一（境界での変換なし）。
 * - "live": 生きている gozd PTY の子孫プロセス。worktreePath / ptyId が有効
 * - "orphaned": かつて gozd PTY 配下だったが PTY は消滅済み (ターミナル / worktree を
 *   閉じた後も port を掴んで生き残ったプロセス)。worktreePath は最後に観測した帰属先
 * - "external": gozd 外のプロセス。port 競合相手が gozd 管理外のケースを可視化する */
export type ServerAttribution = "live" | "orphaned" | "external";

/** 1 つの LISTEN プロセス。同一 pid が複数 port を持つ場合は ports に集約する。 */
export interface ServerEntry {
  pid: number;
  /** プロセス名。例: "node" / "vite"。 */
  name: string;
  /** このプロセスが LISTEN している TCP port 群 (昇順)。 */
  ports: number[];
  attribution: ServerAttribution;
  /** live / orphaned のとき帰属先 worktree の絶対パス。external は空。 */
  worktreePath: string;
  /** live のとき帰属先 PTY id。それ以外は 0。 */
  ptyId: number;
}

/** serverList: renderer mount 時の pull。PortScanner が保持する直近 snapshot を返す。
 * 変化時は push (serverPortsChange) で更新されるため、これは初回 hydrate 専用。 */
export type ServerListRequest = EmptyMessage;
export interface ServerListResponse {
  servers: ServerEntry[];
}
