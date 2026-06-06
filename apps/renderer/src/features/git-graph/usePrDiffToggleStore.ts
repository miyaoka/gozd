import type { GitPullRequest } from "@gozd/proto";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useGitGraphStore } from "./useGitGraphStore";
import { usePrListStore } from "./usePrListStore";

/**
 * PR diff モード (ChangesPane / PreviewPane を「PR base..working tree」表示に切り替える) の SSOT。
 *
 * 既存の gitGraphStore 選択経路を一切上書きしない (= graph 側の見た目・state は不変)。
 * ChangesPane / PreviewPane / useChangesStore はこのストアの `isOn` / `pr` / `baseOid` を見て
 * 表示ソースを分岐する。toggle ON 中も graph 側 selection はユーザーが触ったままの値で残る。
 *
 * 自動 OFF 経路:
 * - ユーザーが graph で commit を select / selectCompare した瞬間 (`selectionVersion` の increment)
 * - 現在 branch の PR が `usePrListStore` から消えた / `base_ref_oid` が変わった
 *
 * いずれも silent drop は禁止 (CLAUDE.md 規約)。toggle が自動 OFF になったときは stderr に
 * 1 行ログを残して観察可能にする。
 */
export const usePrDiffToggleStore = defineStore("prDiffToggle", () => {
  const gitGraphStore = useGitGraphStore();
  const prListStore = usePrListStore();

  /** PR diff モードが ON か */
  const isOn = ref(false);

  /** 現在 branch (HEAD が指すブランチ) の PR。無ければ undefined。
   *
   * `currentBranch` が undefined (loadLog 完了前 / detached HEAD) の間は PR を引けないので
   * toggle UI 自体を出さないことが望ましい。`enable()` も pr 不在時は no-op で倒す。 */
  const pr = computed<GitPullRequest | undefined>(() => {
    const branch = gitGraphStore.currentBranch;
    if (branch === undefined) return undefined;
    return prListStore.prByBranch.get(branch);
  });

  /** 現在 branch の PR の base commit OID。toggle UI gate と useChangesStore の fetch に使う。
   *
   * `base_ref_oid` は GitHub GraphQL の `baseRefOid` を SSOT として持つ。fork PR / base force-push /
   * base rename にまたがって immutable に base 端を識別できる。 */
  const baseOid = computed<string | undefined>(() => {
    const value = pr.value;
    if (value === undefined) return undefined;
    if (value.baseRefOid === "") return undefined;
    return value.baseRefOid;
  });

  /** toggle ON が成立しうるか (PR が見つかり、base OID が解決できているか) */
  const canEnable = computed(() => baseOid.value !== undefined);

  function enable() {
    if (!canEnable.value) return;
    isOn.value = true;
  }

  function disable() {
    isOn.value = false;
  }

  function toggle() {
    if (isOn.value) {
      disable();
    } else {
      enable();
    }
  }

  // ユーザーが graph で commit を選択したら toggle を OFF する。
  // `selectionVersion` は select() / selectCompare() のみで increment される SSOT で、
  // gitGraphStore.setSelectionSilently 経路では上がらないため、ユーザー起点の選択変更だけを拾える。
  watch(
    () => gitGraphStore.selectionVersion,
    () => {
      if (!isOn.value) return;
      isOn.value = false;
      console.info("[prDiffToggle] auto-off: user changed git-graph selection");
    },
  );

  // PR が消失 / base_ref_oid が変化したら toggle を OFF する。
  // close / merge / base 変更 / branch 切替 すべてここに集約。
  watch(
    () => baseOid.value,
    (next, prev) => {
      if (!isOn.value) return;
      if (next === undefined) {
        isOn.value = false;
        console.info("[prDiffToggle] auto-off: PR disappeared for current branch");
        return;
      }
      if (prev !== undefined && next !== prev) {
        isOn.value = false;
        console.info(`[prDiffToggle] auto-off: PR base_ref_oid changed from ${prev} to ${next}`);
      }
    },
  );

  return { isOn, pr, baseOid, canEnable, enable, disable, toggle };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePrDiffToggleStore, import.meta.hot));
}
