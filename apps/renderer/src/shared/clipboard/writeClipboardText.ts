import { tryCatch, type Result } from "@gozd/shared";

/**
 * navigator.clipboard へのテキスト書き込みを Result で返す。
 *
 * navigator.clipboard 自体が undefined の環境（古い WebView / 非 secure context）では
 * `.writeText` 参照時点で同期 throw するため、async IIFE で Promise 化してから tryCatch の
 * Promise 版に流し込む（関数版は Result<Promise<T>> を返すだけで Promise の reject を拾えない）。
 *
 * 成功 / 失敗時のフィードバック（トースト文言・状態表示）は call site ごとに異なるため
 * 呼び出し側の責務とする。
 */
export function writeClipboardText(text: string): Promise<Result<void>> {
  return tryCatch((async () => navigator.clipboard.writeText(text))());
}
