// main → renderer の観測系 push payload。
// main は renderer のトースト / イベントログ ring buffer に直接触れないため、
// push で通知を運び renderer 側の購読 bridge が表示へ流す。

/** notify push payload。購読する全 feature (トースト表示 / TaskStore 失敗時 rollback 等) が同型を使う。 */
export interface NotifyPayload {
  type: "error" | "info";
  source: string;
  message: string;
  detail: string;
  /**
   * 失敗の発生源 worktree path / project anchor dir。renderer 側が
   * `findRepoOwning(dir)` で該当 repo を特定して絞り込み refetch する手がかり。
   * socket / claude-hooks など経路に紐付かない通知は空文字 (購読側で skip)。
   */
  dir: string;
}

/** debugLog push payload。main プロセス発の観測イベントを renderer の logEvent に載せる
 * （utilityProcess 隔離した watcher の crash/respawn 等）。 */
export interface DebugLogPayload {
  channel: string;
  label: string;
  repo: string;
  detail: string;
}
