/**
 * Monaco Editor の worker 環境セットアップと Shiki ハイライト統合。preview のコード表示・編集
 * (CodePreview) が `import("./monacoSetup")` で動的 import した時点で 1 度だけ実行される
 * (module 評価は import 時に 1 回)。コードファイルを開かないユーザーはロードしない。
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
 *
 * ## Shiki 統合 (`@shikijs/monaco`)
 *
 * Monaco 標準のハイライトは Monarch (独自の宣言的 grammar) で、Vue 等 TextMate grammar でしか
 * 提供されない言語をハイライトできない。`shikiToMonaco` が `monaco.languages.setTokensProvider`
 * に Shiki の TextMate エンジン (`grammar.tokenizeLine2`。VS Code 本体と同じ呼び口) を接ぎ込む
 * ことで、Shiki が扱える全言語を Monaco 上でハイライトできる。既に Monaco が Monarch grammar を
 * 持つ言語 (typescript 等) も setTokensProvider が Monarch を上書きし、VS Code 品質に揃う。
 *
 * grammar は eager load しない (useHighlight.ts と同じ on-demand 規律)。`resolveMonacoLanguage`
 * が「そのファイルで必要になった grammar だけ」を `getSingletonHighlighter` (Shiki shorthand と
 * 共有の singleton) に追加ロードし、新規言語のたびに `shikiToMonaco` を呼び直して provider を
 * 再配線する。`shikiToMonaco` は呼ぶたびに `monaco.editor.setTheme` / `create` を wrap する
 * (内部で現在テーマを追跡するための hijack) が、wrap の深さ = セッション中に開いた言語種数で
 * 高々数十、各層は delegate するだけなので許容する。
 */
import { shikiToMonaco } from "@shikijs/monaco";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { getSingletonHighlighter } from "shiki";
import { detectLang, SHIKI_THEME } from "./useHighlight";

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

/**
 * エディタ作成時に指定するテーマ名。`shikiToMonaco` が Shiki テーマを同名で
 * `monaco.editor.defineTheme` するため、Shiki 側テーマ id と常に一致する。
 * `resolveMonacoLanguage` を経由せずにこの名前で create すると defineTheme 前で
 * 例外になるので、エディタ作成前に必ず `resolveMonacoLanguage` を await する契約。
 */
const MONACO_THEME = SHIKI_THEME;

/** `shikiToMonaco` へ配線済みの Shiki 言語。再配線の重複を抑える (重複しても実害はない) */
const wiredShikiLangs = new Set<string>();
/** テーマ定義 (`shikiToMonaco` 初回呼び出し) が済んだか。Shiki 未対応言語しか開いていなくても
 *  `MONACO_THEME` を defineTheme するために 1 度は配線する必要がある */
let themeWired = false;

/**
 * ファイルパスから Monaco で使う言語 ID を解決する。
 *
 * Shiki が言語を持つ場合 (`detectLang`。`@gozd/shiki-lang-map` + override が SSOT) は
 * その grammar を on-demand load して Monaco に配線し、Shiki の言語 id をそのまま Monaco の
 * 言語 id として返す (Monaco 未知の言語は `monaco.languages.register` で新規登録する。
 * `shikiToMonaco` は登録済み言語 id にしか provider を張らないため register が先)。
 * Shiki 未対応の場合は Monaco 組み込みメタデータへ fallback する。
 *
 * 同一言語の並行呼び出しは `shikiToMonaco` が二重に走り得るが、provider / defineTheme とも
 * 上書き登録で冪等なので排他は持たない。
 */
async function resolveMonacoLanguage(filePath: string): Promise<string> {
  const shikiLang = detectLang(filePath);
  const needsWiring = !themeWired || (shikiLang !== undefined && !wiredShikiLangs.has(shikiLang));
  if (!needsWiring) return shikiLang ?? detectMonacoLanguage(filePath);

  const highlighter = await getSingletonHighlighter({
    themes: [SHIKI_THEME],
    langs: shikiLang === undefined ? [] : [shikiLang],
  });
  if (shikiLang !== undefined) {
    if (!monaco.languages.getLanguages().some((lang) => lang.id === shikiLang)) {
      monaco.languages.register({ id: shikiLang });
    }
    wiredShikiLangs.add(shikiLang);
  }
  shikiToMonaco(highlighter, monaco);
  themeWired = true;
  return shikiLang ?? detectMonacoLanguage(filePath);
}

/**
 * gutter (行番号) クリックを検出し、クリック行の gutter 位置に anchor 要素を配置して handler を
 * 呼ぶ。CodePreview の blame 起動が使う。VS Code の folding
 * gutter クリックと同じ mousedown 記録 → mouseup 検証の 2 段方式 (vscode folding.ts の
 * `mouseDownInfo` と同型)。
 *
 * - native click は使えない: Monaco は mousedown で viewLines に setPointerCapture する
 *   (vscode globalPointerMoveMonitor) ため、click は gutter 要素を経由せず委譲では拾えない
 * - mousedown で popover を開いてはいけない: Popover API の light dismiss (popover 外での
 *   pointerup で閉じる) は Chromium では pointer イベントをリスナーへ dispatch する **前** に
 *   走る (pointer_event_manager.cc)。mousedown 中に開くと同じクリックの pointerup の
 *   light dismiss で即閉じされる。mouseup リスナー内で開けば light dismiss は処理済みで安全
 * - anchor に Monaco 内部の DOM は使えない: `IMouseTarget.element` は幾何計算ではなく生の
 *   ブラウザイベント target をそのまま返す (vscode mouseTarget.ts の `HitTestRequest.target`)
 *   ため、pointer capture 中の mouseup では viewLines コンテナが返る。また gutter の行番号 DOM
 *   は再描画・仮想スクロールで detach される。type / position は幾何計算なので信頼できる。
 *   よって呼び出し側が所有する固定要素 (`getAnchorEl`) を、幾何 API (`getTopForLineNumber` /
 *   `getLayoutInfo`) でクリック行の gutter セル位置に重ねて anchor とする (VS Code が内部 DOM を
 *   掴まず幾何 API でウィジェットを配置するのと同じ規律)
 * - 末尾改行直後の空の最終行 (Monaco が描画する phantom 行) は無視する。git は `\n` 終端で
 *   行を数えるためこの行は git 側に存在せず、blame が "file has only N lines" で必ず失敗する。
 *   旧実装 (Shiki HTML) でもこの行は描画されなかった
 *
 * リスナーはエディタに紐づき `editor.dispose()` で解放されるため、明示的な解除は不要。
 */
function wireGutterLineClick(
  editor: monaco.editor.IStandaloneCodeEditor,
  getAnchorEl: () => HTMLElement | undefined,
  isEnabled: () => boolean,
  onClick: (payload: { line: number; anchorEl: HTMLElement }) => void,
): void {
  let mouseDownLine: number | undefined;
  editor.onMouseDown((e) => {
    mouseDownLine = undefined;
    if (!isEnabled()) return;
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return;
    mouseDownLine = e.target.position?.lineNumber;
  });
  editor.onMouseUp((e) => {
    const line = mouseDownLine;
    mouseDownLine = undefined;
    if (line === undefined) return;
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return;
    if (e.target.position?.lineNumber !== line) return;
    const model = editor.getModel();
    if (!model) return;
    if (line === model.getLineCount() && model.getLineLength(line) === 0) return;
    const anchorEl = getAnchorEl();
    if (anchorEl === undefined) return;
    const layout = editor.getLayoutInfo();
    anchorEl.style.top = `${editor.getTopForLineNumber(line) - editor.getScrollTop()}px`;
    anchorEl.style.left = `${layout.lineNumbersLeft}px`;
    anchorEl.style.width = `${layout.lineNumbersWidth}px`;
    anchorEl.style.height = `${editor.getOption(monaco.editor.EditorOption.lineHeight)}px`;
    onClick({ line, anchorEl });
  });
}

export { monaco, MONACO_THEME, resolveMonacoLanguage, wireGutterLineClick };
