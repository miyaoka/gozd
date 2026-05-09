/**
 * 選択中 repo の isGitRepo を context key に反映する。
 * keybinding / command の `when` 条件で git 関連コマンドを gating するために使う。
 */
import { watch } from "vue";
import { useContextKeys } from "../../shared/command";
import { useRepoStore } from "../../shared/repo";

export function useRepoContextKey() {
  const repoStore = useRepoStore();
  const contextKeys = useContextKeys();

  watch(
    () => repoStore.selectedIsGitRepo,
    (isGitRepo) => contextKeys.set("isGitRepo", isGitRepo),
    { immediate: true },
  );
}
