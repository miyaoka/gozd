import type { OpenTargetSelection } from "@orkis/rpc";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import { normalizePath, resolveFileGitChange } from "./filer-utils";
import { useGitStatusStore } from "./useGitStatusStore";

export const useWorkspaceStore = defineStore("workspace", () => {
  const dir = ref<string>();
  const fileServerBaseUrl = ref<string>();
  const channel = ref<string>();
  const repoName = ref<string>();

  /** ファイラーで選択中のパス（相対パス） */
  const selectedPath = ref<string>();

  /** リンクから指定された行番号（1-based）。スクロール・ハイライトに使用 */
  const selectedLineNumber = ref<number>();

  /** ツリー初期化後に適用する選択対象（setOpen で保持、consumeInitialSelection で消費） */
  const initialSelection = ref<OpenTargetSelection>();

  /** 同一パスでも reveal を発火させるためのバージョンカウンタ */
  const revealVersion = ref(0);

  const gitStatusStore = useGitStatusStore();

  /** git status から都度算出するため、status 更新時に自動反映される */
  const selectedGitChange = computed(() => {
    if (!selectedPath.value) return undefined;
    return resolveFileGitChange(selectedPath.value, gitStatusStore.gitStatuses);
  });

  /** RPC orkisOpen イベントで呼ばれる */
  function setOpen(
    newDir: string,
    selection?: OpenTargetSelection,
    newFileServerBaseUrl?: string,
    newChannel?: string,
    newRepoName?: string,
  ) {
    const dirChanged = dir.value !== newDir;
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
    selectedPath.value = normalizePath(path);
    selectedLineNumber.value = lineNumber;
    revealVersion.value++;
  }

  function clearSelectedPath() {
    selectedPath.value = undefined;
    selectedLineNumber.value = undefined;
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
  import.meta.hot.accept(acceptHMRUpdate(useWorkspaceStore, import.meta.hot));
}
