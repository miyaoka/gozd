import { tryCatch } from "@gozd/shared";
import DOMPurify from "dompurify";
import { keepAllowedImageScheme } from "./resolveMarkdownImageSrc";
import { rewriteSrcset } from "./rewriteSrcset";

/** 画像の URL 1 つの書き換え。undefined を返した URL は読ませない */
export type ImageSrcResolver = (src: string) => string | undefined;

/**
 * hook はインスタンス全体に掛かるため、既定の DOMPurify とは別のインスタンスを持つ。
 * 書き換え関数は sanitize の呼び出し中だけ置く（hook に引数を渡す口が無いため）。
 * sanitize は同期処理なので、インスタンスは全 MarkdownBody で 1 つを共有できる。
 */
const purify = DOMPurify(window);
let activeImageResolver: ImageSrcResolver | undefined;

/** 属性を書き換える。undefined なら属性ごと外す（残すと renderer の origin へ要求が飛ぶ） */
function rewriteAttribute(
  node: Element,
  name: string,
  rewrite: (value: string) => string | undefined,
): void {
  const value = node.getAttribute(name);
  if (value === null) return;
  const rewritten = rewrite(value);
  if (rewritten === value) return;
  if (rewritten === undefined) {
    node.removeAttribute(name);
    return;
  }
  node.setAttribute(name, rewritten);
}

// 画像の URL を持つ属性。`<picture>` の `<source>` は srcset だけを持つ
const IMAGE_URL_ATTRIBUTES: Record<string, { src: boolean; srcset: boolean }> = {
  IMG: { src: true, srcset: true },
  SOURCE: { src: false, srcset: true },
};

purify.addHook("afterSanitizeAttributes", (node) => {
  // 書き換え関数を渡さない利用側（session log 等）でも、画像の URL（src と srcset の各候補）の
  // scheme は http(s) / data: に絞る。sanitizer は属性値の先頭しか見ないため、srcset の 2 つ目
  // 以降の候補に書かれた配信 scheme が素通りする
  const resolver = activeImageResolver ?? keepAllowedImageScheme;
  const attributes = IMAGE_URL_ATTRIBUTES[node.nodeName];
  if (attributes === undefined) return;
  if (attributes.src) rewriteAttribute(node, "src", resolver);
  if (attributes.srcset) {
    rewriteAttribute(node, "srcset", (value) => rewriteSrcset(value, resolver));
  }
});

/**
 * markdown から変換した HTML を sanitize する。`resolveImageSrc` を渡すと画像の URL
 * （`<img src>` / `<img srcset>` / `<source srcset>` の各候補）を sanitize の中で書き換える。
 * DOM に入った時点でブラウザが読みに行くため、挿入後の書き換えでは renderer の origin への
 * 要求を防げない。
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
