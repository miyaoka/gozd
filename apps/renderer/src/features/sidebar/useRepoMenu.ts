/**
 * repo セクションヘッダの ⋮ menu の module singleton。
 *
 * 親 (SidebarPane) から `open(anchorEl, { rootDir })` を呼び、RepoMenu.vue が context を
 * 購読して描画する。メニュー内アクションは command registry 経由で rootDir 付き dispatch する。
 */
import { usePopover } from "../../shared/popover";

type RepoMenuContext = {
  rootDir: string;
};

const popover = usePopover<RepoMenuContext>();

if (import.meta.hot) {
  import.meta.hot.dispose(() => popover.stop());
}

export function useRepoMenu() {
  return popover;
}
