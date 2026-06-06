import type { GitPullRequest } from "@gozd/proto";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useGitGraphStore } from "./useGitGraphStore";
import { usePrListStore } from "./usePrListStore";

/**
 * PR diff モード (ChangesPane / PreviewPane を「PR base..working tree」表示に切り替える) の SSOT。
 *
 * 既存の gitGraphStore 選択経路を一切上書きしない (= graph 側の見た目・state は不変)。
 * ChangesPane / PreviewPane / useChangesStore はこのストアの `isOn` / `lockedBaseOid` を見て
 * 表示ソースを分岐する。toggle ON 中も graph 側 selection はユーザーが触ったままの値で残る。
 *
 * ## state の SSOT は `lockedBaseOid`
 *
 * - `enable()` 時に「現在の `baseOid`」を snapshot して `lockedBaseOid` に保持する
 * - `isOn` / `disable` は `lockedBaseOid` の有無 / クリアとして表現する (派生)
 * - 表示用のソース OID は **snapshot 側** (`lockedBaseOid`)。watcher で「現在 OID と snapshot を
 *   比較し変化していれば auto-off」する設計にすることで、「OFF 中に base が変わって、ON 直後の
 *   tick で watcher 起動順により取りこぼす」race を構造的に消す
 *
 * ## 自動 OFF 経路
 *
 * - ユーザーが graph で commit を select / selectCompare した瞬間 (`selectionVersion` の increment)
 * - 現在 branch の PR が `usePrListStore` から消えた / `base_ref_oid` が snapshot と変わった
 *
 * いずれも silent drop 禁止規律に従い、`useNotificationStore.info` でユーザーにトースト通知する
 * (toggle の見た目が突然変わるのでユーザーに認知させる必要がある)。
 */
export const usePrDiffToggleStore = defineStore("prDiffToggle", () => {
  const gitGraphStore = useGitGraphStore();
  const prListStore = usePrListStore();
  const notify = useNotificationStore();

  /** ON 時に snapshot された base OID。undefined のとき OFF (== `isOn=false`)。 */
  const lockedBaseOid = ref<string | undefined>(undefined);

  /** PR diff モードが ON か。`lockedBaseOid` の有無で一意に決まる派生値。 */
  const isOn = computed(() => lockedBaseOid.value !== undefined);

  /** 現在 branch (HEAD が指すブランチ) の PR。無ければ undefined。
   *
   * `currentBranch` が undefined (loadLog 完了前 / detached HEAD) の間は PR を引けないので
   * toggle UI 自体を出さないことが望ましい (`canEnable` 経由)。 */
  const pr = computed<GitPullRequest | undefined>(() => {
    const branch = gitGraphStore.currentBranch;
    if (branch === undefined) return undefined;
    return prListStore.prByBranch.get(branch);
  });

  /** 現在 branch の PR の **live** base commit OID。ON 時 enable() の snapshot 元として使う。
   *
   * `base_ref_oid` は GitHub GraphQL の `baseRefOid` を SSOT として持つ。fork PR / base force-push /
   * base rename にまたがって immutable に base 端を識別できる。
   *
   * 注意: ON 中の display source は `lockedBaseOid` (= snapshot)。`baseOid` は live なので、
   * 表示計算で使うと「base 変更 → 表示が即追従 → auto-off watcher が遅れて発火」の race が
   * 起きうる。表示は必ず `lockedBaseOid` 経由で読む。 */
  const baseOid = computed<string | undefined>(() => {
    const value = pr.value;
    if (value === undefined) return undefined;
    if (value.baseRefOid === "") return undefined;
    return value.baseRefOid;
  });

  /** toggle ON が成立しうるか (PR が見つかり、base OID が解決できているか) */
  const canEnable = computed(() => baseOid.value !== undefined);

  function enable() {
    const current = baseOid.value;
    if (current === undefined) return;
    lockedBaseOid.value = current;
  }

  function disable() {
    lockedBaseOid.value = undefined;
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
  // gitGraphStore.setSelectionSilently のような内部書き込み経路では上がらない。
  watch(
    () => gitGraphStore.selectionVersion,
    () => {
      if (!isOn.value) return;
      disable();
      notify.info("PR diff turned off: git-graph selection changed");
    },
  );

  // live base OID を snapshot と比較し、消失 / 変化のいずれかで auto-off。
  // ON 中のみ走らせる早期 return で OFF 状態の noise も抑制する。
  watch(
    () => baseOid.value,
    (current) => {
      if (!isOn.value) return;
      if (current === undefined) {
        disable();
        notify.info("PR diff turned off: pull request no longer available for current branch");
        return;
      }
      const snapshot = lockedBaseOid.value;
      if (current !== snapshot) {
        disable();
        notify.info(`PR diff turned off: PR base commit changed from ${snapshot} to ${current}`);
      }
    },
  );

  return { isOn, pr, baseOid, lockedBaseOid, canEnable, enable, disable, toggle };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePrDiffToggleStore, import.meta.hot));
}
