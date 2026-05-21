/**
 * Popover API (`popover="auto"`) を anchor 指定で開閉する共通 composable。
 *
 * 利用側は `Popover` コンポーネントを slot 付きで template に置き、`open(anchorEl, context)` を
 * 呼ぶだけでよい。`anchorEl` の直下に popover を開き、`context` を `context` (computed) 経由で
 * template に渡せる。`@toggle` event の close 経路と「自前 hide → show」の中間 hide / 別 anchor
 * への切り替え race を内部で吸収するため、利用側は ref / popover 属性 / onToggle を直接触らない。
 *
 * 設計詳細:
 *   - `openState` (anchorEl + context) を ref で保持し、watch で `showPopover({ source })` を発火
 *   - 既に open 中に open() を呼ばれたら、自前 hidePopover → showPopover で anchor を付け替え
 *     ・中間 toggle "closed" は `suppressNextCloseEmit` で skip
 *   - UA light-dismiss (popover 外 click) で popover が閉じた直後に別 anchor の open() が来る
 *     場合、queue 済みの "closed" toggle が後から発火するため、`:popover-open` で再 open 済み
 *     なら誤発火とみなして openState を残す
 *   - 利用側は `Popover` のスロット内に menu 内容を書き、`context` を v-if で参照する
 */
import {
  computed,
  defineComponent,
  h,
  nextTick,
  ref,
  watch,
  type Component,
  type ComputedRef,
} from "vue";

/**
 * Popover API の `showPopover({ source })` 引数。lib.dom.d.ts に未取り込みなので最小宣言を持つ。
 */
type ShowPopoverOptions = { source?: HTMLElement };
type PopoverElement = HTMLElement & { showPopover(options?: ShowPopoverOptions): void };

interface PopoverOpenState<T> {
  anchorEl: HTMLElement;
  context: T;
}

interface UsePopoverResult<T> {
  /** template に置く popover root component。slot 内に menu 内容を書く */
  PopoverRoot: Component;
  /** 現在 open 中の context。閉じていれば undefined */
  context: ComputedRef<T | undefined>;
  /** anchorEl の直下に popover を開き、context を template に渡す */
  open: (anchorEl: HTMLElement, context: T) => void;
  /** popover を閉じる。@toggle 経由で openState も clear される */
  close: () => void;
}

export function usePopover<T>(): UsePopoverResult<T> {
  const popoverRef = ref<PopoverElement>();
  const openState = ref<PopoverOpenState<T>>();
  const context = computed<T | undefined>(() => openState.value?.context);

  // 自前 hide → show 切り替えの中間 hide が emit する @toggle "closed" を skip するフラグ。
  // light-dismiss → 別 anchor open の race は `:popover-open` 判定で別途扱う。
  let suppressNextCloseEmit = false;

  function open(anchorEl: HTMLElement, value: T): void {
    openState.value = { anchorEl, context: value };
  }

  function close(): void {
    popoverRef.value?.hidePopover();
  }

  watch(openState, async (state) => {
    if (!state) return;
    await nextTick();
    const el = popoverRef.value;
    if (!el) return;
    if (el.matches(":popover-open")) {
      suppressNextCloseEmit = true;
      el.hidePopover();
    }
    el.showPopover({ source: state.anchorEl });
  });

  function onToggle(event: Event): void {
    if (!(event instanceof ToggleEvent)) return;
    if (event.newState !== "closed") return;
    if (suppressNextCloseEmit) {
      suppressNextCloseEmit = false;
      return;
    }
    // light-dismiss と同 tick で次の open() が走ったケース。toggle event は task-queued なので
    // この時点で popover が再 open されていれば close emit は誤発火とみなして openState を残す。
    if (popoverRef.value?.matches(":popover-open")) return;
    openState.value = undefined;
  }

  const PopoverRoot = defineComponent({
    name: "PopoverRoot",
    inheritAttrs: false,
    setup(_, { slots, attrs }) {
      return () =>
        h(
          "div",
          {
            ...attrs,
            ref: popoverRef,
            popover: "auto",
            onToggle,
          },
          slots.default?.(),
        );
    },
  });

  return { PopoverRoot, context, open, close };
}
