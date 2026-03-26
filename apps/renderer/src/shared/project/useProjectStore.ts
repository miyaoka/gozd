import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";

/** プロジェクト単位の状態。worktree 切り替えで変わらない情報を管理する */
export const useProjectStore = defineStore("project", () => {
  const repoName = ref<string>();
  /** git リポジトリ内かどうか。false の場合 git 関連 UI を非表示にする */
  const isGitRepo = ref(false);

  function setProject(newRepoName?: string, newIsGitRepo?: boolean) {
    if (newRepoName !== undefined) {
      repoName.value = newRepoName;
    }
    if (newIsGitRepo !== undefined) {
      isGitRepo.value = newIsGitRepo;
    }
  }

  return {
    repoName,
    isGitRepo,
    setProject,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useProjectStore, import.meta.hot));
}
