/**
 * monaco-editor ESM 内部モジュールの型宣言 (monacoDiffComputer.d.ts と同じ事情)。
 *
 * Monaco (VS Code 由来) は multi-window を window registry で扱い、focus 判定
 * (`getActiveDocument`) は登録済みウィンドウしか走査しない。登録関数 `registerWindow` は
 * standalone 配布の tree-shake で export から落とされている (registry 本体は残存) ため、
 * `patches/monaco-editor.patch` が export を復元しており、この宣言はその patch とセット。
 * 型は VSCode 本体 (`src/vs/base/browser/dom.ts`) から最小 surface を書き写す。
 */
declare module "monaco-editor/esm/vs/base/browser/dom.js" {
  /** vscodeWindowId 焼き込み済みのウィンドウを registry に登録する (登録済みなら no-op)。 */
  export function registerWindow(targetWindow: Window): { dispose(): void };
}
