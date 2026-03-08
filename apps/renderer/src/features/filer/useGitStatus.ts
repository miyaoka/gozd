import { ref } from "vue";
import { useRpc } from "../rpc/useRpc";

/** モジュールレベルで保持するため HMR でも状態が消えない */
const gitStatuses = ref<Record<string, string>>({});

export function useGitStatus() {
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
}
