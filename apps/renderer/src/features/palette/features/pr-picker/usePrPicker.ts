/**
 * PR picker の状態を保持する module singleton composable。
 * PrPickerDialog.vue が status / items をリアクティブに読み取り、
 * コマンドハンドラーは open() で loading を即時表示し、fetch 完了後に setResult() で埋める。
 * 状態機械の実体は createListPicker（Issue picker と共通）。
 */

import type { GitPullRequest } from "@gozd/rpc";
import { createListPicker } from "../../createListPicker";

/** picker 行 1 件分 */
export interface PrPickerItem {
  pr: GitPullRequest;
  /** rootDir + PR 番号の排他キー (`inFlightKey`)。用途は inFlightGhRefs.ts の module doc。 */
  refKey: string;
}

const picker = createListPicker<PrPickerItem>();

export function usePrPicker() {
  return picker;
}
