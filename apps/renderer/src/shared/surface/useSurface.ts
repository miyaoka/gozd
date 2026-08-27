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
 * 開閉の SSOT は呼び出し側の `isOpen` で、DOM 側の `:popover-open` を見るのは開閉ミラーだけ。
 * 開く側では show と raise の振り分けに要る — 開いている popover への `showPopover()` は no-op で
 * top layer の順序を動かさないため、show では前面化を表現できない。閉じる側は、mount 直後にも
 * `isOpen` が false でミラーが走るため、開いていたものだけを閉じる形にしてある。要素も watch
 * source に含めるのは、開いた状態で再 mount される経路 (HMR) を拾うため。
 *
 * 前面順の控えからの離脱はこの述語に条件づけない (`onBeforeUnmount`)。ブラウザが背後で popover を
 * 閉じる経路があり、そこでは述語が控えの実態と食い違う。
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
  // 停止 → subtree unmount の順で、watch も onUnmounted も element を掴めない)。
  //
  // 前面順の控えからの離脱は DOM の状態で条件づけない。要素が親ごと先に DOM から外れる経路では
  // その時点で popover が閉じているため、開いているかで gate すると close ハンドラの解除だけが
  // 成立して離脱が漏れ、detached な要素が控えに残る。残ると `showSurface` の「1 枚も開いて
  // いないとき」が成立せず、開く前のフォーカス元を控えなくなる。閉じている popover への
  // `hidePopover()` は何も起こさないので、常に通してよい。
  onBeforeUnmount(() => {
    const el = elRef.value;
    if (el === null) return;
    unregisterSurfaceClose(el);
    hideSurface(el);
  });

  function raise(): void {
    const el = elRef.value;
    if (el === null) return;
    raiseSurface(el);
  }
  return { raise };
}
