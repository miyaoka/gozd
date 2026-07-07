/**
 * PR picker の状態を保持する module singleton composable。
 * PrPickerDialog.vue が status / items をリアクティブに読み取り、
 * コマンドハンドラーは open() で loading を即時表示し、fetch 完了後に setResult() で埋める。
 * 状態機械の実体は createListPicker（Issue picker と共通）。
 */

import type { GitPullRequest } from "@gozd/rpc";
import { createListPicker } from "../../createListPicker";

const picker = createListPicker<GitPullRequest>();

export function usePrPicker() {
  return picker;
}
