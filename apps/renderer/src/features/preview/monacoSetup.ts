/**
 * Monaco Editor の worker 環境セットアップ。preview の編集機能 (CodeEditor / DiffPreview の
 * editable モード) が `import("./monacoSetup")` で動的 import した時点で 1 度だけ実行される
 * (module 評価は import 時に 1 回)。編集モードに入らない閲覧専用ユーザーはロードしない。
 *
 * Vite plugin (`vite-plugin-monaco-editor-esm` 等) は使わない。最終更新から 1 年以上経過しており
 * 依存先として採用しない (CLAUDE.md 生存判定規律)。代わりに Vite 標準の `?worker` import で
 * worker を手動セットアップする (同ジャンルの実プロダクト stablyai/orca と同じ方式)。
 *
 * TypeScript の semantic validation (noSemanticValidation 等) の無効化は見送っている。
 * `monaco-editor@0.55.1` の npm 配布物は `esm/vs/language/typescript/monaco.contribution.ts`
 * ソース上に `typescriptDefaults` / `javascriptDefaults` の export を持つが (ghq で取得した
 * microsoft/monaco-editor の v0.55.1 タグで確認済み)、配布されるビルド成果物の `.d.ts` には
 * この export が含まれておらず型解決できない (ランタイムの `monaco.languages.typescript` 経由
 * では到達できるが、そちらは型定義上 `{ deprecated: true }` に潰されている)。診断無効化は
 * 「あれば良い」機能 (gozd は viewer/diff surface として使うだけで実際のコード編集は別 IDE で行う
 * 前提) であり、型を捻じ曲げてまで到達する価値がないため見送る。
 */
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// `monaco-editor` は全言語 contribution を含む「全部入り」パッケージ (exports map に
// エントリーポイントが 1 つしかなく、モジュラーな部分 import には別パッケージ
// `monaco-editor-core` への切替えが必要)。今回は切替えを見送り、全部入り構成を受け入れる。
// 動的 import + build 側の chunk 分割 (`vite.config.ts` に codeSplitting 無効化の指定は無い) に
// より、このモジュールは編集モード突入時にのみ別チャンクとしてロードされる。よって worker も
// 言語ごとに正しくルーティングし、CSS/HTML/JSON/TypeScript の言語サービス (diagnostics 等) を
// フルに使える状態にしておく。
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

/** ファイルパスから Monaco の言語 ID を逆引きする (Monaco 自身の登録メタデータが SSOT)。 */
function detectMonacoLanguage(filePath: string): string {
  const fileName = filePath.split("/").pop() ?? filePath;
  const ext = `.${fileName.split(".").pop() ?? ""}`;
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.includes(fileName)) return lang.id;
    if (lang.extensions?.includes(ext)) return lang.id;
  }
  return "plaintext";
}

export { monaco, detectMonacoLanguage };
