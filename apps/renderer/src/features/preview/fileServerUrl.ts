/** `gozd-file://` URLSchemeHandler の root URL (固定文字列)。dir / path はクエリで運ぶ契約 */
const FILE_SERVER_BASE_URL = "gozd-file://localhost/";

/**
 * `gozd-file://` URLSchemeHandler の URL を構築。worktree 相対パスのみが対象
 * (file server は worktree 配下を提供する経路)。絶対パス選択中は呼び出さない。
 *
 * 形式: `gozd-file://localhost/{fs|git}?dir=<absDir>&path=<relPath>&v=<version>`
 *   - `/fs`  : 作業ツリーの実ファイル
 *   - `/git` : `git show HEAD:<path>` の出力 (Original タブの画像)
 *
 * `?v=` は fsChange 等で同一 URL を再読み込みさせるためのキャッシュバスト。
 */
export function buildFileServerUrl(
  dir: string,
  relPath: string,
  version: number,
  gitOriginal = false,
): string {
  const kind = gitOriginal ? "git" : "fs";
  const url = new URL(kind, FILE_SERVER_BASE_URL);
  url.searchParams.set("dir", dir);
  url.searchParams.set("path", relPath);
  url.searchParams.set("v", String(version));
  return url.href;
}

/**
 * worktree 外の絶対パス画像 / SVG 用の `gozd-file://localhost/abs?path=<absPath>&v=<version>` を構築。
 * `/abs` は dir 制約を持たず、テキスト preview の `fsReadFileAbsolute` と同じ「worktree 外参照」
 * 契約を `<img>` 経路に揃える。git 履歴を持たないため Original タブ (gitOriginal) は無い。
 */
export function buildAbsFileServerUrl(absPath: string, version: number): string {
  const url = new URL("abs", FILE_SERVER_BASE_URL);
  url.searchParams.set("path", absPath);
  url.searchParams.set("v", String(version));
  return url.href;
}
