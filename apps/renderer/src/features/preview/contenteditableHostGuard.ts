/**
 * read-only contenteditable host（CodePreview / DiffPreview / MarkdownPreview）の
 * 編集ブロック契約の SSOT。
 *
 * preview の閲覧モードは Cmd+A の選択スコープを host subtree に閉じ込め、選択コピーの
 * 再現性を保つために contenteditable="true" を使う。編集経路は以下の 2 ハンドラで塞ぐ。
 *
 * テンプレート側の契約: 各 contenteditable host に
 * `@beforeinput="blockEdit" @compositionstart="abortComposition"` に加えて
 * `@dragover.prevent @drop.prevent` を付ける。`beforeinput` だけでも drop の DOM mutation
 * は弾けるが、`dragover` を preventDefault しないと UA がドロップ可能 cursor / drop indicator を
 * 一瞬表示してチラ見せが起きる経路があり、UX 上の保険として両方つける。
 *
 * Cmd+A / Cmd+C は `beforeinput` を発火させない (input ではない)。コピーは UA 既定が動き、
 * Cmd+A はスコープが contenteditable subtree に閉じる。これらに別途 handler は不要。
 */

/**
 * `beforeinput` で `event.preventDefault()` し、typing / paste / undo-redo / drop の
 * DOM mutation を 1 経路で止める (input 系全部の上位 hook)。
 *
 * 例外は IME: composition 由来の `beforeinput` (`insertCompositionText`) は Input Events
 * 仕様で cancelable: false のため preventDefault が no-op になり、変換中テキストが DOM に
 * 挿入されてしまう。IME 経路は `abortComposition` 側で塞ぐ。
 */
export function blockEdit(event: Event) {
  event.preventDefault();
}

/**
 * IME composition を入口で中断する (`blockEdit` の IME 例外の受け皿)。composition 開始と
 * 同時に host を non-editable にすると Chromium が composition を abort し、cancelable: false
 * の `insertCompositionText` が DOM に到達しない。次フレームで editable に戻して
 * Cmd+A スコープ / 選択コピーの契約を維持する (template の contenteditable は静的属性で
 * Vue は再描画時に復元しないため、自前で戻す)。
 */
export function abortComposition(event: CompositionEvent) {
  const host = event.currentTarget;
  if (!(host instanceof HTMLElement)) return;
  host.contentEditable = "false";
  requestAnimationFrame(() => {
    host.contentEditable = "true";
  });
}
