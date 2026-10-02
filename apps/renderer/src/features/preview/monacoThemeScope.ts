/**
 * `monaco.editor.create` に渡すコンテナ要素に付けるクラス。
 *
 * standalone の Monaco はテーマの CSS 変数 (`--vscode-*`) を `.monaco-editor` /
 * `.monaco-diff-editor` / `.monaco-component` にだけ定義する。`fixedOverflowWidgets` が有効だと
 * 右クリックメニューは create 先コンテナ直下の shadow root に描かれ、`.monaco-editor` の外に出る。
 * shadow root の中へは document 側の規則が当たらず CSS 変数の継承だけが届くため、コンテナ自身を
 * 変数の定義範囲に入れないとメニューの背景色などが解決されず透明になる。diff editor は内側の
 * エディタのコンテナが `.monaco-diff-editor` の中にあるため要らない。
 *
 * Monaco 本体の chunk を引き込まずに静的 import できるよう、monacoSetup とは別モジュールに置く。
 */
export const MONACO_THEME_SCOPE_CLASS = "monaco-component";
