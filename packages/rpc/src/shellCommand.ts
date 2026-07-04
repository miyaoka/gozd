// `gozd` shell コマンドのインストール / アンインストール。
// `~/.local/bin/gozd` に .app 内 wrapper への symlink を作る / 消す。

import type { EmptyMessage } from "./common";

export type ShellCommandInstallRequest = EmptyMessage;
export interface ShellCommandInstallResponse {
  /** symlink 配置先（`~/.local/bin/gozd`） */
  source: string;
  /** symlink が指す先（.app 内 wrapper の絶対パス） */
  target: string;
  /** 既に同じ target を指す symlink が存在し、何もしなかった */
  alreadyInstalled: boolean;
  /** 別の target を指していた symlink を上書きした */
  replaced: boolean;
}

export type ShellCommandUninstallRequest = EmptyMessage;
export interface ShellCommandUninstallResponse {
  source: string;
  /** 削除した（存在し、かつこの .app の wrapper を指していた） */
  removed: boolean;
  /** 既に存在しなかった */
  notInstalled: boolean;
}
