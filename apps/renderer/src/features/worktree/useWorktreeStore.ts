import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useRepoStore } from "../../shared/repo";
import { resolveFileGitChange } from "./gitStatusUtils";
import {
  normalizeAbsolute,
  normalizeRelative,
  pathTargetToString,
  type PathTarget,
} from "./pathUtils";
import { useGitStatusStore } from "./useGitStatusStore";

/**
 * プレビュー対象の selection。`PathTarget` に行番号 (terminal link / markdown anchor 由来) を
 * 追加した形。store 内部状態は本型で保持し、消費側は `kind` で switch する。
 */
export type Selection = PathTarget & { lineNumber?: number };

export const useWorktreeStore = defineStore("worktree", () => {
  const repoStore = useRepoStore();

  const selection = ref<Selection>();

  /**
   * 同一パスでも reveal を発火させるためのバージョンカウンタ。
   * **invariant**: `revealVersion` の bump は必ず `selection.value` の同期更新と
   * セットで行う（= 必ず `selectRelPath()` / `selectAbsPath()` 経由で更新する）。
   * 購読側（FilerPane の watch）は `revealVersion` を trigger にして `selectedRelPath`
   * を直接読むため、両者が同 tick で一致していないと古いパスで reveal が走る。
   */
  const revealVersion = ref(0);

  /** setOpen 呼び出しごとにインクリメント。観測側（terminal 等）が「wt 選択イベント」として購読する */
  const selectionVersion = ref(0);

  const gitStatusStore = useGitStatusStore();

  /** 現在 UI で選択中の dir。repoStore.selectedDir の薄いエイリアス */
  const dir = computed(() => repoStore.selectedDir);

  /**
   * worktree 内のパス（filer reveal / git 系 RPC が扱える）。
   * 絶対パス選択中は undefined を返す。
   */
  const selectedRelPath = computed(() =>
    selection.value?.kind === "worktreeRelative" ? selection.value.relPath : undefined,
  );

  /**
   * 表示用パス文字列（ヘッダのタイトル / breadcrumb 等）。worktreeRelative なら relPath、
   * absolute なら absPath を返す。RPC 呼び出しや git 操作の入力には使わない。
   */
  const selectedDisplayPath = computed(() => {
    const sel = selection.value;
    return sel === undefined ? undefined : pathTargetToString(sel);
  });

  /** リンクから指定された行番号（1-based）。スクロール・ハイライトに使用 */
  const selectedLineNumber = computed(() => selection.value?.lineNumber);

  /**
   * git status から都度算出するため、status 更新時に自動反映される。
   * absolute 選択中は worktree 外で git 履歴を持たないため undefined。
   */
  const selectedGitChange = computed(() => {
    const relPath = selectedRelPath.value;
    if (relPath === undefined) return undefined;
    return resolveFileGitChange(relPath, gitStatusStore.gitStatuses);
  });

  // dir が変わるたびに selection を即座に落とす。setOpen を経由しない経路
  // （repoStore.removeRepo 内の selectedDir 直書きなど）でも一貫してクリアされる。
  // flush: 'sync' により、setOpen が同期で続けて selectRelPath を書き込む際に
  // 「クリア → 新値書き込み」の順序が崩れない。
  watch(
    dir,
    () => {
      selection.value = undefined;
    },
    { flush: "sync" },
  );

  /**
   * worktree 切替（同 repo 内）専用。新 dir は既に repoStore に登録済みであることが前提。
   * 新規 repo の追加は App.vue の gozdOpen ハンドラが行う。
   *
   * **scope**: dir 切替のみ。「ファイル選択 + preview を開く」副作用は呼び出し側が
   * `usePreviewStore.forceSelect` / `requestSelect` を明示的に呼ぶ契約に集約してある
   * （[docs/preview.md](../../../../../docs/preview.md) の決定表を参照）。setOpen 自体には
   * preview の開閉責務を持たせない。
   */
  function setOpen(newDir: string) {
    repoStore.selectDir(newDir);
    selectionVersion.value++;
  }

  function selectRelPath(relPath: string, lineNumber?: number) {
    if (!dir.value) return;
    selection.value = {
      kind: "worktreeRelative",
      relPath: normalizeRelative(relPath),
      lineNumber,
    };
    revealVersion.value++;
  }

  function selectAbsPath(absPath: string, lineNumber?: number) {
    if (!dir.value) return;
    selection.value = {
      kind: "absolute",
      absPath: normalizeAbsolute(absPath),
      lineNumber,
    };
    revealVersion.value++;
  }

  /**
   * `PathTarget` を受けて kind に応じた select* に振り分ける。terminal link / markdown link
   * のように source 側で kind を分けて持っている経路で使う。kind 別 switch を呼び出し側に
   * 書かないことで「新規購読側で振り分け忘れる」経路を消す SSOT。
   */
  function selectFromTarget(target: PathTarget, lineNumber?: number) {
    if (target.kind === "worktreeRelative") {
      selectRelPath(target.relPath, lineNumber);
    } else {
      selectAbsPath(target.absPath, lineNumber);
    }
  }

  function clearSelectedPath() {
    selection.value = undefined;
  }

  return {
    dir,
    selection,
    selectedRelPath,
    selectedDisplayPath,
    selectedLineNumber,
    selectedGitChange,
    revealVersion,
    selectionVersion,
    setOpen,
    selectRelPath,
    selectAbsPath,
    selectFromTarget,
    clearSelectedPath,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorktreeStore, import.meta.hot));
}
