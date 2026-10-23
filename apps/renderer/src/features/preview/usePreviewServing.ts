import { tryCatch } from "@gozd/shared";
import { onBeforeUnmount } from "vue";
import { rpcPreviewHtmlUrl, rpcPreviewReleaseHtml } from "./rpc";

/**
 * main の配信 scheme (`gozd-preview://`) から読む preview 面 1 つ分の配信許可。
 * HTML preview の iframe と markdown preview の画像が使う。
 *
 * 許可は instance の id に紐づき、unmount で手放す。解放しないと閉じた preview の root が残り、
 * 別の preview がその配下を読めてしまう。id は URL の host 部に載り、origin を preview ごとに分ける。
 */
export function usePreviewServing() {
  const previewId = crypto.randomUUID();

  /**
   * 要求の直列化。前回の要求が終わってから次を始める。
   *
   * main は「最後に完了した要求」の root を配信許可として保持するため、並行させると repo をまたぐ
   * 素早い切替で完了順が逆転し、許可が前の root に残ったまま新しい URL を読みに行って 403 になる
   * （呼び出し側の版数ガードは結果の取り違えしか防げない）。発射順 = 処理順にすれば起きない。
   */
  let pending: Promise<unknown> = Promise.resolve();

  /** `absPath` の配信 URL を得る。同時に `root` 配下がこの preview に配信可能として登録される */
  function requestUrl(absPath: string, root: string) {
    const run = pending.then(() => tryCatch(rpcPreviewHtmlUrl({ absPath, root, previewId })));
    // 失敗しても次の要求を止めないよう、chain 自体は解決済みに保つ
    pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  onBeforeUnmount(() => {
    // 解放も同じキューに載せる。直列化しないと、in-flight の要求が解放の後に完了して
    // grant を再登録し、閉じた preview の配信許可がプロセスの生存期間ずっと残る。
    // 解放できなくても UI 上は何も起きないので観察ログを残す
    pending = pending.then(() =>
      tryCatch(rpcPreviewReleaseHtml({ previewId })).then((released) => {
        if (!released.ok) {
          console.error(
            `[usePreviewServing] failed to release preview root: ${String(released.error)}`,
          );
        }
      }),
    );
  });

  return { requestUrl };
}
