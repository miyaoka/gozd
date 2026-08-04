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

/**
 * native preview（iframe 描画）を出せる状態か。
 *
 * 配信経路は **working tree の実ファイル** しか読めないため、表示中の rev がディスクの実体と
 * 一致するときにしか native preview を出せない。一致しない状態（original / commit / PR diff /
 * 実体なし）で出すと、ユーザーが選んだ rev と違う内容を描いてしまう。条件を満たさないときは
 * 呼び出し側が target を undefined にし、source 表示へ倒す（実体があるときだけ Open in default
 * app を描画する `resolveOpenablePath` と同じ gate の切り方）。
 */
export function canRenderHtmlNatively(state: {
  /** 表示中のモード。current 以外はディスクの実体と一致しない */
  activeMode: string;
  /** commit / PR diff 選択中か。working tree ではなく履歴版を見ている */
  isSnapshot: boolean;
  /** working tree に実体が無い（deleted 等） */
  isNotFound: boolean;
}): boolean {
  return state.activeMode === "current" && !state.isSnapshot && !state.isNotFound;
}

/** 絶対パスの親ディレクトリ。root 直下のファイルは親を持たない扱いにする */
function dirOf(absPath: string): string | undefined {
  const lastSlash = absPath.lastIndexOf("/");
  return lastSlash <= 0 ? undefined : absPath.substring(0, lastSlash);
}

/**
 * worktree 内のファイルは worktree root 配下を配信可能にする（相対リンクが worktree 内の
 * 別ディレクトリを指す HTML があるため）。worktree 外の絶対パスは、そのファイルが居る
 * ディレクトリだけに絞る（起点が無いので広げる根拠が無い）。
 *
 * root が `/` に退化する場合は undefined を返し、呼び出し側は source 表示に倒す。
 */
export function htmlPreviewTarget(
  absPath: string,
  worktreeDir: string | undefined,
): HtmlPreviewTarget | undefined {
  const root = worktreeDir ?? dirOf(absPath);
  // root が "/" になるとファイルシステム全体が配信可能になり、範囲を絞る意味が消える。
  // 該当するのは worktree 外かつ root 直下のファイルだけなので native preview を諦める
  if (root === undefined || root === "/") return undefined;
  return { absPath, root };
}
