import System

// untrusted な subpath を base ディレクトリ配下へ安全に解決する path containment の SSOT。
//
// Apple 公式 `swift-system` の `FilePath.lexicallyResolving` を使う。これは「untrusted な
// subpath からの path traversal を防ぎ、結果が base 配下に lexically 収まることを保証する」
// 専用 API (ドキュメント記載の用途そのもの)。手書きの `URL.resolvingSymlinksInPath()` +
// 文字列 prefix 照合を置き換える:
//
// - **絶対パス注入を無害化**: subpath の root (`/etc/passwd` の `/`) を除去して base 配下に閉じる
// - **`..` 脱出を拒否**: 正規化後に先頭が `..` になる (base を抜ける) なら nil
// - **prefix 罠が無い**: component 単位で照合するため `/foo` が `/foobar` を誤許可しない
// - **FS 非依存**: symlink 解決も existence check もしないため、base が存在しなくても
//   (削除済み worktree root 等) 決定的に動作する。`URL(fileURLWithPath:)` の存在依存な
//   dir/file 判定に起因する「削除直後だけ containment が誤って外れる」バグが構造的に消える
//
// symlink に関する契約: lexical 解決なので base 配下に実在する escaping symlink は辿れてしまう
// (Apple ドキュメント明記の trade-off)。これで防御レベルは下がらない:
//   - bundle (`gozd-app://` の `.app` 内) は読み取り専用で symlink を仕込めない
//   - worktree (`gozd-rpc://` / `gozd-file://`) は user / Claude が自由に書ける作業ディレクトリ
//     で symlink を仕込めるが、機密ファイル読み取りの主防壁はここの containment ではない。
//     dir 制約なしで任意絶対パスを読む `/fs/readFileAbsolute` (preview が worktree 外ファイルを
//     表示する正規経路) が既に存在し、XSS 経由の bytes 回収を止めるのは `gozd-rpc://` の
//     CORS Origin allowlist (RpcSchemeHandler)。よって resolveSafe の symlink follow の有無は
//     防御の主軸でなく、lexical containment は「base 配下に閉じる」役割として必要十分。
public func resolveContained(base: String, subpath: String) -> String? {
  guard let resolved = FilePath(base).lexicallyResolving(FilePath(subpath)) else {
    return nil
  }
  return resolved.string
}
