import type { SidebarView } from "@gozd/rpc";
import { ref } from "vue";

/**
 * サイドバーの表示（repo > worktree の階層 / 全 repo のセッションの状態別）。
 * 表示を切り替える SidebarPane と、app-state.json へ保存・復元する useSidebarData が同じ値を
 * 見るため module singleton にする。
 */
const sidebarView = ref<SidebarView>("tree");

export function useSidebarView() {
  return sidebarView;
}
