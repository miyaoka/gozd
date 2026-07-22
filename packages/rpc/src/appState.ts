// アプリのウィンドウ状態。`~/.local/state/gozd/app-state.json` に永続化される。
// 「前回の続き」を表す state であり、ユーザー設定 (config) ではないため XDG state
// ディレクトリ (~/.local/state) に置く。
//
// RPC ワイヤーフォーマットと永続化形式を同一の型で揃え、独自シリアライズとの
// 二重管理を避ける（読み書きは main 側 stores.ts。未知 top-level キーの保持と
// 既知キーの事前削除という shallow merge 規律もそちらが持つ）。

import type { EmptyMessage } from "./common";

export interface AppState {
  /** window 内に同居する repo プール（全 repo list の union）。順序は追加順で、
   * 表示順は各 repo list の dirOrder が持つ */
  sidebarRepos: SidebarRepo[];
  /** サイドバーの表示単位。repo プールの部分集合 + 並び順を名前付きで持つ。
   * 常に 1 個以上（空 / 不整合は renderer の hydrate が Default 1 個に正規化する） */
  repoLists: RepoList[];
  /** アクティブな repo list の id。不整合は hydrate が先頭 repo list に倒す */
  activeRepoListId: string;
  /** 最後に選択していた worktree path（非 git project は rootDir）。次回起動時に
   * 復元してターミナルを自動で開く。未選択はキー不在（undefined）で表現する。
   * CLI の launch request（`gozd <dir>`）がある起動では復元より明示 open を優先する。 */
  activeDir?: string;
}

/** サイドバーの repo list。repo プールに対する名前付きビュー（表示 repo の部分集合 + 並び順）。
 * 1 repo は複数 repo list に所属できる。 */
export interface RepoList {
  id: string;
  name: string;
  /** この repo list に表示する repo の rootDir 列。順序 = 表示順 */
  dirOrder: string[];
}

/** サイドバー上の 1 repo の永続化エントリ。 */
export interface SidebarRepo {
  rootDir: string;
  repoName: string;
  isGitRepo: boolean;
  collapsed: boolean;
  /** worktree 一覧の起動時キャッシュ。SSOT は git。起動直後はこのキャッシュから
   * 実カードを描画して layout shift を消し、rpcGitWorktreeList の真値で上書きする。
   * path/branch/isMain のみ持つ。git status / tasks は SSOT が別 (git / tasks.json)
   * なのでキャッシュしない (二重保持回避)。 */
  worktrees: WorktreeCacheEntry[];
}

/** worktree 一覧の最小キャッシュ要素。WorktreeEntry (common.ts) のうち、起動直後の
 * カード描画に必要な最小サブセット。 */
export interface WorktreeCacheEntry {
  path: string;
  branch: string;
  isMain: boolean;
}

export type LoadAppStateRequest = EmptyMessage;

export interface LoadAppStateResponse {
  state: AppState;
}

export interface SaveAppStateRequest {
  state: AppState;
}

export type SaveAppStateResponse = EmptyMessage;
