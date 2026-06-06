import type { GitPullRequest } from "@gozd/proto";
import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";

/**
 * active worktree の PR 一覧の SSOT。head branch 名で引ける Map で保持する。
 *
 * GitGraphPane が `gh pr list` (60s polling + push burst trigger) で取得して `setPrs` で
 * 書き込み、ChangesPane の PR diff toggle 等が `prByBranch` から現在 branch の PR を引く。
 *
 * 取得の lifecycle (polling / worktree 切替リセット / エラー通知) は GitGraphPane に置く。
 * store は単純な値の入れ物として閉じる。
 */
export const usePrListStore = defineStore("prList", () => {
  /** head branch 名 → PR */
  const prByBranch = ref<Map<string, GitPullRequest>>(new Map());

  function setPrs(prs: GitPullRequest[]) {
    const map = new Map<string, GitPullRequest>();
    for (const pr of prs) {
      map.set(pr.headRef, pr);
    }
    prByBranch.value = map;
  }

  function clear() {
    prByBranch.value = new Map();
  }

  return { prByBranch, setPrs, clear };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePrListStore, import.meta.hot));
}
