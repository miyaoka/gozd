// preview 面が main 側の配信経路に依存する部分の型。

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
}

export interface PreviewHtmlUrlResponse {
  /** iframe の src に入れる URL */
  url: string;
}
