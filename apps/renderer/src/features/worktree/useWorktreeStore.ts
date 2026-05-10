import type { OpenTargetSelection } from "@gozd/proto";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
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

  /** プレビュー対象の選択状態。worktree 横断で 1 つだけ保持し、dir 切替時にクリアする */
  const selection = ref<Selection>();

  /** ツリー初期化後に適用する選択対象（setOpen で保持、consumeInitialSelection で消費） */
  const initialSelection = ref<OpenTargetSelection>();

  /** 同一パスでも reveal を発火させるためのバージョンカウンタ */
  const revealVersion = ref(0);

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

  interface SetOpenOptions {
    selection?: OpenTargetSelection;
    fileServerBaseUrl?: string;
  }

  /**
   * worktree 切替（同 repo 内）専用。新 dir は既に repoStore に登録済みであることが前提。
   * 新規 repo の追加は App.vue の gozdOpen ハンドラが行う。
   */
  function setOpen(newDir: string, options: SetOpenOptions = {}) {
    const dirChanged = repoStore.selectedDir !== newDir;
    repoStore.selectDir(newDir);
    if (options.fileServerBaseUrl) {
      fileServerBaseUrl.value = options.fileServerBaseUrl;
    }
    if (dirChanged) {
      // worktree 切替時はプレビュー選択も保留中の initialSelection もクリアする
      selection.value = undefined;
      initialSelection.value = undefined;
    }
    const openSelection = options.selection;
    if (openSelection) {
      if (dirChanged) {
        // dir が変わる場合は loadRoot 後に consumeInitialSelection で適用
        initialSelection.value = openSelection;
      }
      selectPath(openSelection.relPath);
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
    setOpen,
    selectPath,
    clearSelectedPath,
    consumeInitialSelection,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorktreeStore, import.meta.hot));
}
