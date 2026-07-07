/**
 * revive picker の状態を保持する module singleton composable。
 * RevivePickerDialog.vue が status / items をリアクティブに読み取り、
 * registerReviveCommand は open() で loading を即時表示し、fetch 完了後に setResult() で埋める。
 * 状態機械の実体は createListPicker（PR / Issue picker と共通）。
 */

import type { ReviveSessionInfo } from "@gozd/rpc";
import { createListPicker } from "../../createListPicker";

const picker = createListPicker<ReviveSessionInfo>();

export function useRevivePicker() {
  return picker;
}
