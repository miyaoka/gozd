// 「OS へ渡してよい URL」の契約。renderer と main の両方が参照する。
//
// 主たる判定点は renderer の `shared/rpc` の openExternal で、リンククリックを受け取る層は
// すべてそこを通る。
//
// 例外が HTML preview の subframe。opaque ではない実 origin で配信され script も CSP で
// 止めてあるため renderer からクリックを傍受できず、main の navigation 防壁が唯一の
// 受け取り口になる。そこでも同じ集合で判定する必要があるので、集合をパッケージ間で共有する。
// 層ごとに別集合を持つと「同じリンクでも通った経路で開く / 開かないが変わる」非対称が生まれる。

import { tryCatch } from "./result";

/**
 * OS のデフォルトアプリで開いてよい URL scheme。
 * `vscode:` に相当する gozd 独自 scheme は存在しないため http(s) / mailto の 3 つに閉じる。
 */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

/** OS へ渡してよい URL か。parse 不能な文字列は渡さない。 */
export function isExternalUrl(url: string): boolean {
  const parsed = tryCatch(() => new URL(url));
  if (!parsed.ok) return false;
  return ALLOWED_SCHEMES.has(parsed.value.protocol);
}
