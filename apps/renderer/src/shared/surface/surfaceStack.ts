/**
 * サーフェスの前面順 (末尾が最前面) を扱う純粋モデル。
 *
 * top layer の順序は DOM 側が SSOT だが、「どれが前面か」「閉じたら次はどれにフォーカスを移すか」
 * の判断そのものは DOM に触れずに決まる。`topLayerSurface` から切り出しているのは、この判断を
 * DOM 無しで固定するため — フォーカス追従が切れると、見えている前面と閉じる対象が食い違ったまま
 * 静かに壊れる。
 *
 * 要素の同一性は参照で見る (`===`)。
 */

/** item が最前面か。前面化を no-op に倒す判定に使う。 */
export function isFront<T>(stack: readonly T[], item: T): boolean {
  return stack.at(-1) === item;
}

/** 最前面。空なら undefined。 */
export function front<T>(stack: readonly T[]): T | undefined {
  return stack.at(-1);
}

/** item を最前面へ移す。既に含まれていれば取り除いてから積み直す (重複を作らない)。 */
export function withFront<T>(stack: readonly T[], item: T): T[] {
  return [...stack.filter((s) => s !== item), item];
}

/** item を取り除く。含まれていなければそのまま。 */
export function without<T>(stack: readonly T[], item: T): T[] {
  return stack.filter((s) => s !== item);
}
