// repo 内ファイル内容の全文検索（ripgrep 経由）。
//
// 検索結果は大量かつ逐次に届くため、単発 request/response では運ばない。handler が
// rg を spawn して stdout の NDJSON をパースし、マッチを `textSearchMatch` push で
// 逐次配信する。request の response は「検索完了（rg プロセス終了）」を表す終端信号で、
// `limitHit`（maxResults 到達で打ち切ったか）だけを返す。
//
// push と request の相関は `searchId`（呼び出し側が採番する不透明な文字列）で取る。
// 進行中の検索を止めるには同じ `searchId` で cancel を投げる。

export interface TextSearchQuery {
  /** 検索パターン。`isRegExp` が false なら固定文字列（rg の --fixed-strings）。 */
  pattern: string;
  /** 正規表現として解釈するか。未指定は false（固定文字列）。 */
  isRegExp?: boolean;
  /** 大文字小文字を区別するか。未指定は false（--ignore-case）。 */
  isCaseSensitive?: boolean;
  /** 単語境界一致（rg の \b 挟み込み）。未指定は false。 */
  isWordMatch?: boolean;
}

export interface TextSearchOptions {
  /** 対象に含める glob。空/未指定なら全ファイル。 */
  includes?: string[];
  /** 除外する glob。設定・検索ボックス由来の除外をここに集約する。 */
  excludes?: string[];
  /** .gitignore / .ignore を尊重するか。未指定は true（rg デフォルト）。
   *  false のとき rg に --no-ignore を渡す。 */
  useIgnoreFiles?: boolean;
  /** マッチ総数の上限。到達したら rg を kill して打ち切る。未指定は既定値。 */
  maxResults?: number;
  /** マッチ行の前後に含める文脈行数（rg の --before/--after-context）。 */
  surroundingContext?: number;
}

export interface TextSearchRequest {
  /** push と cancel の相関キー。呼び出し側が採番する。 */
  searchId: string;
  /** 検索対象ディレクトリの絶対パス（worktree root 等）。rg の cwd になる。 */
  dir: string;
  query: TextSearchQuery;
  options?: TextSearchOptions;
}

export interface TextSearchResponse {
  searchId: string;
  /** maxResults 到達で打ち切ったなら true。 */
  limitHit: boolean;
}

export interface TextSearchCancelRequest {
  searchId: string;
}

export interface TextSearchCancelResponse {
  /** 該当 searchId の検索が動いていて kill したなら true、既に終了/不在なら false。 */
  canceled: boolean;
}

/** マッチ行内の 1 マッチ範囲（行内の 0-based 文字列列）。 */
export interface TextSearchMatchRange {
  startColumn: number;
  endColumn: number;
}

/** 検索結果の 1 行。rg の match / context を統一して運ぶ。context 行は
 *  `isContext: true` で `ranges` が空。行は rg のファイル内順序で届く。 */
export interface TextSearchLineResult {
  /** `dir` からの相対パス。 */
  path: string;
  /** 0-based 行番号。 */
  line: number;
  /** 行の生テキスト（末尾改行を除く。プレビュー表示用）。 */
  text: string;
  /** 同一行内のマッチ範囲。context 行では空。 */
  ranges: TextSearchMatchRange[];
  /** マッチの前後に付く文脈行（surroundingContext 指定時）か。 */
  isContext: boolean;
}

/** `textSearchMatch` push の payload。1 push に複数行をまとめて載せる。 */
export interface TextSearchMatchPush {
  searchId: string;
  /** 検索元ディレクトリ（複数検索の並走時に購読側が突き合わせる補助キー）。 */
  dir: string;
  lines: TextSearchLineResult[];
}
