// URL を OS のデフォルトアプリで開く経路。
//
// renderer 内で「リンクを OS に渡す」意思決定をする層（markdown 本文 / terminal の OSC 8 /
// filer の submodule リンク）はすべてここを通す。main の `/open/external` route は scheme を
// 見ない。
//
// 唯一の例外が HTML preview の subframe で、そこは renderer からクリックを傍受できないため
// main の navigation 防壁が判定する。両者が同じ集合を見るよう、allowlist は `@gozd/shared` の
// `isExternalUrl` が SSOT（層ごとに別集合を持つと経路で挙動が変わる）。
//
// VS Code も allowlist を `mainThreadWebviews.isSupportedLink`（リンククリックを受け取る層）に
// 置いている。
import type { OpenExternalRequest, OpenExternalResponse } from "@gozd/rpc";
import { isExternalUrl } from "@gozd/shared";
import { rpc } from "./client";

/**
 * URL を OS のデフォルトアプリで開く。allowlist 外の scheme は開かずに reject する
 * （呼び出し側が通知に倒せるよう、silent drop ではなくエラーにする）。
 */
export async function openExternal(url: string): Promise<void> {
  if (!isExternalUrl(url)) {
    throw new Error(`openExternal refused: scheme not allowed: ${url}`);
  }
  await rpc<OpenExternalResponse>("/open/external", { url } satisfies OpenExternalRequest);
}
