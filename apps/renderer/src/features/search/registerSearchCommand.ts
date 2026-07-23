/**
 * 全文検索コマンド（Find in Files）。Cmd+Shift+F / コマンドパレットから検索パネルを開き、
 * 入力へ focus する。file-picker（Cmd+P）と同じく precondition を isGitRepo に揃える。
 */

import { useCommandRegistry } from "../../shared/command";
import { useSearchStore } from "./useSearchStore";

export function registerSearchCommand(): () => void {
  const registry = useCommandRegistry();
  const store = useSearchStore();

  return registry.register("search.show", {
    label: "Search: Find in Files",
    precondition: "isGitRepo",
    handler: () => {
      // dialog の open + 入力 focus は SearchDialog が showSignal を受けて行う（file-picker と同流儀）
      store.show();
      return true;
    },
  });
}
