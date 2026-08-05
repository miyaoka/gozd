// git-graph が持つ外部リンク（ref バッジの PR / commit message 中の issue 参照）のクリック処理。
//
// 「OS へ渡してよいか」の判定はクリックを受け取れる層が担う契約なので、ここで `openExternal` を
// 呼ぶ。`target="_blank"` でブラウザ既定の new-window 要求に委ねる経路は使えない — main の
// navigation 防壁は URL を見ずに新 window を deny するため、委ねた先が存在しない。
import { tryCatch } from "@gozd/shared";
import { useNotificationStore } from "../../shared/notification";
import { openExternal } from "../../shared/rpc";

/** 固定 message + 詳細を cause に分離し、URL 違いのリンク連打でトーストが累積しないようにする */
const LINK_OPEN_FAILED_MESSAGE = "Could not open link in the browser";

/**
 * リンク起動を `openExternal` に流す。`click` と `auxclick` の両方に bind する。
 *
 * 中クリックは `click` を発火せず `auxclick` になるため、片方だけ bind すると既定の new-window
 * 要求に落ち、防壁の deny で何も起きないリンクになる。
 */
export function activateExternalLink(event: MouseEvent, url: string) {
  if (event.button !== 0 && event.button !== 1) return;
  // commit 行のクリック（commit 選択）へ伝播させない。リンク起動しない control+click でも
  // 止めるのは、リンクを狙ったクリックが行選択に化けないようにするため
  event.stopPropagation();
  // macOS の WebKit は control+click を button 0 の click として dispatch する。
  // 意図はコンテキストメニューなので、リンク起動として扱わない
  if (event.ctrlKey) return;

  event.preventDefault();

  const notify = useNotificationStore();
  void tryCatch(openExternal(url)).then((opened) => {
    if (opened.ok) return;
    notify.error(LINK_OPEN_FAILED_MESSAGE, new Error(`url=${url}`, { cause: opened.error }));
  });
}
