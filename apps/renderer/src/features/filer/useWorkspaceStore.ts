import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import { normalizePath, resolveFileGitChange } from "./filer-utils";
import { useGitStatusStore } from "./useGitStatusStore";

export const useWorkspaceStore = defineStore("workspace", () => {
  const dir = ref<string>();
  const fileServerBaseUrl = ref<string>();
  const channel = ref<string>();

  /** ファイラーで選択中のファイルパス（相対パス） */
  const selectedPath = ref<string>();

  /** ツリー初期化後に選択するファイル（setOpen で保持、consumeInitialFile で消費） */
  const initialFile = ref<string>();

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
    newFile?: string,
    newFileServerBaseUrl?: string,
    newChannel?: string,
  ) {
    dir.value = newDir;
    if (newFileServerBaseUrl) {
      fileServerBaseUrl.value = newFileServerBaseUrl;
    }
    if (newChannel) {
      channel.value = newChannel;
    }
    if (newFile) {
      // ツリー未初期化時は loadRoot 後に consumeInitialFile で反映
      initialFile.value = newFile;
      selectPath(newFile);
    }
  }

  /** ファイラーのツリー初期化後に呼ぶ。initialFile があれば selectedPath にセットする */
  function consumeInitialFile() {
    if (initialFile.value) {
      selectPath(initialFile.value);
      initialFile.value = undefined;
    }
  }

  function selectPath(path: string) {
    selectedPath.value = normalizePath(path);
    revealVersion.value++;
  }

  function clearSelectedPath() {
    selectedPath.value = undefined;
  }

  return {
    dir,
    fileServerBaseUrl,
    channel,
    selectedPath,
    selectedGitChange,
    revealVersion,
    setOpen,
    selectPath,
    clearSelectedPath,
    consumeInitialFile,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorkspaceStore, import.meta.hot));
}
