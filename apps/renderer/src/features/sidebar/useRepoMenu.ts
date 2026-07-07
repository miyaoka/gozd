/**
 * repo セクションヘッダの ⋮ menu の module singleton。
 *
 * 親 (SidebarPane) から `open(anchorEl, { rootDir })` を呼び、RepoMenu.vue が context を
 * 購読して描画する。メニュー内アクション (Revive session) は command registry 経由で
 * `workspace.reviveSession` を rootDir 付きで dispatch する (picker dialog は modal なので
 * anchor 不要)。
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
