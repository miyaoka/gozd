/**
 * monaco-editor ESM 内部モジュールの型宣言 (monacoDiffComputer.d.ts と同じ事情)。
 *
 * Monaco (VS Code 由来) は multi-window を window registry で扱い、focus 判定
 * (`getActiveDocument`) は登録済みウィンドウしか走査しない。登録関数 `registerWindow` は
 * standalone 配布の tree-shake で export から落とされている (registry 本体は残存) ため、
 * `patches/monaco-editor.patch` が export を復元しており、この宣言はその patch とセット。
 * monaco の version 更新は patch の再生成を伴う (`dom.js` の分割代入と export リストへ
 * `registerWindow` を戻す 2 箇所)。型は VSCode 本体 (`src/vs/base/browser/dom.ts` /
 * `window.ts`) から最小 surface を書き写す。
 *
 * `registerWindow` は registry のキーに `vscodeWindowId` を使い、未焼き込みのウィンドウを
 * 渡しても throw せず key `undefined` で登録する (同一キーの 2 つ目は「登録済み」と誤判定され
 * silent に無視される)。引数型を `CodeWindow` に狭め、`ensureCodeWindow` を通っていない
 * ウィンドウを型検査で弾く。
 */
declare module "monaco-editor/base/browser/window.js" {
  /** `vscodeWindowId` 焼き込み済みのウィンドウ。registry のキーを持つことを型で表す。 */
  export type CodeWindow = Window & { readonly vscodeWindowId: number };

  /**
   * `targetWindow` に registry のキー `vscodeWindowId` を焼き込む (既に持つなら no-op)。
   * 焼き込み済みであることを呼び出し側へ伝播させるため assertion signature で宣言する。
   */
  export function ensureCodeWindow(
    targetWindow: Window,
    fallbackWindowId: number,
  ): asserts targetWindow is CodeWindow;
}

declare module "monaco-editor/base/browser/dom.js" {
  import type { CodeWindow } from "monaco-editor/base/browser/window.js";

  /** ウィンドウを registry に登録する (登録済み id なら no-op で `Disposable.None` を返す)。 */
  export function registerWindow(targetWindow: CodeWindow): { dispose(): void };
}
