/**
 * HTML preview の配信対象と、配信を許す root の導出。
 *
 * 本体 preview (PreviewPane) と undock window (UndockedPreviewWindow) が同じ規則を使うため
 * 純関数に切り出す。root は main の配信範囲になるので、広げすぎると preview 経由で読める
 * ファイルが増える（VS Code の `localResourceRoots` と同じ性質）。
 */

export interface HtmlPreviewTarget {
  /** preview 対象 HTML の絶対パス */
  absPath: string;
  /** 配信を許す root の絶対パス */
  root: string;
}

/** 絶対パスの親ディレクトリ。root 直下は "/" を返す */
function dirOf(absPath: string): string {
  const lastSlash = absPath.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : absPath.substring(0, lastSlash);
}

/**
 * worktree 内のファイルは worktree root 配下を配信可能にする（相対リンクが worktree 内の
 * 別ディレクトリを指す HTML があるため）。worktree 外の絶対パスは、そのファイルが居る
 * ディレクトリだけに絞る（起点が無いので広げる根拠が無い）。
 */
export function htmlPreviewTarget(
  absPath: string,
  worktreeDir: string | undefined,
): HtmlPreviewTarget {
  return { absPath, root: worktreeDir ?? dirOf(absPath) };
}
