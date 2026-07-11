/**
 * File picker（Go to File）の状態を保持する module singleton composable。
 * FilePickerDialog.vue が status / items をリアクティブに読み取り、
 * コマンドハンドラーは open() で loading を即時表示し、fetch 完了後に setResult() で埋める。
 * 状態機械の実体は createListPicker（PR / Issue picker と共通）。item は worktree 相対パス。
 */

import { createListPicker } from "../../createListPicker";

const picker = createListPicker<string>();

export function useFilePicker() {
  return picker;
}
