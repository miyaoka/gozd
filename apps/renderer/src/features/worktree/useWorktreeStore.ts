import type { OpenTargetSelection } from "@gozd/rpc";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import { resolveFileGitChange } from "./gitStatusUtils";
import { normalizePath } from "./pathUtils";
import { useGitStatusStore } from "./useGitStatusStore";

interface Selection {
  path: string;
  lineNumber?: number;
}

export const useWorktreeStore = defineStore("worktree", () => {
  const dir = ref<string>();
  const fileServerBaseUrl = ref<string>();
  const channel = ref<string>();
  const repoName = ref<string>();

  /** worktree ごとの選択状態（dir → Selection） */
  const selectionByDir = ref<Record<string, Selection>>({});

  /** ツリー初期化後に適用する選択対象（setOpen で保持、consumeInitialSelection で消費） */
  const initialSelection = ref<OpenTargetSelection>();

  /** 同一パスでも reveal を発火させるためのバージョンカウンタ */
  const revealVersion = ref(0);

  const gitStatusStore = useGitStatusStore();

  /** 現在の worktree で選択中のパス（相対パス） */
  const selectedPath = computed(() => {
    if (!dir.value) return undefined;
    return selectionByDir.value[dir.value]?.path;
  });

  /** リンクから指定された行番号（1-based）。スクロール・ハイライトに使用 */
  const selectedLineNumber = computed(() => {
    if (!dir.value) return undefined;
    return selectionByDir.value[dir.value]?.lineNumber;
  });

  /** git status から都度算出するため、status 更新時に自動反映される */
  const selectedGitChange = computed(() => {
    if (!selectedPath.value) return undefined;
    return resolveFileGitChange(selectedPath.value, gitStatusStore.gitStatuses);
  });

  /** RPC gozdOpen イベントで呼ばれる */
  function setOpen(
    newDir: string,
    selection?: OpenTargetSelection,
    newFileServerBaseUrl?: string,
    newChannel?: string,
    newRepoName?: string,
  ) {
    const dirChanged = dir.value !== newDir;
    const prevSelectedPath = selectedPath.value;
    dir.value = newDir;
    if (newFileServerBaseUrl) {
      fileServerBaseUrl.value = newFileServerBaseUrl;
    }
    if (newChannel) {
      channel.value = newChannel;
    }
    if (newRepoName) {
      repoName.value = newRepoName;
    }
    if (selection) {
      if (dirChanged) {
        // dir が変わる場合は loadRoot 後に consumeInitialSelection で適用
        initialSelection.value = selection;
      }
      selectPath(selection.relPath);
    } else {
      // selection なしで dir が変わる場合、前の worktree の initialSelection を破棄する
      if (dirChanged) {
        initialSelection.value = undefined;
      }
      if (dirChanged && selectedPath.value && selectedPath.value === prevSelectedPath) {
        // 切り替え先に保存済み選択があり文字列が同一の場合、
        // selectedPath の watch が発火しないため revealVersion で reveal を強制する
        revealVersion.value++;
      }
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
    selectionByDir.value[dir.value] = {
      path: normalizePath(path),
      lineNumber,
    };
    revealVersion.value++;
  }

  function clearSelectedPath() {
    if (!dir.value) return;
    delete selectionByDir.value[dir.value];
  }

  return {
    dir,
    fileServerBaseUrl,
    channel,
    repoName,
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
