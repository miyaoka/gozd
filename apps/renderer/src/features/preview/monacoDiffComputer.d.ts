/**
 * monaco-editor ESM 内部モジュールの型宣言。
 *
 * npm 配布物の `esm/` は 1 モジュール 1 ファイルの .js のみで型宣言 (.d.ts) を同梱しない
 * (公開型は `monaco.d.ts` の public API に限られ、diff computer は含まれない)。
 * intraLineDiff.ts が使う最小限の surface だけを VSCode 本体
 * (`src/vs/editor/common/diff/`) の型定義から書き写して宣言する。
 *
 * Range の column / lineNumber は 1-based、end は exclusive (VSCode Range の契約)。
 */
declare module "monaco-editor/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js" {
  interface DiffRange {
    readonly startLineNumber: number;
    readonly startColumn: number;
    readonly endLineNumber: number;
    readonly endColumn: number;
  }

  interface RangeMapping {
    readonly originalRange: DiffRange;
    readonly modifiedRange: DiffRange;
  }

  interface DetailedLineRangeMapping {
    /** この行ブロック内の文字単位の変更対応。undefined は行単位のみの変更 */
    readonly innerChanges: readonly RangeMapping[] | undefined;
  }

  interface LinesDiff {
    readonly changes: readonly DetailedLineRangeMapping[];
    /** maxComputationTimeMs 超過で打ち切られたか (結果は近似) */
    readonly hitTimeout: boolean;
  }

  interface LinesDiffComputerOptions {
    readonly ignoreTrimWhitespace: boolean;
    /** 0 は無制限 */
    readonly maxComputationTimeMs: number;
    readonly computeMoves: boolean;
  }

  export class DefaultLinesDiffComputer {
    computeDiff(
      originalLines: string[],
      modifiedLines: string[],
      options: LinesDiffComputerOptions,
    ): LinesDiff;
  }
}
