// URL を OS のデフォルトアプリで開く唯一の経路と、その scheme allowlist。
//
// renderer 内で「リンクを OS に渡す」意思決定をする層（markdown 本文 / terminal の OSC 8 /
// filer の submodule リンク）はすべてここを通す。main は navigation 防壁も `/open/external`
// route も scheme を見ない。判定点を分散させると「同じリンクでも通った経路で開く / 開かないが
// 変わる」非対称が生まれる。
//
// VS Code が allowlist を `mainThreadWebviews.isSupportedLink`（リンククリックを受け取る層）に
// だけ置き、main プロセスの `openExternal` / `setWindowOpenHandler` / `will-navigate` は
// いずれも scheme を見ないのと同じ構造。
import type { OpenExternalRequest, OpenExternalResponse } from "@gozd/rpc";
import { rpc } from "./client";

/**
 * OS のデフォルトアプリで開いてよい URL scheme。
 * `vscode:` に相当する gozd 独自 scheme は存在しないため http(s) / mailto の 3 つに閉じる。
 */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

/** OS へ渡してよい URL か。parse 不能な文字列は渡さない。 */
export function isExternalUrl(url: string): boolean {
  try {
    return ALLOWED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

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
