/**
 * native の `notify` push の payload。SSOT としてここで定義し、購読する全 feature
 * (`layout/useNotifySubscription` でのトースト表示、`sidebar/useSidebarData` での
 * TaskStore 失敗時 rollback など) で同型を re-use する。
 */
export interface NotifyPayload {
  type: "error" | "info";
  source: string;
  message: string;
  detail: string;
  /**
   * 失敗の発生源 worktree path / project anchor dir。renderer 側が
   * `findRepoOwning(dir)` で該当 repo を特定して絞り込み refetch する手がかり。
   * 起動時 reconcile や socket / claude-hooks など経路に紐付かない通知は空文字。
   */
  dir: string;
}
