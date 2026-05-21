/**
 * Sidebar ⋮ menu の module singleton。
 *
 * SidebarMenu.vue は popover の content を slot で描画するだけで、
 * 開閉と context は `useSidebarMenu` 経由で共有する。
 * 親 (SidebarPane) から open(), 子 (SidebarMenu) で context / close を扱う構造。
 */
import type { Task, WorktreeEntry } from "@gozd/proto";
import { usePopover } from "../../shared/popover";

type SidebarMenuContext =
  | { type: "worktree"; worktree: WorktreeEntry; rootDir: string }
  | { type: "task"; task: Task; rootDir: string };

const popover = usePopover<SidebarMenuContext>();

export function useSidebarMenu() {
  return popover;
}
