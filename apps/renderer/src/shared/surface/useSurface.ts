import { onBeforeUnmount, watch, type ShallowRef } from "vue";
import { raiseSurface, registerSurfaceClose, unregisterSurfaceClose } from "./topLayerSurface";

/**
 * サーフェスの root 要素を登録し、click-to-front を配線する。
 *
 * サーフェスを名乗る要素はすべてこれを通す。前面化の配線と close の宛先登録を 1 つの呼び出しに
 * 束ねることで、新しいサーフェスを足したときに片方だけ忘れる経路を消す (前面化を忘れれば
 * そのパネルだけクリックで手前に来ず、close を忘れれば ESC / Cmd+W の宛先が消える)。
 *
 * `requestClose` は「閉じたい要求」で、実際に閉じるかは呼び出し先の判断 (preview の未保存
 * draft 確認など)。
 *
 * 返る `raise` は root の `@pointerdown.capture` に繋ぐ。キャプチャフェーズなのは、内側の要素
 * (ResizeHandle 等) が pointer capture を取る前に積み直しを終わらせるため
 * (`raiseSurface` の docstring)。
 */
export function useSurface(
  elRef: Readonly<ShallowRef<HTMLElement | null>>,
  requestClose: () => void,
) {
  watch(elRef, (el) => {
    if (el !== null) registerSurfaceClose(el, requestClose);
  });
  // element がまだ生きている beforeUnmount で外す (unmount は beforeUnmount → effect scope
  // 停止 → subtree unmount の順で、watch も onUnmounted も element を掴めない)
  onBeforeUnmount(() => {
    const el = elRef.value;
    if (el !== null) unregisterSurfaceClose(el);
  });

  function raise(): void {
    const el = elRef.value;
    if (el === null) return;
    raiseSurface(el);
  }
  return { raise };
}
