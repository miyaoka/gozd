/**
 * task 行の ⋮ menu の module singleton。
 *
 * 親 (SidebarPane) から `open(anchorEl, { task, rootDir })` を呼び、
 * TaskMenu.vue が context を購読して描画する。
 */
import type { Task } from "@gozd/rpc";
import { usePopover } from "../../shared/popover";

type TaskMenuContext = {
  task: Task;
  rootDir: string;
};

const popover = usePopover<TaskMenuContext>();

if (import.meta.hot) {
  import.meta.hot.dispose(() => popover.stop());
}

export function useTaskMenu() {
  return popover;
}
