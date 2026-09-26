// repo の識別子（projectKey）と、gozd が worktree を置く場所の解決。
//
// - projectKey は `<repoName>-<sha256(realpath)[0..12]>`。worktree 配下のどの dir から
//   呼ばれても main repo root に解決した上で同一 projectKey に揃える
// - worktree の配置先と、プロジェクト単位の永続ファイルの置き場所が同じ値を共有する

import { tryCatch } from "@gozd/shared";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { runGit } from "./git/gitRunner";

/** realpath 解決。対象が存在しない等で失敗したら入力をそのまま返す */
function realpathOrSelf(dir: string): string {
  const result = tryCatch(() => realpathSync(dir));
  return result.ok ? result.value : dir;
}

/** `git rev-parse --git-common-dir` の親 = main worktree のパス。git 外 / 失敗時は dir 自体 */
export async function resolveMainRepoRoot(dir: string): Promise<string> {
  const result = await tryCatch(runGit(["rev-parse", "--git-common-dir"], dir));
  if (!result.ok) return realpathOrSelf(dir);
  const text = result.value.trim();
  // common-dir が相対パスなら dir 起点で resolve する
  const commonDir = isAbsolute(text) ? text : join(dir, text);
  return realpathOrSelf(dirname(commonDir));
}

/** main repo root から projectKey を生成する。形式変更は全 store の保存先を変えるため
 * 変更時は移行コードが必要 */
function computeProjectKey(mainRepoRoot: string): string {
  const resolved = realpathOrSelf(mainRepoRoot);
  const hash = createHash("sha256").update(resolved, "utf8").digest("hex");
  return `${basename(resolved)}-${hash.slice(0, 12)}`;
}

/** dir（main / worktree / 配下 subdir のいずれでも可）から projectKey を解決する。
 * worktree 配置先の決定（worktreeOps）と永続ファイルパスの両方がこの値を共有する */
export async function resolveProjectKey(dir: string): Promise<string> {
  return computeProjectKey(await resolveMainRepoRoot(dir));
}

/** gozd の worktree 配置 root（projectKey 抜き）。`<root>/<projectKey>/<leaf>` が各 worktree のパス。
 * worktreeOps（worktree の作成先）と claudeSessionLog（revive の cwd prefix 判定）が同一 base を
 * 指すことに revive の「cwd 1 バイト一致」が依存するため、literal を 2 箇所に散らさず SSOT を置く。 */
export function gozdWorktreesRoot(): string {
  return join(homedir(), ".local", "share", "gozd", "worktrees");
}
