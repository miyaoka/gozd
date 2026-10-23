import { tryCatch } from "@gozd/shared";
import DOMPurify from "dompurify";

/** `<img src>` の書き換え。undefined を返した img は src を外す */
export type ImageSrcResolver = (src: string) => string | undefined;

/**
 * hook はインスタンス全体に掛かるため、既定の DOMPurify とは別のインスタンスを持つ。
 * 書き換え関数は sanitize の呼び出し中だけ置く（hook に引数を渡す口が無いため）。
 * sanitize は同期処理なので、インスタンスは全 MarkdownBody で 1 つを共有できる。
 */
const purify = DOMPurify(window);
let activeImageResolver: ImageSrcResolver | undefined;

purify.addHook("afterSanitizeAttributes", (node) => {
  if (activeImageResolver === undefined || node.nodeName !== "IMG") return;
  const src = node.getAttribute("src");
  if (src === null) return;
  const resolved = activeImageResolver(src);
  if (resolved === src) return;
  if (resolved === undefined) {
    node.removeAttribute("src");
    return;
  }
  node.setAttribute("src", resolved);
});

/**
 * markdown から変換した HTML を sanitize する。`resolveImageSrc` を渡すと `<img src>` を
 * sanitize の中で書き換える。DOM に入った時点でブラウザが src を読みに行くため、挿入後の
 * 書き換えでは renderer の origin への要求を防げない。sanitizer の URI allowlist を通った値だけが
 * 渡るので、本文に直書きされた未知 scheme は届かない。
 */
export function sanitizeMarkdownHtml(
  html: string,
  resolveImageSrc: ImageSrcResolver | undefined,
): string {
  activeImageResolver = resolveImageSrc;
  const result = tryCatch(() => purify.sanitize(html));
  activeImageResolver = undefined;
  if (!result.ok) throw result.error;
  return result.value;
}
