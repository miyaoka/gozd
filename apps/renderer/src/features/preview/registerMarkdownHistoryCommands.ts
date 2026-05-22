/**
 * Markdown preview の back / forward コマンドを登録する。MainLayout から `registerThemeCommand`
 * 等と同じ命名規律で呼ばれる。
 *
 * 関数経由で登録することで `useMarkdownHistoryStore` の export を preview feature 内に閉じ込め、
 * 「履歴の発生源は MarkdownPreview の `<a>` クリックだけ」という規律を feature 境界の閉鎖性で
 * 構造保証する。外部 feature が `navigate()` を直接呼べる経路を残さない。
 *
 * handler が `true` を返す契約: `useKeyBindings` は `execute` の戻り値が true のときだけ
 * `preventDefault` / `stopPropagation` を呼ぶ。precondition `previewVisible` で gating した
 * 時点でユーザー意図は「マニュアル back / forward」確定なので、stack が空でもブラウザ既定
 * (WebKit の `cmd+[` history back 等) に逃さないため常に true を返す。
 */
import { useCommandRegistry } from "../../shared/command";
import { useMarkdownHistoryStore } from "./useMarkdownHistoryStore";

export function registerMarkdownHistoryCommands(): () => void {
  const { register } = useCommandRegistry();
  const markdownHistory = useMarkdownHistoryStore();

  const disposeBack = register("markdownPreview.back", {
    label: "Markdown Preview: Go Back",
    precondition: "previewVisible",
    handler: () => {
      markdownHistory.goBack();
      return true;
    },
  });
  const disposeForward = register("markdownPreview.forward", {
    label: "Markdown Preview: Go Forward",
    precondition: "previewVisible",
    handler: () => {
      markdownHistory.goForward();
      return true;
    },
  });

  return () => {
    disposeBack();
    disposeForward();
  };
}
