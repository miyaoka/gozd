/**
 * repo list chip の context menu の module singleton。
 *
 * 親 (SidebarPane) から `open(anchorEl, { listId })` を呼び、ListMenu.vue が context を
 * 購読して描画する。rename / delete は常時ボタンとして露出させず、このメニュー経由の
 * 明示操作に限定する（delete はさらに確認ダイアログを挟む二段階）。
 */
import { usePopover } from "../../shared/popover";

type ListMenuContext = {
  listId: string;
};

const popover = usePopover<ListMenuContext>();

if (import.meta.hot) {
  import.meta.hot.dispose(() => popover.stop());
}

export function useListMenu() {
  return popover;
}
