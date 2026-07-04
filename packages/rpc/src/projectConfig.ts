// プロジェクト固有設定 (`~/.config/gozd/projects/<projectKey>/config.json`)。
// projectKey は dir の realpath から main 側で算出する。

import type { EmptyMessage } from "./common";

export interface ProjectConfig {
  /** worktree 作成時にメインリポジトリからシンボリックリンクする相対パス一覧 */
  worktreeSymlinks: string[];
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
