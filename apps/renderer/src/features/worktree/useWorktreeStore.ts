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

  /** プレビュー対象の選択状態。worktree 横断で 1 つだけ保持し、dir が変わるたびにクリアする */
  const selection = ref<Selection>();

  /** ツリー初期化後に適用する選択対象（setOpen で保持、consumeInitialSelection で消費） */
  const initialSelection = ref<OpenTargetSelection>();

  /** 同一パスでも reveal を発火させるためのバージョンカウンタ */
  const revealVersion = ref(0);

  /** setOpen 呼び出しごとにインクリメント。観測側（terminal 等）が「wt 選択イベント」として購読する */
  const selectionVersion = ref(0);

  const gitStatusStore = useGitStatusStore();

  /** 現在 UI で選択中の dir。repoStore.selectedDir の薄いエイリアス */
  const dir = computed(() => repoStore.selectedDir);

  /** 選択中のパス（相対パス）。worktree 切替で undefined にリセットされる */
  const selectedPath = computed(() => selection.value?.path);

  /** リンクから指定された行番号（1-based）。スクロール・ハイライトに使用 */
  const selectedLineNumber = computed(() => selection.value?.lineNumber);

  /** git status から都度算出するため、status 更新時に自動反映される */
  const selectedGitChange = computed(() => {
    if (!selectedPath.value) return undefined;
    return resolveFileGitChange(selectedPath.value, gitStatusStore.gitStatuses);
  });

  // dir が変わるたびに selection / initialSelection を即座に落とす。setOpen を経由しない
  // 経路（repoStore.removeRepo 内の selectedDir 直書きなど）でも一貫してクリアされる。
  // flush: 'sync' により、setOpen が同期で続けて selectPath / initialSelection を書き込む際に
  // 「クリア → 新値書き込み」の順序が崩れない。
  watch(
    dir,
    () => {
      selection.value = undefined;
      initialSelection.value = undefined;
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
   */
  function setOpen(newDir: string, options: SetOpenOptions = {}) {
    repoStore.selectDir(newDir);
    selectionVersion.value++;
    if (options.fileServerBaseUrl) {
      fileServerBaseUrl.value = options.fileServerBaseUrl;
    }
    // initialSelection は setOpen のたびに最新の options.selection で置き換える。
    // 同一 dir で setOpen が連続した場合に、前回呼び出し時の保留分が
    // consumeInitialSelection に取り残されて誤適用されるのを防ぐ。
    initialSelection.value = options.selection;
    if (options.selection) {
      // ツリーロード前でもヘッダー等が即時反映されるよう selection も同期で書き込む。
      selectPath(options.selection.relPath);
    }
  }

  /** ファイラーのツリー初期化後に呼ぶ。initialSelection があれば消費して返す */
  function consumeInitialSelection(): OpenTargetSelection | undefined {
    const sel = initialSelection.value;
    if (sel) {
      initialSelection.value = undefined;
      if (sel.kind === "file") {
        selectPath(sel.relPath);
      }
    }
    return sel;
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
    consumeInitialSelection,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorktreeStore, import.meta.hot));
}
