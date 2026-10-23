// preview 面が main 側の配信経路に依存する部分の型。

import type { EmptyMessage } from "./common";

/**
 * 配信 scheme での `absPath` の URL を得る。main 側は同時に `root` 配下を配信可能として
 * 登録する（VS Code の `localResourceRoots` と同型で、登録が無い path は配信しない）。
 *
 * HTML preview は iframe にこの URL を load させ、previewed HTML の相対リンク / 画像 / CSS を
 * document の base URL で解決させる（srcdoc では base が親 (renderer) の URL になる）。
 * markdown preview はこの URL を基準に `<img src>` を書き換える。
 */
export interface PreviewServingUrlRequest {
  /** preview 対象（HTML / markdown）の絶対パス */
  absPath: string;
  /** 配信を許す root の絶対パス。通常は対象ファイルが属する worktree root */
  root: string;
  /**
   * 要求元 preview の識別子。配信 URL の **host 部**に載り、origin を preview ごとに分ける
   * （同一 origin だと CSP の `'self'` が preview 間の壁にならない）。main は配信許可をこの id に
   * 紐づけて保持し、`/preview/releaseServing` で解放する。
   *
   * host は URL パーサが正規化するため、**小文字英数とハイフンだけ**で構成すること。大文字等が
   * 混じると登録キー（生の id）と host（正規化後）が食い違い、配信だけ 403 になる。
   */
  previewId: string;
}

export interface PreviewServingUrlResponse {
  /** `absPath` の配信 URL */
  url: string;
}

/** preview が閉じた / 対象を変えたときに、その preview が要求していた root を手放す。 */
export interface PreviewReleaseServingRequest {
  previewId: string;
}

export type PreviewReleaseServingResponse = EmptyMessage;
