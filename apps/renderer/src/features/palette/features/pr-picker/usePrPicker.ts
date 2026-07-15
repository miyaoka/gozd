/**
 * PR picker の状態を保持する module singleton composable。
 * PrPickerDialog.vue が status / items をリアクティブに読み取り、
 * コマンドハンドラーは open() で loading を即時表示し、fetch 完了後に setResult() で埋める。
 * 状態機械の実体は createListPicker（Issue picker と共通）。
 */

import type { GitPullRequest, Task } from "@gozd/rpc";
import { createListPicker } from "../../createListPicker";

/** picker 行 1 件分。fetch 時に repo 内の既存 task を ghRef で JOIN 済みの形で持つ。
 * existingTask を持つ PR は選択時に worktree を作成せず、その task の worktree を表示する。 */
export interface PrPickerItem {
  pr: GitPullRequest;
  existingTask?: Task;
  /** rootDir + ghRef の排他キー (`inFlightKey`)。コマンド層が accept 実行中の排他に、
   * dialog が行スピナー表示と選択ブロックに使う。 */
  refKey: string;
}

const picker = createListPicker<PrPickerItem>();

export function usePrPicker() {
  return picker;
}
