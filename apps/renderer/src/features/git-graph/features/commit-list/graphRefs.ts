import type { GitCommit } from "@gozd/rpc";
import type { DisplayRef } from "./displayRef";

/**
 * ローカルとリモートが異なるコミットに存在するブランチ名の Set を導出する (純関数)。
 * 同じコミットにローカルとリモートが両方あれば synced（computeDisplayRefs で処理）。
 * 別コミットに分かれていれば out-of-sync としてここで検出する。
 *
 * 検出範囲は `commits` に出現する ref に限定される。`currentBranchOnly` が ON のとき
 * native 側の `git log` 始点 ref が HEAD のみに絞られ origin/<default> 系の commit が消えるため、
 * HEAD 系統から到達しない ref ペアの out-of-sync は検出できない (toggle 意味の直接の帰結)。
 */
export function computeOutOfSyncBranches(commits: GitCommit[]): Set<string> {
  const localCommits = new Map<string, string>();
  const remoteCommits = new Map<string, string>();

  for (const commit of commits) {
    for (const r of commit.refs) {
      if (r === "HEAD" || r === "origin/HEAD") continue;
      if (r.startsWith("tag:")) continue;
      if (r.startsWith("origin/")) {
        const name = r.slice("origin/".length);
        remoteCommits.set(name, commit.hash);
      } else {
        localCommits.set(r, commit.hash);
      }
    }
  }

  const result = new Set<string>();
  for (const [name, localHash] of localCommits) {
    const remoteHash = remoteCommits.get(name);
    if (remoteHash && remoteHash !== localHash) {
      result.add(name);
    }
  }
  return result;
}

/**
 * commit の refs を RefBadge 用の DisplayRef 列に分類する (純関数)。ローカルと origin が同コミットなら
 * synced に統合し、HEAD / origin/HEAD は除外する (HEAD は → マーカーで別途表示するため)。
 */
export function computeDisplayRefs(
  refs: string[],
  currentBranchName?: string,
  defaultBranchName?: string,
  outOfSyncSet?: Set<string>,
): DisplayRef[] {
  const filtered = refs.filter((r) => r !== "HEAD" && r !== "origin/HEAD");
  const locals = new Set(filtered.filter((r) => !r.startsWith("origin/") && !r.startsWith("tag:")));
  const remotes = new Set(
    filtered.filter((r) => r.startsWith("origin/")).map((r) => r.slice("origin/".length)),
  );
  const tags = filtered.filter((r) => r.startsWith("tag:"));

  const result: DisplayRef[] = [];

  // ローカルブランチ
  for (const local of locals) {
    const isSynced = remotes.has(local);
    if (isSynced) remotes.delete(local);
    const type = isSynced ? "synced" : "local";
    const isCurrent = local === currentBranchName;
    const isDefault = local === defaultBranchName;
    const isOutOfSync = !isSynced && (outOfSyncSet?.has(local) ?? false);
    result.push({ label: local, type, isSynced, isOutOfSync, isCurrent, isDefault });
  }

  // origin のみ（ローカルに対応がない）
  for (const remote of remotes) {
    const isCurrent = remote === currentBranchName;
    const isDefault = remote === defaultBranchName;
    const isOutOfSync = outOfSyncSet?.has(remote) ?? false;
    result.push({
      label: `origin/${remote}`,
      type: "remote",
      isSynced: false,
      isOutOfSync,
      isCurrent,
      isDefault,
    });
  }

  // タグ
  for (const tag of tags) {
    result.push({
      label: tag.slice("tag:".length),
      type: "tag",
      isSynced: false,
      isOutOfSync: false,
      isCurrent: false,
      isDefault: false,
    });
  }

  return result;
}
