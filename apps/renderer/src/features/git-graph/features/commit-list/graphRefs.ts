import type { GitCommit } from "@gozd/rpc";
import type { DisplayRef } from "./displayRef";

/**
 * ローカルとリモートが異なるコミットに存在するブランチ名の Set を導出する (純関数)。
 * 同じコミットにローカルとリモートが両方あれば synced（computeDisplayRefs で処理）。
 * 別コミットに分かれていれば out-of-sync としてここで検出する。
 *
 * 検出範囲は `commits` に出現する ref に限定される。branchScope が "current" のとき
 * native 側の `git log` 始点 ref が HEAD のみに絞られ origin/<default> 系の commit が消えるため、
 * HEAD 系統から到達しない ref ペアの out-of-sync は検出できない (scope 意味の直接の帰結)。
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

/**
 * ref バッジが PR を引くときの branch 名。tag は branch ではないので undefined。
 *
 * PR は branch 名 (`headRefName`) に紐づくので、local と origin は同じ名前へ寄せる。ref が
 * どちらの側かは PR の有無と無関係。
 */
export function prLookupBranch(displayRef: DisplayRef): string | undefined {
  if (displayRef.type === "tag") return undefined;
  if (displayRef.type === "remote") return displayRef.label.slice("origin/".length);
  return displayRef.label;
}

/** 種別の追加を型で強制するためのテーブル。意味は `hasOriginRef` の doc。 */
const HAS_ORIGIN_REF: Record<DisplayRef["type"], boolean> = {
  synced: true,
  remote: true,
  local: false,
  tag: false,
};

/**
 * この ref と同じ branch の `origin/<branch>` が、同じ commit に載っているか。判定は ref 単位で、
 * 同じ行にある別の ref は見ない。`synced` は local と origin が同一 commit に居ることの定義その
 * もの、`remote` は origin ref 自身。`local` は載っていない状態で、**未 push と、origin が別
 * commit に居るという 2 系統を含む**。
 *
 * CI の総合結果は **PR head ref の commit** に対する値なので、origin が載っている ref にだけ
 * 描く。それ以外に描くと「head ではない commit の CI 結果」という存在しない事実になる（`local` には
 * origin より後ろに居る = push 済みの状態も含まれるので、理由は push の有無ではない）。
 *
 * **origin ref が PR head を指しているかまでは見ない。**origin ref も PR の取得結果もそれぞれ
 * 取得時点のスナップショットなので、branch の指す先が動いた直後は両者がずれ、その間は別 commit
 * の CI が描かれる。commit で判定するには PR head の OID が要る。
 */
export function hasOriginRef(displayRef: DisplayRef): boolean {
  return HAS_ORIGIN_REF[displayRef.type];
}
