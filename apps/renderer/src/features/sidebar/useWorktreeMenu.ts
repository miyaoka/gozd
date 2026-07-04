/**
 * worktree カードの ⋮ menu の module singleton。
 *
 * 親 (SidebarPane) から `open(anchorEl, { worktree, rootDir })` を呼び、
 * WorktreeMenu.vue が context を購読して描画する。
 */
import type { WorktreeEntry } from "@gozd/rpc";
import { usePopover } from "../../shared/popover";

type WorktreeMenuContext = {
  worktree: WorktreeEntry;
  rootDir: string;
};

const popover = usePopover<WorktreeMenuContext>();

if (import.meta.hot) {
  import.meta.hot.dispose(() => popover.stop());
}

export function useWorktreeMenu() {
  return popover;
}
