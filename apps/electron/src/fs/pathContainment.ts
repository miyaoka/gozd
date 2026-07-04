// untrusted な subpath を base ディレクトリ配下へ安全に解決する path containment の SSOT。
// Swift 版 `PathContainment.swift`（`FilePath.lexicallyResolving`）の対応物。
//
// - **絶対パス注入を無害化**: subpath の root（`/etc/passwd` の `/`）を除去して base 配下に閉じる
// - **`..` 脱出を拒否**: 正規化後に先頭が `..` になる（base を抜ける）なら undefined
// - **prefix 罠が無い**: 正規化した相対 path を join するため `/foo` が `/foobar` を誤許可しない
// - **FS 非依存**: symlink 解決も existence check もしないため、base が存在しなくても
//   （削除済み worktree root 等）決定的に動作する
//
// symlink に関する契約: lexical 解決なので base 配下に実在する escaping symlink は辿れてしまう。
// これで防御レベルは下がらない — worktree は user / Claude が自由に書ける作業ディレクトリで、
// dir 制約なしの `/fs/readFileAbsolute`（preview の正規経路）が既に存在する。機密 bytes 回収を
// 止める主防壁は CORS Origin allowlist 側にあり、lexical containment は「base 配下に閉じる」
// 役割として必要十分（詳細は Swift 版 PathContainment.swift の冒頭コメント）。

import { join, normalize } from "node:path";

export function resolveContained(base: string, subpath: string): string | undefined {
  // 絶対パス注入の無害化: 先頭の root を除去して相対 path として扱う
  const relative = subpath.replace(/^\/+/, "");
  const normalized = normalize(relative);
  // 正規化後に base を抜ける traversal は拒否
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return join(base, normalized);
}
