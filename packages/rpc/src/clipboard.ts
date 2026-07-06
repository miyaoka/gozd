// OS クリップボードへのファイル参照書き込み。
// テキスト（path 文字列）ではなく macOS pasteboard のファイル参照形式で書くことで、
// Finder / Slack 等の他アプリへ「ファイルそのもの」を paste できるようにする。
// renderer の navigator.clipboard はファイル参照を書けないため main 側 RPC に置く。

import type { EmptyMessage } from "./common";

export interface ClipboardCopyFilesRequest {
  /** コピーするファイル / ディレクトリの絶対パス。空配列は main 側で reject される */
  paths: string[];
}

export type ClipboardCopyFilesResponse = EmptyMessage;
