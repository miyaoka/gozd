// preview 面が main 側の配信経路に依存する部分の型。

import type { EmptyMessage } from "./common";

/**
 * HTML preview の iframe に load させる URL を得る。main 側は同時に `root` 配下を配信可能として
 * 登録する（VS Code の `localResourceRoots` と同型で、登録が無い path は配信しない）。
 *
 * srcdoc ではなく実 URL を load するのは、previewed HTML の相対リンク / 画像 / CSS を
 * document の base URL で解決させるため。srcdoc では base が親 (renderer) の URL になる。
 */
export interface PreviewHtmlUrlRequest {
  /** preview 対象 HTML の絶対パス */
  absPath: string;
  /** 配信を許す root の絶対パス。通常は対象ファイルが属する worktree root */
  root: string;
  /**
   * 要求元 preview の識別子。main は root の配信許可をこの id に紐づけて保持し、
   * `/preview/releaseHtml` で解放する。登録しっぱなしにすると閉じた preview の root が残り、
   * 別の preview がその配下を読めてしまう。
   */
  previewId: string;
}

export interface PreviewHtmlUrlResponse {
  /** iframe の src に入れる URL */
  url: string;
}

/** preview が閉じた / 対象を変えたときに、その preview が要求していた root を手放す。 */
export interface PreviewReleaseHtmlRequest {
  previewId: string;
}

export type PreviewReleaseHtmlResponse = EmptyMessage;
