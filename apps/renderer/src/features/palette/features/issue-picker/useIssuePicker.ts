/**
 * Issue picker の状態を保持する module singleton composable。
 * IssuePickerDialog.vue が status / items をリアクティブに読み取り、
 * コマンドハンドラーは open() で loading を即時表示し、fetch 完了後に setResult() で埋める。
 * 状態機械の実体は createListPicker（PR picker と共通）。
 */

import type { GitIssue, Task } from "@gozd/rpc";
import { createListPicker } from "../../createListPicker";

/** picker 行 1 件分。fetch 時に repo 内の既存 task を ghRef で JOIN 済みの形で持つ。
 * existingTask を持つ issue は選択時に worktree を作成せず、その task の worktree を表示する。 */
export interface IssuePickerItem {
  issue: GitIssue;
  existingTask?: Task;
}

const picker = createListPicker<IssuePickerItem>();

export function useIssuePicker() {
  return picker;
}
