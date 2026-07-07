/**
 * Issue picker の状態を保持する module singleton composable。
 * IssuePickerDialog.vue が status / items をリアクティブに読み取り、
 * コマンドハンドラーは open() で loading を即時表示し、fetch 完了後に setResult() で埋める。
 * 状態機械の実体は createListPicker（PR picker と共通）。
 */

import type { GitIssue } from "@gozd/rpc";
import { createListPicker } from "../../createListPicker";

const picker = createListPicker<GitIssue>();

export function useIssuePicker() {
  return picker;
}
