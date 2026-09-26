/**
 * セッション行の ⋮ menu の module singleton。
 *
 * 親 (SidebarPane) から `open(anchorEl, { row, rootDir })` を呼び、
 * SessionMenu.vue が context を購読して描画する。
 */
import { usePopover } from "../../shared/popover";
import type { SessionRow } from "../session";

type SessionMenuContext = {
  row: SessionRow;
  rootDir: string;
};

const popover = usePopover<SessionMenuContext>();

if (import.meta.hot) {
  import.meta.hot.dispose(() => popover.stop());
}

export function useSessionMenu() {
  return popover;
}
