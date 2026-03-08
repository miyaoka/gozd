import { computed, ref } from "vue";
import { resolveFileGitChange } from "./filer-utils";
import { useGitStatus } from "./useGitStatus";

/** ファイラーで選択中のファイルパス（相対パス）。モジュールレベルで保持し HMR でも状態が消えない */
const selectedPath = ref<string>();

export function useSelectedPath() {
  const { gitStatuses } = useGitStatus();

  /** git status から都度算出するため、status 更新時に自動反映される */
  const selectedGitChange = computed(() => {
    if (!selectedPath.value) return undefined;
    return resolveFileGitChange(selectedPath.value, gitStatuses.value);
  });

  function select(path: string) {
    selectedPath.value = path;
  }

  function clear() {
    selectedPath.value = undefined;
  }

  return { selectedPath, selectedGitChange, select, clear };
}
