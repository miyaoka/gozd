/**
 * プレビューのフォント設定。
 * リアクティブ ref で管理し、設定モーダルからの変更を即座に反映する。
 * 空文字 / 0 は未設定（ブラウザデフォルトに委ねる）。
 */

import { ref } from "vue";

export const previewFontFamily = ref("");
export const previewFontSize = ref(0);
/** コード (code preview / diff / markdown コードブロック) 用。空文字列なら monospace スタックに fallback */
export const previewCodeFontFamily = ref("");
