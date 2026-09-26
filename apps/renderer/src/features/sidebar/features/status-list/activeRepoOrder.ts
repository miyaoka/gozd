import { computed, ref, watch } from "vue";
import { useRepoStore } from "../../../../shared/repo";
import { useTerminalStore } from "../../../terminal";

/**
 * Active に repo が現れた順を保つ。残っている repo の順は変えず、消えた repo を落とし、
 * 新しく現れた repo を末尾に足す。
 *
 * Active は端末が開いているセッションがある間だけの一時的なまとまりで、repo の位置は
 * 現れた時点で決まる。中のセッションの増減や状態の変化では動かさない。
 */
export function nextActiveRepoOrder(
  prev: readonly string[],
  activeRootDirs: readonly string[],
): readonly string[] {
  const active = new Set(activeRootDirs);
  const kept = prev.filter((rootDir) => active.has(rootDir));
  const known = new Set(kept);
  const appeared = activeRootDirs.filter((rootDir) => !known.has(rootDir));
  if (appeared.length === 0 && kept.length === prev.length) return prev;
  return [...kept, ...new Set(appeared)];
}

const order = ref<readonly string[]>([]);

/**
 * Active の repo の順（module singleton）。状態別の表示を開いていない間も追う必要があるため、
 * 常に mount されている SidebarPane が `trackActiveRepoOrder` を 1 回呼んで更新を始める。
 * 表示の切り替えのたびに順を作り直すと、現れた順が失われる。
 */
export function useActiveRepoOrder() {
  return order;
}

/** 端末が開いているセッションを持つプールの repo を監視し、現れた順を更新する */
export function trackActiveRepoOrder(): void {
  const repoStore = useRepoStore();
  const terminalStore = useTerminalStore();
  // 窓口はプールの外なので、状態別の表示と同じく含めない
  const activeRootDirs = computed(() =>
    terminalStore.liveSessions
      .map((session) => repoStore.findRepoOwning(session.dir)?.rootDir)
      .filter((rootDir): rootDir is string => rootDir !== undefined)
      .filter((rootDir) => repoStore.poolDirs.includes(rootDir)),
  );
  watch(
    activeRootDirs,
    (rootDirs) => {
      order.value = nextActiveRepoOrder(order.value, rootDirs);
    },
    { immediate: true },
  );
}
