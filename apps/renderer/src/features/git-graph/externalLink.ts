// git-graph が持つ外部リンク（ref バッジの PR / commit message 中の issue 参照）のクリック処理。
// 起動条件と失敗 message は `shared/rpc` が SSOT で、ここは commit 行への伝播の扱いだけを足す。
import { tryCatch } from "@gozd/shared";
import { useNotificationStore } from "../../shared/notification";
import { isLinkActivation, LINK_OPEN_FAILED_MESSAGE, openExternal } from "../../shared/rpc";

/** リンク起動を OS のブラウザへ流す。`click` と `auxclick` の両方に bind する。 */
export function activateExternalLink(event: MouseEvent, url: string) {
  if (!isLinkActivation(event)) return;

  event.preventDefault();
  // リンク上のクリックを commit 行へ渡さない（行が修飾キーをどう扱うかに依存させない）
  event.stopPropagation();

  const notify = useNotificationStore();
  void tryCatch(openExternal(url)).then((opened) => {
    if (opened.ok) return;
    notify.error(LINK_OPEN_FAILED_MESSAGE, new Error(`url=${url}`, { cause: opened.error }));
  });
}
