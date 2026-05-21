import type { OpenTargetSelection } from "@gozd/proto";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useRepoStore } from "../../shared/repo";
import { resolveFileGitChange } from "./gitStatusUtils";
import { normalizePath } from "./pathUtils";
import { useGitStatusStore } from "./useGitStatusStore";

interface Selection {
  path: string;
  lineNumber?: number;
}

export const useWorktreeStore = defineStore("worktree", () => {
  const repoStore = useRepoStore();
  const fileServerBaseUrl = ref<string>();

  /**
   * プレビュー対象の選択状態。worktree 横断で 1 つだけ保持し、dir が変わるたびにクリアする。
   *
   * **path の形式契約**:
   * - active worktree 内のファイル: 相対パス（例: `src/foo.ts`）
   * - worktree 外のファイル: 絶対パス（例: `/Users/<user>/ghq/.../README.md`）。
   *   terminal link から worktree 外パスを Shift+クリックした場合に渡される。
   *
   * 購読側は path が絶対パスを取りうる前提で分岐する:
   * - PreviewPane: `path.startsWith("/")` で fsReadFile / fsReadFileAbsolute を切り替え
   * - FilerPane reveal: ツリーは active worktree 配下しか持たないため、絶対パスは
   *   reveal 対象外（ハイライトされない契約）
   * - resolveFileGitChange: gitStatuses record の lookup に失敗して `undefined` を返す
   *   （worktree 外パスは git status に存在しないため挙動として整合）
   */
  const selection = ref<Selection>();

  /**
   * 同一パスでも reveal を発火させるためのバージョンカウンタ。
   * **invariant**: `revealVersion` の bump は必ず `selection.value` の同期更新と
   * セットで行う（= 必ず `selectPath()` 経由で更新する）。
   * 購読側（FilerPane の watch）は `revealVersion` を trigger にして `selectedPath`
   * を直接読むため、両者が同 tick で一致していないと古いパスで reveal が走る。
   */
  const revealVersion = ref(0);

  /** setOpen 呼び出しごとにインクリメント。観測側（terminal 等）が「wt 選択イベント」として購読する */
  const selectionVersion = ref(0);

  const gitStatusStore = useGitStatusStore();

  /** 現在 UI で選択中の dir。repoStore.selectedDir の薄いエイリアス */
  const dir = computed(() => repoStore.selectedDir);

  /**
   * 選択中のパス。形式は `selection` の契約に従い、相対パスまたは絶対パスを取る。
   * worktree 切替で undefined にリセットされる
   */
  const selectedPath = computed(() => selection.value?.path);

  /** リンクから指定された行番号（1-based）。スクロール・ハイライトに使用 */
  const selectedLineNumber = computed(() => selection.value?.lineNumber);

  /** git status から都度算出するため、status 更新時に自動反映される */
  const selectedGitChange = computed(() => {
    if (!selectedPath.value) return undefined;
    return resolveFileGitChange(selectedPath.value, gitStatusStore.gitStatuses);
  });

  // dir が変わるたびに selection を即座に落とす。setOpen を経由しない経路
  // （repoStore.removeRepo 内の selectedDir 直書きなど）でも一貫してクリアされる。
  // flush: 'sync' により、setOpen が同期で続けて selectPath を書き込む際に
  // 「クリア → 新値書き込み」の順序が崩れない。
  watch(
    dir,
    () => {
      selection.value = undefined;
    },
    { flush: "sync" },
  );

  interface SetOpenOptions {
    selection?: OpenTargetSelection;
    fileServerBaseUrl?: string;
  }

  /**
   * worktree 切替（同 repo 内）専用。新 dir は既に repoStore に登録済みであることが前提。
   * 新規 repo の追加は App.vue の gozdOpen ハンドラが行う。
   *
   * `options.selection` 経由の reveal は、`selectPath` で `revealVersion` を進めることで
   * FilerPane 側の `revealVersion` watch から発火させる（reveal 経路の SSOT）。
   * ツリー未ロード時の保留は FilerPane 内の `pendingRevealPath` でカバーされる。
   */
  function setOpen(newDir: string, options: SetOpenOptions = {}) {
    repoStore.selectDir(newDir);
    selectionVersion.value++;
    if (options.fileServerBaseUrl) {
      fileServerBaseUrl.value = options.fileServerBaseUrl;
    }
    if (options.selection) {
      // ツリーロード前でもヘッダー等が即時反映されるよう selection も同期で書き込む。
      // revealVersion ++ により FilerPane の watch が reveal を実行する。
      selectPath(options.selection.relPath);
    }
  }

  function selectPath(path: string, lineNumber?: number) {
    if (!dir.value) return;
    selection.value = {
      path: normalizePath(path),
      lineNumber,
    };
    revealVersion.value++;
  }

  function clearSelectedPath() {
    selection.value = undefined;
  }

  return {
    dir,
    fileServerBaseUrl,
    selectedPath,
    selectedLineNumber,
    selectedGitChange,
    revealVersion,
    selectionVersion,
    setOpen,
    selectPath,
    clearSelectedPath,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorktreeStore, import.meta.hot));
}
