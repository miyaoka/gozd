import type { GitCommit } from "@gozd/rpc";
import type { DisplayRef } from "./displayRef";

/** `git log --decorate` の ref を分類した結果。`name` は `origin/` / `tag:` を剥がした裸の名前。 */
interface ClassifiedRef {
  kind: "local" | "remote" | "tag";
  name: string;
}

/**
 * `git log --decorate` の ref 文字列を分類する (純関数)。**生 ref の分類はここだけが持つ。**
 * 同じ判定を写すと、片方だけ直された状態が生まれる。
 *
 * `HEAD` / `origin/HEAD` は undefined。HEAD は → マーカーが別途示すため ref バッジに出さず、
 * branch 名としても引かない。
 *
 * `origin/` は剥がして local と同じ名前へ寄せる。PR は branch 名 (`headRefName`) に紐づくので、
 * 同じ branch の 2 つの位置を別の名前にしない。
 */
function classifyRef(ref: string): ClassifiedRef | undefined {
  if (ref === "HEAD" || ref === "origin/HEAD") return undefined;
  if (ref.startsWith("tag:")) return { kind: "tag", name: ref.slice("tag:".length) };
  if (ref.startsWith("origin/")) return { kind: "remote", name: ref.slice("origin/".length) };
  return { kind: "local", name: ref };
}

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
      const classified = classifyRef(r);
      if (classified === undefined || classified.kind === "tag") continue;
      const side = classified.kind === "remote" ? remoteCommits : localCommits;
      side.set(classified.name, commit.hash);
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
  const classified = refs.map(classifyRef).filter((r) => r !== undefined);
  const locals = new Set(classified.filter((r) => r.kind === "local").map((r) => r.name));
  const remotes = new Set(classified.filter((r) => r.kind === "remote").map((r) => r.name));
  const tags = classified.filter((r) => r.kind === "tag").map((r) => r.name);

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
      label: tag,
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
 *
 * **`computeDisplayRefs` が組み立てた `label` を読み戻す**（remote は `origin/` を付けて作り、
 * ここで剥がす）。取得側は `classifyRef` が生 ref から同じ名前を導くので、`label` の表記を
 * 変えるとこの対がずれ、fetch は走るのに map から引けずバッジだけが黙って消える。
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

/**
 * グラフに描かれる branch 名の集合 (純関数)。分類は `classifyRef` に従う。
 *
 * PR バッジの取得はこの集合を名指しで引く。描いていない branch の PR は誰も読まない。
 */
export function graphBranchNames(commits: GitCommit[]): string[] {
  const names = new Set<string>();
  for (const commit of commits) {
    for (const r of commit.refs) {
      const classified = classifyRef(r);
      if (classified === undefined || classified.kind === "tag") continue;
      names.add(classified.name);
    }
  }
  return [...names];
}
