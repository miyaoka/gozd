// `git status --porcelain=v2 -z` 相当のファイル状態を取得する。
//
// issue #310 の方針: 全 RPC は明示的に `dir` を受け取り、
// main 側で `currentDir` を持たないステートレス API として動作する。

import type { UpstreamStatus } from "./common";

export interface GitStatusRequest {
  /** 対象 worktree の絶対パス。 */
  dir: string;
}

export interface GitStatusResponse {
  /** ファイル相対パス → porcelain v2 の XY ステータスコード（例: ".M", "??", "M.", "R."）。
   * 値は常に長さ 2 の文字列。1 文字目 = index 状態、2 文字目 = working tree 状態。
   * 未変更側は "."（v1 の " " と異なる）。 */
  entries: Record<string, string>;
  /** upstream に対する差分。未設定なら不在。 */
  upstream?: UpstreamStatus;
  /** 変更ファイルの最終更新時刻 (Unix 秒)。`entries` の各パスを stat した最大値。
   * clean (差分なし) / stat 全失敗のときは 0。削除済みパスは stat 失敗で自動除外。 */
  latestMtime: number;
  /** rename / copy エントリの 新パス → 旧パス。`entries` のキーは新パスのみ持つため、
   * 旧パス (HEAD 側の比較元) はこの map で運ぶ。rename が無ければ空。 */
  renameOldPaths: Record<string, string>;
  /** HEAD が指す commit OID。unborn branch では空文字。
   * push (`gitStatusChange`) と同じ情報を単発取得でも運ぶ契約 — 片方だけが head を持つと、
   * 受信側が「どちらの経路で来たか」で更新できるフィールドを変える必要が出る。 */
  head: string;
}

// --- main → renderer push payloads (git watch) ---

export interface BranchChangePayload {
  /** 同 repo を共有する worktree 群の中から primary 1 つだけが発火する。
   * `dir` は primary watcher の path で、active worktree とは限らない。subscriber が
   * 「同 repo の event か」を判定する場合は `findRepoOwning(dir).rootDir` を使う。 */
  dir: string;
}

/** `refs/remotes/*` / `packed-refs` の更新 (push / fetch 後) を repo スコープで通知する push。
 * `branchChange` と同じく commonGitDir 単位の primary watcher 1 つに collapse される。
 *
 * `gitStatusChange` との使い分け:
 *   - `gitStatusChange`: per-worktree の ahead/behind と HEAD を更新する経路。dir は source worktree
 *   - `remoteRefsChange`: 「remote ref トポロジが変わった」を repo スコープで通知する経路。
 *     current branch 以外の remote ref が動いた場合、`gitStatusChange` の upstream key は
 *     変化しないため、git log を再 load するトリガはこちらに頼る */
export interface RemoteRefsChangePayload {
  dir: string;
}

export interface WorktreeChangePayload {
  dir: string;
}

/** gitStatusChange push payload。ファイル状態は pull (`GitStatusResponse`) と同形で、
 * push はそこへ発火元 dir と HEAD 情報を足して運ぶ。 */
export type GitStatusChangePayload = GitStatusResponse & {
  dir: string;
  head: string;
  /** HEAD が指す branch 名（`git status --porcelain=v2 --branch` の `# branch.head`）。
   * `git branch -m` は OID を変えないため、rename はこの値の変化で検知する。
   * detached HEAD の場合は空文字。 */
  branchHead: string;
};
