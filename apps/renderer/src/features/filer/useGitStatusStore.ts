import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";
import { useRpc } from "../../shared/rpc";

export const useGitStatusStore = defineStore("gitStatus", () => {
  const gitStatuses = ref<Record<string, string>>({});

  const { request } = useRpc();

  async function loadGitStatus() {
    try {
      gitStatuses.value = await request.gitStatus();
    } catch (e) {
      console.error("Failed to get git status", e);
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
