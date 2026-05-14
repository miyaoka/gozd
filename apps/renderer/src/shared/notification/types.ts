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
}
