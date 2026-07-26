import { onBeforeUnmount, watch, type ShallowRef } from "vue";
import {
  hideSurface,
  raiseSurface,
  registerSurfaceClose,
  showSurface,
  unregisterSurfaceClose,
} from "./topLayerSurface";

interface SurfaceOptions {
  /** 開閉の SSOT (store 側)。DOM への反映は本 composable が担う。 */
  isOpen: () => boolean;
  /** 閉じたい要求。実際に閉じるかは呼び出し先の判断 (未保存 draft の確認等)。 */
  requestClose: () => void;
  /**
   * 「既に開いているが前面化したい」の signal (単調増加)。値が変わるたびに raise する。
   * 開き直しではない前面化要求 (preview の reveal / summary 進入) を持つサーフェスだけ渡す。
   */
  raiseSignal?: () => number;
}

/**
 * サーフェスの root 要素を top layer の列へ載せ、開閉ミラー・click-to-front・close の宛先登録を
 * まとめて配線する。
 *
 * サーフェスを名乗る要素はすべてこれを通す。配線を各コンポーネントに書かせると、新しいサーフェスを
 * 足したときに一部だけ忘れられる — 前面化を忘れればそのパネルだけクリックで手前に来ず、close を
 * 忘れれば ESC / Cmd+W の宛先が消え、列からの離脱を忘れれば閉じた面が前面順に残る。
 *
 * 開閉の SSOT は呼び出し側の `isOpen` で、DOM 側の `:popover-open` は `showPopover()` の前提
 * (開いている popover への再 show は例外) を満たすためだけに見る。要素も watch source に含めるのは、
 * 開いた状態で再 mount される経路 (HMR) を拾うため。
 *
 * 返る `raise` は root の `@pointerdown.capture` に繋ぐ。キャプチャフェーズなのは、内側の要素
 * (ResizeHandle 等) が pointer capture を取る前に積み直しを終わらせるため
 * (`raiseSurface` の docstring)。
 */
export function useSurface(
  elRef: Readonly<ShallowRef<HTMLElement | null>>,
  options: SurfaceOptions,
) {
  watch(elRef, (el) => {
    if (el !== null) registerSurfaceClose(el, options.requestClose);
  });

  watch(
    [elRef, options.isOpen, options.raiseSignal ?? (() => 0)],
    ([el, open]) => {
      if (el === null) return;
      const shown = el.matches(":popover-open");
      if (!open) {
        if (shown) hideSurface(el);
        return;
      }
      if (shown) raiseSurface(el);
      else showSurface(el);
    },
    { flush: "sync" },
  );

  // element がまだ生きている beforeUnmount で外す (unmount は beforeUnmount → effect scope
  // 停止 → subtree unmount の順で、watch も onUnmounted も element を掴めない)
  onBeforeUnmount(() => {
    const el = elRef.value;
    if (el === null) return;
    unregisterSurfaceClose(el);
    if (el.matches(":popover-open")) hideSurface(el);
  });

  function raise(): void {
    const el = elRef.value;
    if (el === null) return;
    raiseSurface(el);
  }
  return { raise };
}
