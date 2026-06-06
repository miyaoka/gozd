import type { GitPullRequest } from "@gozd/proto";
import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";

/**
 * active worktree の PR 一覧の SSOT。head branch 名で引ける Map で保持する。
 *
 * GitGraphPane が `gh pr list` (60s polling + push burst trigger) で取得して `setPrs` で
 * 書き込み、`usePrDiffToggleStore` が `prByBranch` から現在 branch の PR を引く。
 *
 * 取得の lifecycle (polling / worktree 切替リセット / エラー通知) は GitGraphPane に置く。
 * store は単純な値の入れ物として閉じる。
 *
 * ## API スコープ
 *
 * **git-graph feature の内部 SSOT** として閉じる。他 feature から直接読まないため barrel
 * (`features/git-graph/index.ts`) には export しない。外部からは `usePrDiffToggleStore` 経由
 * (= 「現在 branch の PR」を導出する concern 経由) で間接的に読む契約。
 *
 * 将来 PR list そのものを別 feature が読みたくなった時点で barrel export を検討する
 * (今はその要件が無いため YAGNI)。
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
