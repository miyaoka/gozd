import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useProjectStore } from "../../shared/project";
import { rpcGitStatus } from "./rpc";
import { useWorktreeStore } from "./useWorktreeStore";

export const useGitStatusStore = defineStore("gitStatus", () => {
  const gitStatuses = ref<Record<string, string>>({});

  const projectStore = useProjectStore();
  const worktreeStore = useWorktreeStore();

  async function loadGitStatus() {
    if (!projectStore.isGitRepo) {
      gitStatuses.value = {};
      return;
    }
    const dir = worktreeStore.dir;
    if (dir === undefined) {
      gitStatuses.value = {};
      return;
    }
    const result = await tryCatch(rpcGitStatus({ dir }));
    if (result.ok) {
      gitStatuses.value = result.value.entries;
    } else {
      const notify = useNotificationStore();
      notify.error("Failed to get git status", result.error);
      gitStatuses.value = {};
    }
  }

  function setGitStatuses(statuses: Record<string, string>) {
    gitStatuses.value = statuses;
  }

  return { gitStatuses, loadGitStatus, setGitStatuses };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useGitStatusStore, import.meta.hot));
}
