// 任意 path を gozdOpen event payload に変換する。Swift 版 `AppRuntime.buildGozdOpenPayload`
// の対応物。pickAndOpen（ダイアログ選択）と、将来の CLI / socket 経由 OpenMessage の
// 共通エントリポイント。
//
// - git repo 内のパスなら `git rev-parse --show-toplevel` で repo root を解決し、
//   main repo の basename を repoName として使う（worktree から開いた場合 toplevel は
//   その worktree 自身のため、表示用には main repo 名を使う）
// - git 管理外のパスなら targetPath をそのまま dir として使い、isGitRepo=false
// - file 指定（targetPath が file）の場合、selection を埋めて dir は parent にする

import { tryCatch } from "@gozd/shared";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { GitCommandError, runGit } from "./git/gitRunner";
import { resolveMainRepoRoot } from "./taskStore";

/** `git rev-parse --show-toplevel`。git 管理外 / ドメイン失敗は空文字列 */
async function repoTopLevel(dir: string): Promise<string> {
  const result = await tryCatch(runGit(["rev-parse", "--show-toplevel"], dir));
  if (result.ok) return result.value.trim();
  // GitCommandError（git 管理外 / detached 等のドメイン失敗）は「非 git」として扱い、
  // spawn 失敗（git CLI 解決失敗）は throw して caller が payload.error に積む
  if (result.error instanceof GitCommandError) return "";
  throw result.error;
}

export async function buildGozdOpenPayload(targetPath: string): Promise<Record<string, unknown>> {
  const exists = existsSync(targetPath);
  const isDir = exists && statSync(targetPath).isDirectory();

  let probeDir: string;
  let selection: Record<string, unknown> | undefined;
  if (exists && !isDir) {
    // ファイル指定 → parent を dir にして selection を埋める
    probeDir = dirname(targetPath);
    selection = { kind: "file", relPath: basename(targetPath), lineNumber: 0 };
  } else {
    probeDir = targetPath;
  }

  let dir = probeDir;
  let repoName = basename(probeDir);
  let isGitRepo = false;
  let resolverError: string | undefined;
  const toplevelResult = await tryCatch(repoTopLevel(probeDir));
  if (!toplevelResult.ok) {
    // git CLI 解決失敗などの病的環境。renderer に通知して notify.error を出させる
    // （silent に「git repo ではない」扱いに化けさせない）
    resolverError = String(toplevelResult.error);
  } else if (toplevelResult.value !== "") {
    const toplevel = toplevelResult.value;
    dir = toplevel;
    isGitRepo = true;
    // 表示用 repoName は main repo の basename（git-common-dir の親）。
    // resolveMainRepoRoot は失敗時に入力 dir を返すため throw しない
    const mainRoot = await resolveMainRepoRoot(probeDir);
    repoName = basename(mainRoot !== "" ? mainRoot : toplevel);
    // file 指定で probeDir が toplevel と異なる場合、selection.relPath を toplevel
    // からの相対パスに更新する
    if (selection !== undefined && probeDir !== toplevel) {
      const absFile = join(probeDir, selection.relPath as string);
      if (absFile.startsWith(toplevel)) {
        const rel = absFile.slice(toplevel.length);
        selection.relPath = rel.startsWith("/") ? rel.slice(1) : rel;
      }
    }
  }

  const payload: Record<string, unknown> = {
    dir,
    // channel は dev/stable の実行時リソース分離識別子。Electron shell は channel 分離を
    // まだ持たないため空文字（renderer 側は空なら setChannel しない契約）
    channel: "",
    repoName,
    isGitRepo,
    switchToDir: "",
  };
  if (selection !== undefined) payload.selection = selection;
  if (resolverError !== undefined) payload.error = resolverError;
  return payload;
}
