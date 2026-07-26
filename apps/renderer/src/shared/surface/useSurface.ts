import type { ShallowRef } from "vue";
import { raiseSurface } from "./topLayerSurface";

/**
 * サーフェスの root 要素に click-to-front を配線する。
 *
 * 返る `raise` は root の `@pointerdown.capture` に繋ぐ。これが `raiseSurface` の呼び出し条件
 * (docstring) を満たすクリック経路の実装で、キャプチャフェーズなのは内側の要素 (ResizeHandle 等)
 * が pointer capture を取る前に積み直しを終わらせるため。フォーカスの行き先は pointerdown の
 * 既定動作が同じサーフェス内へ戻すので、この経路では追加の手当てが要らない (root が
 * `tabindex="-1"` を持つことに依存する)。
 *
 * サーフェスを名乗る要素はすべてこれを通す。null チェックとフェーズの選択を各コンポーネントに
 * 書かせると、新しいサーフェスを足したときに配線ごと忘れられ、そのパネルだけ前面化できない
 * 状態が静かに生まれる。
 */
export function useSurface(elRef: Readonly<ShallowRef<HTMLElement | null>>) {
  function raise(): void {
    const el = elRef.value;
    if (el === null) return;
    raiseSurface(el);
  }
  return { raise };
}
