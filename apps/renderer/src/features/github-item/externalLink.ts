// GitHub の項目を指すリンクのクリック処理。起動条件と失敗 message は `shared/rpc` が SSOT で、
// ここは背後の行へクリックを渡さない扱いだけを足す（リンクを含む行がクリック可能な画面で、
// 行が修飾キーをどう扱うかにリンクの挙動を依存させないため）。
import { tryCatch } from "@gozd/shared";
import { useNotificationStore } from "../../shared/notification";
import { isLinkActivation, LINK_OPEN_FAILED_MESSAGE, openExternal } from "../../shared/rpc";

/** リンク起動を OS のブラウザへ流す。`click` と `auxclick` の両方に bind する。 */
export function activateExternalLink(event: MouseEvent, url: string) {
  if (!isLinkActivation(event)) return;

  event.preventDefault();
  event.stopPropagation();

  const notify = useNotificationStore();
  void tryCatch(openExternal(url)).then((opened) => {
    if (opened.ok) return;
    notify.error(LINK_OPEN_FAILED_MESSAGE, new Error(`url=${url}`, { cause: opened.error }));
  });
}
