// `gozd` shell コマンドを `~/.local/bin/gozd` に symlink で配置 / 削除する。
// Swift 版 `Shell/ShellCommandOps.swift` の対応物。
//
// VSCode の「Shell Command: Install 'code' command in PATH」と同じ思想だが、
// `/usr/local/bin` ではなく `~/.local/bin` を使うため権限昇格は不要。
//
// target は app バンドル内 wrapper（`Resources/app/bin/gozd`）。`gozd-cli` バイナリ
// ではなく wrapper を指す理由:
//   - wrapper が cold/warm start を判定して socket 経路 / `open` 経路を切り替える
//   - bypass すると hook 用の起動連携が壊れる
//
// dev（未パッケージ実行）では target が存在せず targetNotFound エラーになる
// （Swift 期の dev 実行と同じ挙動）。packaged app では electron-builder が
// `Resources/app/bin/gozd` に wrapper を同梱するため実在し、install が機能する。

import { tryCatch } from "@gozd/shared";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

function sourcePath(): string {
  return join(homedir(), ".local", "bin", "gozd");
}

/** app バンドル内 wrapper の絶対パス。不在 / 実行不可なら throw（Swift targetNotFound 相当） */
function targetPath(): string {
  const path = join(process.resourcesPath, "app", "bin", "gozd");
  const executable = tryCatch(() => accessSync(path, constants.X_OK));
  if (!executable.ok) {
    throw new Error(`shell command target not found or not executable: ${path}`);
  }
  return path;
}

/** source にある symlink のリンク先を絶対パスに正規化して返す。symlink でなければ undefined */
function readSymlinkTarget(source: string): string | undefined {
  const stat = tryCatch(() => lstatSync(source));
  if (!stat.ok || !stat.value.isSymbolicLink()) return undefined;
  const link = tryCatch(() => readlinkSync(source));
  if (!link.ok) return undefined;
  // 相対 symlink にも対応するため絶対パスに正規化してから比較
  return resolve(isAbsolute(link.value) ? link.value : join(dirname(source), link.value));
}

export interface ShellCommandInstallResult {
  source: string;
  target: string;
  alreadyInstalled: boolean;
  replaced: boolean;
}

export function installShellCommand(): ShellCommandInstallResult {
  const source = sourcePath();
  const target = targetPath();

  mkdirSync(dirname(source), { recursive: true });

  const existingTarget = readSymlinkTarget(source);
  if (existingTarget !== undefined) {
    if (existingTarget === resolve(target)) {
      return { source, target, alreadyInstalled: true, replaced: false };
    }
    // 別の app（旧版 / dev / 別チャンネル相当）を指す symlink は上書きする
    unlinkSync(source);
    symlinkSync(target, source);
    return { source, target, alreadyInstalled: false, replaced: true };
  }

  // symlink ではない通常ファイルが存在する場合は上書きしない（ユーザーが置いた可能性があるため）
  if (existsSync(source)) {
    throw new Error(`~/.local/bin/gozd exists and is not a symlink: ${source}`);
  }

  symlinkSync(target, source);
  return { source, target, alreadyInstalled: false, replaced: false };
}

export interface ShellCommandUninstallResult {
  source: string;
  removed: boolean;
  notInstalled: boolean;
}

/** この app の wrapper を指す symlink のみ削除する。
 * 他の app を指す symlink や regular file には触らない（誤削除防止） */
export function uninstallShellCommand(): ShellCommandUninstallResult {
  const source = sourcePath();

  const existingTarget = readSymlinkTarget(source);
  if (existingTarget === undefined) {
    return { source, removed: false, notInstalled: true };
  }

  // target 解決失敗（未パッケージ環境で uninstall されたケース）でも source を消す判定に
  // すると意外性があるため、「target を解決できる かつ 一致する」ときのみ消す方針にする
  const target = tryCatch(() => targetPath());
  if (!target.ok) {
    return { source, removed: false, notInstalled: false };
  }

  if (existingTarget === resolve(target.value)) {
    unlinkSync(source);
    return { source, removed: true, notInstalled: false };
  }
  return { source, removed: false, notInstalled: false };
}
