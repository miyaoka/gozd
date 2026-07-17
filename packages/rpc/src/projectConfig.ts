// プロジェクト固有設定 (`~/.config/gozd/projects/<projectKey>/config.json`)。
// projectKey は dir の realpath から main 側で算出する。

import type { EmptyMessage } from "./common";

export interface ProjectConfig {
  /** worktree 作成時にメインリポジトリからシンボリックリンクする相対パス一覧 */
  worktreeSymlinks: string[];
  /** worktree 作成時に専用ターミナルで実行する setup スクリプト（例: `pnpm install`）。空なら実行しない */
  setupScript: string;
}

export interface ProjectConfigLoadRequest {
  dir: string;
}
export interface ProjectConfigLoadResponse {
  config: ProjectConfig;
}

export interface ProjectConfigSaveRequest {
  dir: string;
  config: ProjectConfig;
}
export type ProjectConfigSaveResponse = EmptyMessage;

export interface ProjectConfigEnsureFileRequest {
  dir: string;
}

/** 設定ファイルを実体化して絶対パスを返す（未存在なら default 充填した現在値を書き出す）。
 * settings UI の「Open settings file (JSON)」が preview で開くために使う。 */
export interface ProjectConfigEnsureFileResponse {
  path: string;
}
